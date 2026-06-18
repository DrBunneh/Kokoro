/**
 * Transport abstraction (spec §8.1). Hot-seat, WebRTC PvP, and replay playback
 * all drive the same engine through this interface — nothing else in the app
 * knows the transport type.
 */
import type { Action } from "@/engine/actions";
import type { Frame, LogEntry } from "@/engine/replay";

export type Role = "host" | "follower";
export type ConnStatus = "connecting" | "connected" | "closed";

/** Wire messages exchanged between peers (spec §8.3). */
export type NetMsg =
  | { t: "HELLO"; name: string; deckHash: string; deck: string[]; seed?: string; firstPlayer?: 1 | 2 }
  | { t: "ACTION"; action: Action }
  | { t: "FRAMES"; frames: Frame[]; logs: LogEntry[] }
  | { t: "UNDO_REQUEST" }
  | { t: "UNDO_CONFIRM" }
  | { t: "PING" };

export interface Transport {
  send(msg: NetMsg): void;
  /** Subscribe to inbound messages; returns an unsubscribe fn. */
  onReceive(cb: (msg: NetMsg) => void): () => void;
  readonly role: Role;
  readonly status: ConnStatus;
  close(): void;
}
