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

describe("Wave 2 — DSL steps", () => {
  it("draw player:'each' draws for both players", () => {
    const src = inst("s", printed());
    const g = state(
      { field: [src], deck: [inst("d1", printed()), inst("d2", printed())] },
      { deck: [inst("e1", printed()), inst("e2", printed())] },
    );
    run(g, src, [{ do: "draw", player: "each", amount: 1 }]);
    expect(g.players[1].hand).toHaveLength(1);
    expect(g.players[2].hand).toHaveLength(1);
  });

  it("banishAll damaged: only damaged opposing characters die", () => {
    const src = inst("s", printed());
    const hurt = inst("h", printed(), { damage: 1 });
    const fine = inst("f", printed());
    const g = state({ field: [src] }, { field: [hurt, fine] });
    run(g, src, [{ do: "banishAll", scope: "enemy", damaged: true }]);
    expect(g.players[2].field.map((c) => c.instanceId)).toEqual(["f"]);
    expect(g.players[2].discard.map((c) => c.instanceId)).toEqual(["h"]);
  });

  it("banishAll maxStrength: only opposing characters at/under the threshold die", () => {
    const src = inst("s", printed());
    const weak = inst("w", printed({ strength: 2 }));
    const strong = inst("b", printed({ strength: 5 }));
    const g = state({ field: [src] }, { field: [weak, strong] });
    run(g, src, [{ do: "banishAll", scope: "enemy", maxStrength: 2 }]);
    expect(g.players[2].field.map((c) => c.instanceId)).toEqual(["b"]);
  });

  it("gainLoreEqual: lore = a bound character's lore / damage", () => {
    const src = inst("s", printed());
    const target = inst("t", printed({ lore: 3 }), { damage: 2 });
    const g = state({ field: [src], lore: 0 }, { field: [target] });
    run(g, src, [{ do: "gainLoreEqual", from: "t", stat: "lore" }], { t: "t" });
    expect(g.players[1].lore).toBe(3);
    run(g, src, [{ do: "gainLoreEqual", from: "t", stat: "damage" }], { t: "t" });
    expect(g.players[1].lore).toBe(3 + 2);
  });

  it("Merida 'steadyaim': an action that damages an enemy deals 2 extra", () => {
    const action = inst("act", printed({ type: "action" }));
    const archer = inst("m", printed({ specialAbilities: [{ name: "Steady Aim", slug: "steadyaim", effect: "x" }] }));
    const enemy = inst("e", printed({ willpower: 10 }));
    const g = state({ field: [archer] }, { field: [enemy] });
    // Resolve a 1-damage deal with the action as the effect source.
    const ctx: EffectContext = { controller: 1, source: action, vars: { t: "e" }, banished: [] };
    runSteps(g, [{ do: "dealDamage", to: "t", amount: 1 }], ctx, []);
    expect(enemy.damage).toBe(3); // 1 from the action + 2 from Steady Aim
  });

  it("debuff with untilNextTurn carries an end-of-turn-proof castBy tag", () => {
    const src = inst("s", printed());
    const enemy = inst("e", printed({ strength: 4 }));
    const g = state({ field: [src] }, { field: [enemy] });
    run(g, src, [{ do: "debuff", to: "t", strength: 1, duration: "untilNextTurn" }], { t: "e" });
    const eff = enemy.appliedEffects[0]!;
    expect(eff.duration).toBe("untilNextTurn");
    expect(eff.castBy).toBe(1);
    // Survives the END_TURN filter (only end_of_turn effects are cleared there).
    expect(eff.duration === "end_of_turn").toBe(false);
  });
});
