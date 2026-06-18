import { describe, expect, it } from "vitest";
import { damagePrevented } from "@/engine/continuous";
import { effectiveStrength } from "@/engine/keywords";
import type { CardInstance, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id: "x", name: "x", fullName: "x", type: "character", colors: ["ruby"], cost: 1, inkable: true,
    strength: 3, willpower: 5, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
    rulesText: "", rarity: "common", setNum: 1, cardNum: 1, ...over,
  };
}
function inst(id: string, p: PrintedCard, over: Partial<CardInstance> = {}): CardInstance {
  return { instanceId: id, printed: p, damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [], ...over };
}
function state(p1: Partial<GameState["players"][1]>, current: 1 | 2 = 1): GameState {
  const blank = () => ({ name: "", hand: [], field: [], items: [], inkwell: [], discard: [], deck: [], lore: 0, discounts: [], extraInk: 0, discardedThisTurn: 0, playedThisTurn: [] });
  return { id: "t", status: "playing", currentPlayer: current, turnNumber: 1, firstPlayer: 1, hasInkedThisTurn: false, players: { 1: { ...blank(), ...p1 }, 2: blank() }, pendingPrompts: [], winner: null, rngSeed: "s", rngCursor: 0 } as GameState;
}
const SA = (slug: string) => [{ name: slug, slug, effect: slug }];

describe("damage prevention", () => {
  it("Hercules 'evervigilant': effect/attacker damage prevented, defender damage allowed", () => {
    const herc = inst("h", printed({ specialAbilities: SA("evervigilant") }));
    const g = state({ field: [herc] });
    expect(damagePrevented(g, herc, "effect")).toBe(true);
    expect(damagePrevented(g, herc, "attacker")).toBe(true);
    expect(damagePrevented(g, herc, "defender")).toBe(false);
  });

  it("'evervaliant': an exerted Hercules shields your OTHER Hero characters (not him, not non-Heroes)", () => {
    const herc = inst("h", printed({ subtypes: ["Hero"], specialAbilities: SA("evervaliant") }), { exerted: true });
    const ally = inst("a", printed({ subtypes: ["Hero"] }));
    const nonHero = inst("n", printed({ subtypes: ["Ally"] }));
    const g = state({ field: [herc, ally, nonHero] });
    expect(damagePrevented(g, ally, "effect")).toBe(true);
    expect(damagePrevented(g, nonHero, "effect")).toBe(false);
    // Not exerted → no shield.
    herc.exerted = false;
    expect(damagePrevented(g, ally, "effect")).toBe(false);
  });

  it("Lilo 'extralayers': first damage during the opponent's turn is prevented, once", () => {
    const lilo = inst("l", printed({ specialAbilities: SA("extralayers") }));
    const g = state({ field: [lilo] }, 2); // opponent (P2) is the current player
    expect(damagePrevented(g, lilo, "effect")).toBe(true); // first hit shielded
    expect(damagePrevented(g, lilo, "effect")).toBe(false); // shield spent
    // On the owner's own turn the shield doesn't apply.
    const g2 = state({ field: [inst("l2", printed({ specialAbilities: SA("extralayers") }))] }, 1);
    expect(damagePrevented(g2, g2.players[1].field[0]!, "effect")).toBe(false);
  });

  it("Elisa 'forever strong': {S} can't be reduced below printed by debuffs", () => {
    const floor = inst("e", printed({ strength: 4, specialAbilities: SA("foreverstrong") }));
    const ally = inst("a", printed({ strength: 4 }), { appliedEffects: [{ source: "x", strength: -10, duration: "end_of_turn" }] });
    const g = state({ field: [floor, ally] });
    expect(effectiveStrength(g, ally)).toBe(4); // clamped to printed, not -6
  });
});
