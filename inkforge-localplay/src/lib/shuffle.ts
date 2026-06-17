import seedrandom from "seedrandom";

/**
 * Fisher–Yates shuffle. Optionally seeded for reproducibility. (The duel engine
 * uses its own seeded RNG stream in P1; this is for the standalone Mulligan
 * trainer.)
 */
export function shuffle<T>(input: readonly T[], seed?: string): T[] {
  const rng = seed ? seedrandom(seed) : Math.random;
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
