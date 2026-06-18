import { describe, expect, it } from "vitest";
import { deckRecord } from "@/state/stats";
import type { StoredReplay } from "@/state/db";

function rep(over: Partial<StoredReplay>): StoredReplay {
  return {
    id: Math.random().toString(36),
    createdAt: 0,
    playerNames: { 1: "A", 2: "B" },
    deck1Id: "d1",
    deck2Id: "d2",
    deck1Colors: ["ruby"],
    deck2Colors: ["amber"],
    firstPlayer: 1,
    winner: 1,
    turnCount: 5,
    replay: { format: "inkforge-replay-v1", baseSnapshot: {} as never, frames: [], logs: [] },
    ...over,
  };
}

describe("deckRecord", () => {
  it("splits a deck's record by on-the-play / on-the-draw", () => {
    const replays: StoredReplay[] = [
      rep({ deck1Id: "d1", deck2Id: "d2", firstPlayer: 1, winner: 1 }), // d1 OTP win
      rep({ deck1Id: "d2", deck2Id: "d1", firstPlayer: 1, winner: 1 }), // d1 is P2, OTD, P1 won → d1 loss OTD
      rep({ deck1Id: "d1", deck2Id: "d2", firstPlayer: 2, winner: 1 }), // d1 is P1, OTD, won
    ];
    const r = deckRecord(replays, "d1");
    expect(r.played).toBe(3);
    expect(r.wins).toBe(2);
    expect(r.winPct).toBe(67);
    expect(r.otpPlayed).toBe(1);
    expect(r.otpWins).toBe(1);
    expect(r.otdPlayed).toBe(2);
    expect(r.otdWins).toBe(1);
  });

  it("counts a mirror (same deck both sides) as two appearances", () => {
    const r = deckRecord([rep({ deck1Id: "x", deck2Id: "x", firstPlayer: 1, winner: 1 })], "x");
    expect(r.played).toBe(2);
    expect(r.wins).toBe(1);
  });

  it("is empty for an unseen deck", () => {
    expect(deckRecord([rep({})], "nope").played).toBe(0);
  });
});
