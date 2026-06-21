import { describe, expect, it } from "vitest";
import { runSteps, type EffectContext, type Step } from "@/engine/effects/dsl";
import type { CardInstance, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id: "x", name: "x", fullName: "x", type: "character", colors: ["ruby"], cost: 1, inkable: true,
    strength: 2, willpower: 3, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
    rulesText: "", rarity: "common", setNum: 1, cardNum: 1, ...over,
  };
}
function inst(id: string, p: PrintedCard, over: Partial<CardInstance> = {}): CardInstance {
  return { instanceId: id, printed: p, damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [], ...over };
}
function blank() {
  return { name: "", hand: [] as CardInstance[], field: [] as CardInstance[], items: [] as CardInstance[], inkwell: [] as CardInstance[], discard: [] as CardInstance[], deck: [] as CardInstance[], lore: 0, discounts: [], extraInk: 0, discardedThisTurn: 0, playedThisTurn: [] };
}
function state(p1: Partial<ReturnType<typeof blank>>, p2: Partial<ReturnType<typeof blank>> = {}): GameState {
  return { id: "t", status: "playing", currentPlayer: 1, turnNumber: 1, firstPlayer: 1, hasInkedThisTurn: false, players: { 1: { ...blank(), ...p1 }, 2: { ...blank(), ...p2 } }, pendingPrompts: [], winner: null, rngSeed: "s", rngCursor: 0 } as GameState;
}
function run(g: GameState, source: CardInstance, steps: Step[], vars: Record<string, string> = {}) {
  const ctx: EffectContext = { controller: 1, source, vars, banished: [] };
  return runSteps(g, steps, ctx, []);
}

describe("Wave 5 — returnSelfToHand", () => {
  it("moves the source card out of the discard back into hand", () => {
    const src = inst("s", printed());
    const g = state({ discard: [src], hand: [] });
    run(g, src, [{ do: "returnSelfToHand" }]);
    expect(g.players[1].discard).toHaveLength(0);
    expect(g.players[1].hand.map((c) => c.instanceId)).toEqual(["s"]);
    expect(src.exerted).toBe(false);
    expect(src.damage).toBe(0);
  });

  it("is a no-op when the source isn't in the discard", () => {
    const src = inst("s", printed());
    const g = state({ field: [src] });
    run(g, src, [{ do: "returnSelfToHand" }]);
    expect(g.players[1].hand).toHaveLength(0);
  });
});

describe("Wave 5 — playFree", () => {
  it("suspends on a hand picker, then puts the chosen cost-≤2 character into play", () => {
    const src = inst("s", printed());
    const cheap = inst("c", printed({ type: "character", cost: 2 }));
    const pricey = inst("p", printed({ type: "character", cost: 5 }));
    const g = state({ field: [src], hand: [cheap, pricey] });
    const susp = run(g, src, [{ do: "playFree", from: "hand", cardType: "character", maxCost: 2, optional: true }]);
    expect(susp).not.toBeNull();
    expect(susp!.pick).toBe("hand");
    // Resume with the cheap character → it enters play; pricey stays in hand.
    const ctx: EffectContext = { controller: 1, source: src, vars: {}, banished: [] };
    runSteps(g, susp!.steps, ctx, [], "c");
    expect(g.players[1].field.some((c) => c.instanceId === "c")).toBe(true);
    expect(g.players[1].field.find((c) => c.instanceId === "c")!.justPlayed).toBe(true);
    expect(g.players[1].hand.map((c) => c.instanceId)).toEqual(["p"]);
  });

  it("skips entirely when no legal card exists", () => {
    const src = inst("s", printed());
    const pricey = inst("p", printed({ cost: 9 }));
    const g = state({ field: [src], hand: [pricey] });
    const susp = run(g, src, [{ do: "playFree", from: "hand", cardType: "character", maxCost: 2, optional: true }]);
    expect(susp).toBeNull(); // nothing to play → no prompt
    expect(g.players[1].field).toHaveLength(1);
  });
});

describe("Wave: cards-under harvest", () => {
  it("cardsUnderTo moves a bound character's under-cards to the inkwell", () => {
    const under = [inst("u1", printed()), inst("u2", printed())];
    const host = inst("h", printed(), { cardsUnder: under });
    const g = state({ field: [host], inkwell: [] });
    run(g, host, [{ do: "cardsUnderTo", from: "t", to: "inkwellExerted" }], { t: "h" });
    expect(host.cardsUnder).toHaveLength(0);
    expect(g.players[1].inkwell.map((c) => c.instanceId).sort()).toEqual(["u1", "u2"]);
    expect(g.players[1].inkwell.every((c) => c.exerted)).toBe(true);
  });

  it("harvestUnder pulls under-cards from all your sources into hand", () => {
    const a = inst("a", printed(), { cardsUnder: [inst("ua", printed())] });
    const b = inst("b", printed(), { cardsUnder: [inst("ub", printed())] });
    const g = state({ field: [a, b], hand: [] });
    run(g, a, [{ do: "harvestUnder", to: "hand" }]);
    expect(g.players[1].hand.map((c) => c.instanceId).sort()).toEqual(["ua", "ub"]);
    expect(a.cardsUnder).toHaveLength(0);
    expect(b.cardsUnder).toHaveLength(0);
  });
});

describe("Wave: each-player choice", () => {
  it("eachPlayer pushes a separate prompt to each player", () => {
    const src = inst("s", printed());
    const g = state({ field: [src], discard: [inst("d1", printed())] }, { discard: [inst("e1", printed())] });
    run(g, src, [{ do: "eachPlayer", who: "each", steps: [{ do: "returnFromDiscard", keepUpTo: 1, to: "inkwellExerted", optional: true }] }]);
    // One prompt per player (both have a discard to act on).
    expect(g.pendingPrompts).toHaveLength(2);
    expect(g.pendingPrompts.map((p) => p.controller).sort()).toEqual([1, 2]);
  });
});
