/**
 * Recording game session (spec §4.1, §4.5). Wraps the pure reducer with an
 * ordered frame log so the whole game is an event sourced: `baseSnapshot +
 * frames + logs`. Drives hot-seat now and PvP/replays later.
 *
 * Take-back (undo) re-folds all but the last frame; redo re-applies a frame
 * while no new action has intervened. Still pure of React/DOM.
 */
import type { GameState } from "./state";
import { applyAction, type Action } from "./actions";
import { foldFrames, type Frame, type LogEntry, type Replay } from "./replay";

interface RedoEntry {
  frame: Frame;
  logs: LogEntry[];
}

export class GameSession {
  readonly baseSnapshot: GameState;
  state: GameState;
  frames: Frame[] = [];
  logs: LogEntry[] = [];
  private redoStack: RedoEntry[] = [];

  constructor(initial: GameState) {
    this.baseSnapshot = structuredClone(initial);
    this.state = initial;
  }

  get canUndo(): boolean {
    return this.frames.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Apply an action, recording its frame + logs. Throws (no-op) if illegal. */
  dispatch(action: Action): void {
    const { nextState, frame, logs } = applyAction(
      this.state,
      action,
      this.frames.length + 1,
      this.logs.length,
    );
    this.state = nextState;
    this.frames.push(frame);
    this.logs.push(...logs);
    this.redoStack = []; // a fresh action invalidates the redo branch
  }

  /** Take-back: drop the last frame group and re-fold. */
  undo(): void {
    const frame = this.frames.pop();
    if (!frame) return;
    const prevCount = this.frames.length ? this.frames[this.frames.length - 1]!.logCountAfter : 0;
    const removed = this.logs.splice(prevCount);
    this.redoStack.push({ frame, logs: removed });
    this.state = foldFrames(this.baseSnapshot, this.frames);
  }

  /** Re-apply the most recently undone frame. */
  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.frames.push(entry.frame);
    this.logs.push(...entry.logs);
    this.state = foldFrames(this.baseSnapshot, this.frames);
  }

  /** Serialisable replay object (spec §10.1 shape, minus match metadata). */
  toReplay(): Replay<GameState> {
    return {
      format: "inkforge-replay-v1",
      baseSnapshot: this.baseSnapshot,
      frames: this.frames,
      logs: this.logs,
    };
  }
}
