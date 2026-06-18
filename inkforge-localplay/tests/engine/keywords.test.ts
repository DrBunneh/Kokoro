import { describe, expect, it } from "vitest";
import {
  effectiveStrength,
  effectiveWillpower,
  hasKeyword,
  isBanished,
  keywordValue,
} from "@/engine/keywords";
import type { CardInstance, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

/** Minimal state with empty boards — continuous mods resolve to zero. */
function emptyState(): GameState {
  const p = () => ({ name: "", hand: [], field: [], items: [], inkwell: [], discard: [], deck: [], lore: 0, discounts: [], extraInk: 0, discardedThisTurn: 0, playedThisTurn: [] });
  return { id: "t", status: "playing", currentPlayer: 1, turnNumber: 1, firstPlayer: 1, hasInkedThisTurn: false, players: { 1: p(), 2: p() }, pendingPrompts: [], winner: null, rngSeed: "s", rngCursor: 0 } as GameState;
}
const st = emptyState();

function ci(abilities: string[], over: Partial<PrintedCard> = {}, damage = 0): CardInstance {
  const printed: PrintedCard = {
    id: "x",
    name: "x",
    fullName: "x",
    type: "character",
    colors: ["ruby"],
    cost: 1,
    inkable: true,
    strength: 2,
    willpower: 3,
    lore: 1,
    abilities: abilities.map((ability) => ({ ability })),
    specialAbilities: [],
    subtypes: [],
    rulesText: "",
    rarity: "common",
    setNum: 1,
    cardNum: 1,
    ...over,
  };
  return { instanceId: "i", printed, damage, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
}

describe("keyword helpers", () => {
  it("detects plain and valued keywords by name", () => {
    const c = ci(["Evasive", "Resist +1", "Sing Together 7"]);
    expect(hasKeyword(st, c, "Evasive")).toBe(true);
    expect(hasKeyword(st, c, "Resist")).toBe(true);
    expect(hasKeyword(st, c, "Sing Together")).toBe(true);
    expect(hasKeyword(st, c, "Rush")).toBe(false);
  });

  it("stacks +N keyword values and parses trailing numbers", () => {
    expect(keywordValue(st, ci(["Resist +1", "Resist +2"]), "Resist")).toBe(3);
    expect(keywordValue(st, ci(["Challenger +2"]), "Challenger")).toBe(2);
    expect(keywordValue(st, ci(["Shift 5"]), "Shift")).toBe(5);
    expect(keywordValue(st, ci(["Evasive"]), "Resist")).toBe(0);
  });

  it("computes effective stats with applied effects", () => {
    const c = ci([], { strength: 2, willpower: 3 });
    c.appliedEffects.push({ source: "buff", strength: 2, willpower: -1, duration: "end_of_turn" });
    expect(effectiveStrength(st, c)).toBe(4);
    expect(effectiveWillpower(st, c)).toBe(2);
  });

  it("banishes at damage >= willpower", () => {
    expect(isBanished(st, ci([], { willpower: 3 }, 2))).toBe(false);
    expect(isBanished(st, ci([], { willpower: 3 }, 3))).toBe(true);
  });
});
