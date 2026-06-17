/**
 * Deterministic seeded RNG stream (spec §4.4). All randomness — coin toss,
 * shuffles, draws — is drawn from a single seeded stream so a game is exactly
 * reproducible from `baseSnapshot + frames`. `cursor` records how many values
 * have been consumed, letting reconstruction re-advance to any point.
 *
 * In PvP the host owns the seed and broadcasts authoritative frames; the
 * follower never rolls its own RNG.
 */
import seedrandom from "seedrandom";

export interface RngState {
  seed: string;
  cursor: number;
}

export class Rng {
  readonly seed: string;
  cursor: number;
  private prng: seedrandom.PRNG;

  constructor(seed: string, cursor = 0) {
    this.seed = seed;
    this.cursor = 0;
    this.prng = seedrandom(seed);
    // Re-advance to the recorded position for exact reconstruction.
    for (let i = 0; i < cursor; i++) this.next();
  }

  /** Next float in [0, 1); advances the cursor. */
  next(): number {
    this.cursor += 1;
    return this.prng();
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  /** Fisher–Yates shuffle drawn from the seeded stream (non-mutating). */
  shuffle<T>(input: readonly T[]): T[] {
    const a = [...input];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  state(): RngState {
    return { seed: this.seed, cursor: this.cursor };
  }
}

export function rngFrom(state: RngState): Rng {
  return new Rng(state.seed, state.cursor);
}
