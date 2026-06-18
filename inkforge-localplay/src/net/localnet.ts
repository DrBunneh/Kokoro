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
  /** All candidate host addresses (multi-homed hosts); tried in order. */
  addresses?: string[];
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

const bracketHost = (h: string): string => (h.includes(":") ? `[${h.replace(/%.*$/, "")}]` : h);

/**
 * Follower side: a plain JS WebSocket to the host. A multi-homed host advertises
 * several addresses (hotspot vs. VPN/cellular); we try each in turn with a short
 * per-address timeout, so we don't get stuck dialing an unreachable interface.
 */
export class WsClientTransport implements Transport {
  readonly role = "follower" as const;
  status: Transport["status"] = "connecting";
  private ws: WebSocket | null = null;
  private cbs = new Set<(m: NetMsg) => void>();
  private openCbs = new Set<() => void>();
  private candidates: string[];
  private perAddrTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  readonly url: string;

  constructor(peer: DiscoveredPeer) {
    const hosts = [peer.host, ...(peer.addresses ?? [])].filter(Boolean);
    // De-dupe while preserving order; build ws URLs (IPv6 bracketed).
    this.candidates = [...new Set(hosts)].map((h) => `ws://${bracketHost(h)}:${peer.port}`);
    this.url = this.candidates[0] ?? `ws://${bracketHost(peer.host)}:${peer.port}`;
    if (this.candidates.length > 1) nlog("follower", `host has ${this.candidates.length} addresses; will try each in turn`);
    this.tryNext(0);
  }

  private tryNext(i: number): void {
    if (this.closed) return;
    if (i >= this.candidates.length) {
      nlog("follower", `couldn't reach the host on any of its ${this.candidates.length} address(es)`, "error");
      this.status = "closed";
      return;
    }
    const url = this.candidates[i]!;
    nlog("follower", `opening WebSocket to ${url} (${i + 1}/${this.candidates.length})…`);
    let settled = false;
    const ws = new WebSocket(url);
    this.ws = ws;
    const advance = (why: string, level: "warn" | "error" = "warn") => {
      if (settled) return;
      settled = true;
      clearTimeout(this.perAddrTimer);
      nlog("follower", `${url}: ${why}`, level);
      try { ws.close(); } catch { /* ignore */ }
      this.tryNext(i + 1);
    };
    // ~4s per address before moving on to the next interface.
    this.perAddrTimer = setTimeout(() => advance("no response in 4s, trying next address"), 4000);
    ws.onopen = () => {
      if (settled || this.closed) { try { ws.close(); } catch { /* ignore */ } return; }
      settled = true;
      clearTimeout(this.perAddrTimer);
      nlog("follower", `WebSocket open to ${url}`);
      this.status = "connected";
      this.openCbs.forEach((cb) => cb());
    };
    ws.onclose = (e) => {
      if (this.status === "connected" && this.ws === ws) {
        nlog("follower", `WebSocket closed (code ${e.code}${e.reason ? `, "${e.reason}"` : ""}, ${e.wasClean ? "clean" : "unclean"})`, "warn");
        this.status = "closed";
        return;
      }
      advance(`closed before opening (code ${e.code}${e.wasClean ? "" : ", unclean"})`);
    };
    ws.onerror = () => {
      // onerror is immediately followed by onclose; just note it.
      if (!settled) nlog("follower", `${url}: connection error (unreachable, refused, or mixed-content block)`, "warn");
    };
    ws.onmessage = (e) => {
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      nlog("follower", `send ${msg.t}`);
      this.ws.send(JSON.stringify(msg));
    } else {
      nlog("follower", `cannot send ${msg.t} — socket not open`, "warn");
    }
  }
  onReceive(cb: (m: NetMsg) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.perAddrTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.status = "closed";
  }
}
