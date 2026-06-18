/**
 * Host-authoritative networked game (spec §8.3). Both peers run the identical
 * engine from the same baseSnapshot. The host owns truth: it applies actions
 * and broadcasts the resulting frames; the follower sends its actions to the
 * host and applies the frames it receives verbatim, so the two states never
 * diverge. Transport-agnostic — works over the loopback pair or WebRTC.
 */
import { GameSession } from "@/engine/session";
import type { Action } from "@/engine/actions";
import type { GameState } from "@/engine/state";
import type { NetMsg, Role, Transport } from "./transport";

export class NetGame {
  readonly role: Role;
  readonly session: GameSession;
  private transport: Transport;
  private unsub: () => void;
  private onChange?: () => void;

  constructor(transport: Transport, role: Role, baseSnapshot: GameState, onChange?: () => void) {
    this.transport = transport;
    this.role = role;
    this.session = new GameSession(baseSnapshot);
    this.onChange = onChange;
    this.unsub = transport.onReceive((m) => this.handle(m));
  }

  get state(): GameState {
    return this.session.state;
  }

  /** A local player's action. Host applies+broadcasts; follower forwards to host. */
  localAction(action: Action): void {
    if (this.role === "host") this.applyAndBroadcast(action);
    else this.transport.send({ t: "ACTION", action });
  }

  private applyAndBroadcast(action: Action): void {
    const frameBefore = this.session.frames.length;
    const logBefore = this.session.logs.length;
    this.session.dispatch(action); // throws on illegal — caller handles
    const frames = this.session.frames.slice(frameBefore);
    const logs = this.session.logs.slice(logBefore);
    this.transport.send({ t: "FRAMES", frames, logs });
    this.onChange?.();
  }

  private handle(msg: NetMsg): void {
    if (msg.t === "ACTION" && this.role === "host") {
      try {
        this.applyAndBroadcast(msg.action);
      } catch {
        /* illegal follower action — ignored by the authority */
      }
    } else if (msg.t === "FRAMES" && this.role === "follower") {
      this.session.applyExternalFrames(msg.frames, msg.logs);
      this.onChange?.();
    }
  }

  dispose(): void {
    this.unsub();
  }
}
