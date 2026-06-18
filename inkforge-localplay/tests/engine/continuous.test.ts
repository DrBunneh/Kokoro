import { describe, expect, it } from "vitest";
import { effectiveStrength, keywordValue } from "@/engine/keywords";
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
function state(p1: Partial<GameState["players"][1]>): GameState {
  const blank = () => ({ name: "", hand: [], field: [], items: [], inkwell: [], discard: [], deck: [], lore: 0, discounts: [], extraInk: 0, discardedThisTurn: 0, playedThisTurn: [] });
  return { id: "t", status: "playing", currentPlayer: 1, turnNumber: 1, firstPlayer: 1, hasInkedThisTurn: false, players: { 1: { ...blank(), ...p1 }, 2: blank() }, pendingPrompts: [], winner: null, rngSeed: "s", rngCursor: 0 } as GameState;
}

describe("continuous (static) effects", () => {
  it("Snow Fort: +1 strength to your characters while it's in play", () => {
    const fort = inst("fort", printed({ type: "item", specialAbilities: [{ name: "The High Ground", slug: "thehighground", effect: "Your characters get +1 {S}." }] }));
    const hero = inst("hero", printed({ strength: 2 }));
    const g = state({ field: [hero], items: [fort] });
    expect(effectiveStrength(g, hero)).toBe(3); // 2 + 1 from Snow Fort
  });

  it("Namaari: +1 strength per card in your discard", () => {
    const namaari = inst("n", printed({ strength: 0, specialAbilities: [{ name: "Extreme Focus", slug: "extremefocus", effect: "+1 {S} per card in your discard." }] }));
    const g = state({ field: [namaari], discard: [inst("d1", printed()), inst("d2", printed()), inst("d3", printed())] });
    expect(effectiveStrength(g, namaari)).toBe(3);
  });

  it("Pete - Space Pirate: your Pirates gain Resist +1 while he's exerted", () => {
    const pete = inst("pete", printed({ subtypes: ["Pirate"], specialAbilities: [{ name: "Frightful Scheme", slug: "frightfulscheme", effect: "While exerted, your Pirates gain Resist +1." }] }), { exerted: true });
    const mate = inst("mate", printed({ subtypes: ["Pirate"] }));
    const g = state({ field: [pete, mate] });
    expect(keywordValue(g, mate, "Resist")).toBe(1);
    // Not exerted → no grant.
    pete.exerted = false;
    expect(keywordValue(g, mate, "Resist")).toBe(0);
  });
});
