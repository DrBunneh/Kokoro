/**
 * LAN local-play transport (spec §8, revised). Replaces manual QR signalling
 * with zero-config discovery on the shared network (WiFi or BT-tethered
 * hotspot):
 *
 *  - The host runs a native WebSocket server (NanoHTTPD) and advertises it via
 *    Android NSD. Its messages bridge through the `LocalNet` Capacitor plugin.
 *  - The follower browses NSD for hosts, then connects with a plain JS
 *    `WebSocket` (no native client needed) and talks straight to the server.
 *
 * Both expose the shared `Transport`, so the host-authoritative `NetGame`
 * (unit-tested over the loopback pair) is identical here.
 *
 * The native half can't run in the build sandbox — verified on-device.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NetMsg, Transport } from "./transport";
import { nlog } from "./netlog";

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
}

export interface LocalNetPlugin {
  /** Start the host WebSocket server + NSD advertisement. */
  startHost(opts: { name: string }): Promise<{ port: number; name: string; addresses?: string[] }>;
  stopHost(): Promise<void>;
  /** Broadcast a string to the connected follower. */
  send(opts: { data: string }): Promise<void>;
  /** Begin browsing for hosts (emits `peerFound` / `peerLost`). */
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  addListener(event: "message", cb: (d: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "peerConnected", cb: () => void): Promise<PluginListenerHandle>;
  addListener(event: "peerDisconnected", cb: () => void): Promise<PluginListenerHandle>;
  addListener(event: "peerFound", cb: (p: DiscoveredPeer) => void): Promise<PluginListenerHandle>;
  addListener(event: "peerLost", cb: (p: { name: string }) => void): Promise<PluginListenerHandle>;
  /** Native-side diagnostics (NSD register/discovery, WS server). Newer APKs only. */
  addListener(event: "log", cb: (d: { level?: string; msg: string }) => void): Promise<PluginListenerHandle>;
}

export const LocalNet = registerPlugin<LocalNetPlugin>("LocalNet");

export function localPlaySupported(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Bridge native diagnostics into the shared net log. No-op on web / older APKs
 * that don't emit `log` events. Returns an unsubscribe fn.
 */
export async function subscribeNativeLog(): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const h = await LocalNet.addListener("log", ({ level, msg }) => {
      nlog("native", msg, level === "error" ? "error" : level === "warn" ? "warn" : "info");
    });
    return () => void h.remove();
  } catch {
    return () => {};
  }
}

/** Host side: bridges the native WebSocket server through the LocalNet plugin. */
export class HostTransport implements Transport {
  readonly role = "host" as const;
  status: Transport["status"] = "connecting";
  private cbs = new Set<(m: NetMsg) => void>();
  private openCbs = new Set<() => void>();
  private handles: PluginListenerHandle[] = [];

  async start(name: string): Promise<{ port: number; addresses?: string[] }> {
    nlog("host", `starting host as "${name}"…`);
    this.handles.push(
      await LocalNet.addListener("message", ({ data }) => {
        try {
          const m = JSON.parse(data) as NetMsg;
          nlog("host", `recv ${m.t} (${data.length} bytes)`);
          this.cbs.forEach((cb) => cb(m));
        } catch {
          nlog("host", `recv malformed message (${data.length} bytes)`, "warn");
        }
      }),
      await LocalNet.addListener("peerConnected", () => {
        nlog("host", "follower WebSocket connected");
        this.status = "connected";
        this.openCbs.forEach((cb) => cb());
      }),
      await LocalNet.addListener("peerDisconnected", () => {
        nlog("host", "follower WebSocket disconnected", "warn");
        this.status = "closed";
      }),
    );
    try {
      const info = await LocalNet.startHost({ name });
      nlog("host", `server listening on port ${info.port}; addresses: ${(info.addresses ?? []).join(", ") || "(none found)"}`);
      return info;
    } catch (e) {
      nlog("host", `startHost failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      throw e;
    }
  }

  onOpen(cb: () => void): () => void {
    this.openCbs.add(cb);
    if (this.status === "connected") cb();
    return () => this.openCbs.delete(cb);
  }
  send(msg: NetMsg): void {
    nlog("host", `send ${msg.t}`);
    void LocalNet.send({ data: JSON.stringify(msg) });
  }
  onReceive(cb: (m: NetMsg) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  close(): void {
    this.handles.forEach((h) => void h.remove());
    this.handles = [];
    void LocalNet.stopHost();
    this.status = "closed";
  }
}

/** Follower side: a plain JS WebSocket to the discovered host. */
export class WsClientTransport implements Transport {
  readonly role = "follower" as const;
  status: Transport["status"] = "connecting";
  private ws: WebSocket;
  private cbs = new Set<(m: NetMsg) => void>();
  private openCbs = new Set<() => void>();

  readonly url: string;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(peer: DiscoveredPeer) {
    // Bracket IPv6 (strip any %scope, which ws:// can't use) so the URL is valid.
    const h = peer.host.includes(":") ? `[${peer.host.replace(/%.*$/, "")}]` : peer.host;
    this.url = `ws://${h}:${peer.port}`;
    nlog("follower", `opening WebSocket to ${this.url}…`);
    this.ws = new WebSocket(this.url);
    // While still CONNECTING, log a heartbeat so a silent stall (host
    // unreachable / hotspot client-isolation) is visibly different from a quick
    // mixed-content/refused error.
    let beats = 0;
    this.heartbeat = setInterval(() => {
      if (this.ws.readyState === WebSocket.CONNECTING) {
        beats += 1;
        nlog("follower", `still connecting after ${beats * 3}s (no response from host yet)`, "warn");
      } else if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    }, 3000);
    this.ws.onopen = () => {
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
      nlog("follower", `WebSocket open to ${this.url}`);
      this.status = "connected";
      this.openCbs.forEach((cb) => cb());
    };
    this.ws.onclose = (e) => {
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
      // The close code/reason is the key clue for "stuck at connecting".
      const before = this.status;
      nlog(
        "follower",
        `WebSocket closed (code ${e.code}${e.reason ? `, "${e.reason}"` : ""}, ${e.wasClean ? "clean" : "unclean"})${before === "connecting" ? " — never opened, host unreachable or refused" : ""}`,
        before === "connected" ? "warn" : "error",
      );
      this.status = "closed";
    };
    this.ws.onerror = () => {
      nlog("follower", `WebSocket error connecting to ${this.url} (mixed-content block, wrong IP/port, or different network)`, "error");
    };
    this.ws.onmessage = (e) => {
      const data = e.data as string;
      try {
        const m = JSON.parse(data) as NetMsg;
        nlog("follower", `recv ${m.t} (${data.length} bytes)`);
        this.cbs.forEach((cb) => cb(m));
      } catch {
        nlog("follower", `recv malformed message (${data.length} bytes)`, "warn");
      }
    };
  }

  onOpen(cb: () => void): () => void {
    this.openCbs.add(cb);
    if (this.status === "connected") cb();
    return () => this.openCbs.delete(cb);
  }
  send(msg: NetMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      nlog("follower", `send ${msg.t}`);
      this.ws.send(JSON.stringify(msg));
    } else {
      nlog("follower", `cannot send ${msg.t} — socket not open (state ${this.ws.readyState})`, "warn");
    }
  }
  onReceive(cb: (m: NetMsg) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  close(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    this.ws.close();
    this.status = "closed";
  }
}
