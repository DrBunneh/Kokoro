import { describe, expect, it } from "vitest";
import { createGame, reduce, applyAction, GameError, type Action } from "@/engine/actions";
import { foldFrames } from "@/engine/replay";
import type { CardLookup, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(id: string, over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id,
    name: id,
    fullName: id,
    type: "character",
    colors: ["ruby"],
    cost: 1,
    inkable: true,
    abilities: [],
    specialAbilities: [],
    subtypes: [],
    rulesText: "",
    rarity: "common",
    setNum: 1,
    cardNum: 1,
    ...over,
  };
}

function lookupWith(overrides: Record<string, Partial<PrintedCard>> = {}): CardLookup {
  return (id) => printed(id, overrides[id]);
}

function deckOf(n: number, prefix = "c"): string[] {
  return Array.from({ length: n }, (_, i) => `1-${prefix}${i + 1}`);
}

function newGame(seed = "seed", deck1 = deckOf(60, "a"), deck2 = deckOf(60, "b"), lookup = lookupWith()): GameState {
  return createGame({
    id: "g1",
    seed,
    lookup,
    players: { 1: { name: "P1", deck: deck1 }, 2: { name: "P2", deck: deck2 } },
  });
}

describe("createGame", () => {
  it("starts at coin toss with shuffled 60-card decks and a decided toss", () => {
    const g = newGame();
    expect(g.status).toBe("coin_toss");
    expect(g.coinToss).toBeDefined();
    expect([1, 2]).toContain(g.coinToss!.winner);
    expect(g.players[1].deck).toHaveLength(60);
    expect(g.players[2].deck).toHaveLength(60);
  });

  it("is deterministic for a given seed", () => {
    const a = newGame("fixed");
    const b = newGame("fixed");
    expect(a.players[1].deck.map((c) => c.instanceId)).toEqual(b.players[1].deck.map((c) => c.instanceId));
    expect(a.coinToss!.winner).toBe(b.coinToss!.winner);
  });
});

describe("setup → play", () => {
  function toPlay(seed = "play"): GameState {
    let g = newGame(seed);
    g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
    g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
    g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
    return g;
  }

  it("deals 7 to each player on choosing the starting player", () => {
    let g = newGame();
    g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
    expect(g.status).toBe("mulligan");
    expect(g.players[1].hand).toHaveLength(7);
    expect(g.players[2].hand).toHaveLength(7);
    expect(g.players[1].deck).toHaveLength(53);
  });

  it("first player skips the opening draw; play begins at turn 1", () => {
    const g = toPlay();
    expect(g.status).toBe("playing");
    expect(g.turnNumber).toBe(1);
    expect(g.currentPlayer).toBe(1);
    expect(g.players[1].hand).toHaveLength(7); // no opening draw
  });

  it("mulligan bottoms chosen cards and redraws equal count (hand stays 7)", () => {
    let g = newGame("mull");
    g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
    const toss = g.players[1].hand.slice(0, 3).map((c) => c.instanceId);
    g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: toss }).state;
    expect(g.players[1].hand).toHaveLength(7);
    // The bottomed instances are no longer in hand.
    expect(g.players[1].hand.some((c) => toss.includes(c.instanceId))).toBe(false);
  });

  it("enforces one ink per turn and inkable-only", () => {
    const g = toPlay();
    const inkable = g.players[1].hand[0]!;
    const g2 = reduce(g, { type: "ADD_TO_INK", cardInstanceId: inkable.instanceId }).state;
    expect(g2.players[1].inkwell).toHaveLength(1);
    expect(g2.hasInkedThisTurn).toBe(true);
    expect(() => reduce(g2, { type: "ADD_TO_INK", cardInstanceId: g2.players[1].hand[0]!.instanceId })).toThrow(GameError);
  });

  it("rejects inking a non-inkable card", () => {
    // All of P1's cards are non-inkable, so the opening hand is guaranteed to be.
    const noInk: CardLookup = (id) => printed(id, { inkable: !id.includes("-a") });
    let g = newGame("noink", deckOf(60, "a"), deckOf(60, "b"), noInk);
    g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
    g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
    g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
    const uninkable = g.players[1].hand.find((c) => !c.printed.inkable);
    expect(uninkable).toBeDefined();
    expect(() => reduce(g, { type: "ADD_TO_INK", cardInstanceId: uninkable!.instanceId })).toThrow(/not inkable/);
  });

  it("END_TURN passes to the opponent, who draws", () => {
    const g = toPlay();
    const g2 = reduce(g, { type: "END_TURN" }).state;
    expect(g2.currentPlayer).toBe(2);
    expect(g2.turnNumber).toBe(2);
    expect(g2.players[2].hand).toHaveLength(8); // opponent draws on their turn
  });

  it("a player who must draw from an empty deck loses (deckout)", () => {
    // P2 has exactly 7 cards: dealt out, decks on their first draw.
    let g = newGame("deck", deckOf(60, "a"), deckOf(7, "b"));
    g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
    g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
    g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
    expect(g.players[2].deck).toHaveLength(0);
    g = reduce(g, { type: "END_TURN" }).state; // pass to P2 → they draw from empty
    expect(g.status).toBe("finished");
    expect(g.winner).toBe(1);
    expect(g.victoryReason).toBe("deckout");
  });

  it("rejects actions once finished", () => {
    let g = newGame("fin");
    g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
    g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
    g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
    g = reduce(g, { type: "GAME_FINISH", winner: 1, reason: "concession" }).state;
    expect(g.status).toBe("finished");
    expect(() => reduce(g, { type: "END_TURN" })).toThrow(/finished/);
  });
});

describe("applyAction framing", () => {
  const script: Action[] = [
    { type: "CHOOSE_STARTING_PLAYER", player: 1 },
    { type: "MULLIGAN", player: 1, cardInstanceIds: [] },
    { type: "MULLIGAN", player: 2, cardInstanceIds: [] },
    { type: "END_TURN" },
  ];

  it("each frame round-trips: folding it reproduces the next state", () => {
    let state = newGame("frame");
    let seq = 1;
    for (const action of script) {
      const { nextState, frame } = applyAction(state, action, seq++);
      expect(foldFrames(state, [frame])).toEqual(nextState);
      state = nextState;
    }
  });

  it("is deterministic: same seed + actions ⇒ identical frame patches", () => {
    function run(): unknown[] {
      let state = newGame("det");
      let seq = 1;
      const patches: unknown[] = [];
      for (const action of script) {
        const { nextState, frame } = applyAction(state, action, seq++);
        patches.push(frame.patch);
        state = nextState;
      }
      return patches;
    }
    expect(run()).toEqual(run());
  });
});
