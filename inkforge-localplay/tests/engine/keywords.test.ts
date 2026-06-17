import { describe, expect, it } from "vitest";
import {
  effectiveStrength,
  effectiveWillpower,
  hasKeyword,
  isBanished,
  keywordValue,
} from "@/engine/keywords";
import type { CardInstance } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

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
    expect(hasKeyword(c, "Evasive")).toBe(true);
    expect(hasKeyword(c, "Resist")).toBe(true);
    expect(hasKeyword(c, "Sing Together")).toBe(true);
    expect(hasKeyword(c, "Rush")).toBe(false);
  });

  it("stacks +N keyword values and parses trailing numbers", () => {
    expect(keywordValue(ci(["Resist +1", "Resist +2"]), "Resist")).toBe(3);
    expect(keywordValue(ci(["Challenger +2"]), "Challenger")).toBe(2);
    expect(keywordValue(ci(["Shift 5"]), "Shift")).toBe(5);
    expect(keywordValue(ci(["Evasive"]), "Resist")).toBe(0);
  });

  it("computes effective stats with applied effects", () => {
    const c = ci([], { strength: 2, willpower: 3 });
    c.appliedEffects.push({ source: "buff", strength: 2, willpower: -1, duration: "end_of_turn" });
    expect(effectiveStrength(c)).toBe(4);
    expect(effectiveWillpower(c)).toBe(2);
  });

  it("banishes at damage >= willpower", () => {
    expect(isBanished(ci([], { willpower: 3 }, 2))).toBe(false);
    expect(isBanished(ci([], { willpower: 3 }, 3))).toBe(true);
  });
});
