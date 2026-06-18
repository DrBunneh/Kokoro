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
function state(p1: Partial<ReturnType<typeof blank>>): GameState {
  return { id: "t", status: "playing", currentPlayer: 1, turnNumber: 1, firstPlayer: 1, hasInkedThisTurn: false, players: { 1: { ...blank(), ...p1 }, 2: blank() }, pendingPrompts: [], winner: null, rngSeed: "s", rngCursor: 0 } as GameState;
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
