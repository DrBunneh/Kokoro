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
}

export const LocalNet = registerPlugin<LocalNetPlugin>("LocalNet");

export function localPlaySupported(): boolean {
  return Capacitor.isNativePlatform();
}

/** Host side: bridges the native WebSocket server through the LocalNet plugin. */
export class HostTransport implements Transport {
  readonly role = "host" as const;
  status: Transport["status"] = "connecting";
  private cbs = new Set<(m: NetMsg) => void>();
  private openCbs = new Set<() => void>();
  private handles: PluginListenerHandle[] = [];

  async start(name: string): Promise<{ port: number; addresses?: string[] }> {
    this.handles.push(
      await LocalNet.addListener("message", ({ data }) => {
        try {
          const m = JSON.parse(data) as NetMsg;
          this.cbs.forEach((cb) => cb(m));
        } catch {
          /* ignore malformed */
        }
      }),
      await LocalNet.addListener("peerConnected", () => {
        this.status = "connected";
        this.openCbs.forEach((cb) => cb());
      }),
      await LocalNet.addListener("peerDisconnected", () => {
        this.status = "closed";
      }),
    );
    return LocalNet.startHost({ name });
  }

  onOpen(cb: () => void): () => void {
    this.openCbs.add(cb);
    if (this.status === "connected") cb();
    return () => this.openCbs.delete(cb);
  }
  send(msg: NetMsg): void {
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

  constructor(peer: DiscoveredPeer) {
    // Bracket IPv6 (strip any %scope, which ws:// can't use) so the URL is valid.
    const h = peer.host.includes(":") ? `[${peer.host.replace(/%.*$/, "")}]` : peer.host;
    this.ws = new WebSocket(`ws://${h}:${peer.port}`);
    this.ws.onopen = () => {
      this.status = "connected";
      this.openCbs.forEach((cb) => cb());
    };
    this.ws.onclose = () => {
      this.status = "closed";
    };
    this.ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as NetMsg;
        this.cbs.forEach((cb) => cb(m));
      } catch {
        /* ignore */
      }
    };
  }

  onOpen(cb: () => void): () => void {
    this.openCbs.add(cb);
    if (this.status === "connected") cb();
    return () => this.openCbs.delete(cb);
  }
  send(msg: NetMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  onReceive(cb: (m: NetMsg) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  close(): void {
    this.ws.close();
    this.status = "closed";
  }
}
