/**
 * WebRTC transport with manual (QR/paste) signalling (spec §8.2). No server:
 * the host produces an offer bundle, the follower an answer bundle, exchanged
 * out-of-band. Designed for a local link (e.g. one phone's hotspot).
 *
 * NOTE: requires real peers + camera/clipboard on two devices; it cannot be
 * exercised in the build sandbox. The signalling codec and the sync protocol
 * it drives are unit-tested separately (sdp-codec, netgame).
 */
import { decodeSignal, encodeSignal } from "./sdp-codec";
import type { NetMsg, Role, Transport } from "./transport";

const RTC_CONFIG: RTCConfiguration = {
  // Local-link play; a public STUN helps when on the same network behind NAT.
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function rtcAvailable(): boolean {
  return typeof RTCPeerConnection !== "undefined";
}

/** Resolve once ICE gathering completes (or a timeout, to bound QR latency). */
function gatherComplete(pc: RTCPeerConnection, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(resolve, timeoutMs);
  });
}

export class WebRtcTransport implements Transport {
  readonly role: Role;
  status: Transport["status"] = "connecting";
  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private cbs = new Set<(m: NetMsg) => void>();
  private openCbs = new Set<() => void>();

  constructor(role: Role) {
    if (!rtcAvailable()) throw new Error("WebRTC is not available in this environment");
    this.role = role;
    this.pc = new RTCPeerConnection(RTC_CONFIG);
  }

  /** Host: create the data channel + offer bundle to share. */
  async createOffer(): Promise<string> {
    this.channel = this.pc.createDataChannel("game", { ordered: true });
    this.wireChannel(this.channel);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gatherComplete(this.pc);
    return encodeSignal(this.pc.localDescription);
  }

  /** Host: consume the follower's answer bundle. */
  async acceptAnswer(code: string): Promise<void> {
    await this.pc.setRemoteDescription(decodeSignal(code) as RTCSessionDescriptionInit);
  }

  /** Follower: consume the host's offer and produce an answer bundle. */
  async acceptOffer(code: string): Promise<string> {
    this.pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this.wireChannel(this.channel);
    };
    await this.pc.setRemoteDescription(decodeSignal(code) as RTCSessionDescriptionInit);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gatherComplete(this.pc);
    return encodeSignal(this.pc.localDescription);
  }

  private wireChannel(ch: RTCDataChannel): void {
    ch.onopen = () => {
      this.status = "connected";
      this.openCbs.forEach((cb) => cb());
    };
    ch.onclose = () => {
      this.status = "closed";
    };
    ch.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as NetMsg;
        this.cbs.forEach((cb) => cb(msg));
      } catch {
        /* ignore malformed frames */
      }
    };
  }

  onOpen(cb: () => void): () => void {
    this.openCbs.add(cb);
    if (this.status === "connected") cb();
    return () => this.openCbs.delete(cb);
  }

  send(msg: NetMsg): void {
    if (this.channel && this.channel.readyState === "open") this.channel.send(JSON.stringify(msg));
  }

  onReceive(cb: (m: NetMsg) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  close(): void {
    this.channel?.close();
    this.pc.close();
    this.status = "closed";
  }
}
