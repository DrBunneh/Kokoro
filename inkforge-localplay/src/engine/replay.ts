/**
 * Event-sourced replay machinery (spec §4.1, §4.5). A game is an immutable
 * `baseSnapshot` plus an ordered list of `frames`, each an RFC-6902 JSON Patch.
 * Reconstruct any point by folding patches `1..n` over the base; take-back is
 * re-folding all but the last frame.
 *
 * Our own engine emits strict, well-formed patches (via rfc6902 `createPatch`),
 * so the default fold is strict. duels.ink replays use `replace` on
 * not-yet-existing paths; `lenient` mode coerces those (and tolerates removing
 * a missing path) so their files — and our importer — fold cleanly.
 */
import { applyPatch, createPatch, type Operation } from "rfc6902";

export interface Frame {
  seq: number;
  actionType: string;
  player: 1 | 2;
  turnNumber: number;
  patch: Operation[];
  logCountAfter: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  turnNumber: number;
  player: 1 | 2 | null;
  type: string;
  message: string;
  cardRefs?: { id: string; name: string }[];
  /** Structured payload seen in real logs, e.g. { mulliganCount } (Finding §1.3). */
  data?: Record<string, unknown>;
}

export interface FoldOptions {
  /** Fold only frames with index < upTo (default: all). */
  upTo?: number;
  /** Tolerate duels.ink-style patches (replace-on-missing, remove-missing). */
  lenient?: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Resolve a JSON Pointer; returns whether the target currently exists. */
function pointerExists(doc: unknown, path: string): boolean {
  if (path === "") return true;
  const parts = path
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const part of parts) {
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return false;
      cur = cur[i];
    } else if (cur && typeof cur === "object") {
      if (!(part in (cur as Record<string, unknown>))) return false;
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return false;
    }
  }
  return true;
}

/** Coerce duels.ink-style ops into strict-appliable ones against `doc`. */
function normalizeOps(doc: unknown, ops: Operation[]): Operation[] {
  const out: Operation[] = [];
  for (const op of ops) {
    if (op.op === "replace" && !pointerExists(doc, op.path)) {
      out.push({ op: "add", path: op.path, value: (op as { value: unknown }).value });
    } else if (op.op === "remove" && !pointerExists(doc, op.path)) {
      // Target already gone — skip.
      continue;
    } else {
      out.push(op);
    }
  }
  return out;
}

/** Apply one patch to a draft (mutating). Throws on strict errors. */
function applyOps(draft: unknown, ops: Operation[], lenient: boolean): void {
  const effective = lenient ? normalizeOps(draft, ops) : ops;
  const results = applyPatch(draft, effective);
  const errors = results.filter((r): r is NonNullable<typeof r> => r != null);
  if (errors.length && !lenient) {
    throw new Error(`Patch apply failed: ${errors.map((e) => e.message).join("; ")}`);
  }
}

/**
 * Fold frames over a base snapshot to reconstruct state at frame `upTo`
 * (default: the end). Pure — does not mutate `base`.
 */
export function foldFrames<S>(base: S, frames: Frame[], opts: FoldOptions = {}): S {
  const { upTo = frames.length, lenient = false } = opts;
  const draft = clone(base);
  for (let i = 0; i < Math.min(upTo, frames.length); i++) {
    applyOps(draft, frames[i]!.patch, lenient);
  }
  return draft;
}

export interface Replay<S = unknown> {
  format: "inkforge-replay-v1";
  baseSnapshot: S;
  frames: Frame[];
  logs: LogEntry[];
}

/**
 * Build a frame from the diff between two states (spec §4.1 frame generation).
 * One player action produces exactly one frame (its patch may hold many ops).
 */
export function makeFrame(
  prev: unknown,
  next: unknown,
  meta: { actionType: string; player: 1 | 2; turnNumber: number; logCountAfter: number },
  seq: number,
): Frame {
  return {
    seq,
    actionType: meta.actionType,
    player: meta.player,
    turnNumber: meta.turnNumber,
    patch: createPatch(prev, next),
    logCountAfter: meta.logCountAfter,
  };
}

/**
 * Take-back: drop the last frame and return the frame list to re-fold (spec
 * §4.5). Returns the removed frame so it can be redone while no new action has
 * been taken.
 */
export function dropLastFrame(frames: Frame[]): { frames: Frame[]; undone: Frame | undefined } {
  if (frames.length === 0) return { frames, undone: undefined };
  return { frames: frames.slice(0, -1), undone: frames[frames.length - 1] };
}
