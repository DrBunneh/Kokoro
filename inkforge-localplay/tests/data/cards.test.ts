import { describe, expect, it } from "vitest";
import db from "@/data/cards.generated.json";
import { buildIndex, filterCards } from "@/data/cards";
import type { PrintedCard } from "@/data/card-types";

const index = buildIndex((db as { cards: PrintedCard[] }).cards);

/** Unique card ids taken from the decklist embedded in the supplied replay. */
const REPLAY_DECK_IDS = [
  "10-155", "5-157", "5-160", "11-122", "3-161", "1-161", "2-169", "10-237",
  "1-113", "5-167", "7-162", "6-163", "12-125", "6-124", "3-112", "4-128",
  "4-134", "1-128", "12-160", "3-161", "11-111",
];

describe("card DB ingest", () => {
  it("ingests the full catalog", () => {
    expect(index.all.length).toBeGreaterThan(2000);
  });

  it("resolves Maui - Half-Shark (6-124) with correct printed fields", () => {
    const maui = index.get("6-124");
    expect(maui).toBeDefined();
    expect(maui!.fullName).toBe("Maui - Half-Shark");
    expect(maui!.type).toBe("character");
    expect(maui!.colors).toEqual(["ruby"]);
    expect(maui!.cost).toBe(6);
    expect(maui!.strength).toBe(7);
    expect(maui!.willpower).toBe(5);
    expect(maui!.lore).toBe(1);
    expect(maui!.abilities).toContainEqual({ ability: "Evasive" });
    expect(maui!.specialAbilities.map((s) => s.slug)).toContain("wayfinding");
  });

  it("resolves every card id from the real replay decklist", () => {
    const missing = [...new Set(REPLAY_DECK_IDS)].filter((id) => !index.get(id));
    expect(missing).toEqual([]);
  });

  it("classifies songs and locations", () => {
    expect(index.all.some((c) => c.type === "song")).toBe(true);
    const loc = index.all.find((c) => c.type === "location");
    expect(loc?.moveCost).toBeGreaterThanOrEqual(0);
  });

  it("filters by colour, type, cost and keyword", () => {
    const rubyChars = filterCards(index.all, { colors: ["ruby"], types: ["character"] });
    expect(rubyChars.length).toBeGreaterThan(0);
    expect(rubyChars.every((c) => c.type === "character" && c.colors.includes("ruby"))).toBe(true);

    const evasive = filterCards(index.all, { keyword: "evasive" });
    expect(evasive.some((c) => c.id === "6-124")).toBe(true);

    const cheap = filterCards(index.all, { cost: { max: 1 } });
    expect(cheap.every((c) => c.cost <= 1)).toBe(true);
  });
});
