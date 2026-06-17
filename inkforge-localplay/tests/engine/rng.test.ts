import { describe, expect, it } from "vitest";
import { Rng, rngFrom } from "@/engine/rng";

describe("seeded RNG", () => {
  it("is deterministic for a given seed", () => {
    const a = new Rng("seed-1");
    const b = new Rng("seed-1");
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
    expect(a.cursor).toBe(3);
  });

  it("differs across seeds", () => {
    expect(new Rng("a").next()).not.toBe(new Rng("b").next());
  });

  it("reconstructs exactly from a saved cursor", () => {
    const live = new Rng("game");
    live.next();
    live.next();
    const third = live.next(); // cursor now 3
    // Re-create from state captured *before* the 3rd draw.
    const restored = rngFrom({ seed: "game", cursor: 2 });
    expect(restored.next()).toBe(third);
  });

  it("shuffles deterministically and preserves the multiset", () => {
    const deck = Array.from({ length: 60 }, (_, i) => i);
    const s1 = new Rng("x").shuffle(deck);
    const s2 = new Rng("x").shuffle(deck);
    expect(s1).toEqual(s2);
    expect([...s1].sort((a, b) => a - b)).toEqual(deck);
    expect(s1).not.toEqual(deck); // overwhelmingly likely reordered
  });
});
