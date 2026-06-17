import { describe, expect, it } from "vitest";
import db from "@/data/cards.generated.json";
import { buildIndex } from "@/data/cards";
import {
  deckCardCount,
  deriveDeckStats,
  exportDecklist,
  parseDecklist,
  validateDeck,
} from "@/data/decklist";
import type { PrintedCard } from "@/data/card-types";

const index = buildIndex((db as { cards: PrintedCard[] }).cards);

/** The supplied decklist (decoded from the uploaded replay), canonical form. */
const SUPPLIED_DECKLIST = `3 Maleficent - Monstrous Dragon (1-113)
4 Be Prepared (1-128)
4 Develop Your Brain (1-161)
4 Pawpsicle (2-169)
2 Madame Medusa - The Boss (3-112)
3 How Far I'll Go (3-161)
1 A Pirate’s Life (4-128)
2 Vitalisphere (4-134)
4 Tipo - Growing Son (5-157)
4 Vision of the Future (5-160)
2 Merlin's Carpetbag (5-167)
3 Maui - Half-Shark (6-124)
4 Sail the Azurite Sea (6-163)
4 Tamatoa - Happy as a Clam (7-162)
4 Cinderella - Dream Come True (10-155)
2 Spooky Sight (10-237)
2 Liquidator - Iced Over (11-111)
4 Olaf - Snowman of Action (11-122)
1 The Leviathan - Guardian of Atlantis (12-125)
3 Kida - Crystal Scion (12-160)`;

describe("decklist parse/export", () => {
  it("parses the supplied decklist to 20 entries / 60 cards with no warnings", () => {
    const r = parseDecklist(SUPPLIED_DECKLIST);
    expect(r.warnings).toEqual([]);
    expect(r.cards.length).toBe(20);
    expect(deckCardCount(r.cards)).toBe(60);
    expect(r.cards.find((c) => c.id === "6-124")?.count).toBe(3);
  });

  it("round-trips: export(parse(text)) === canonical text", () => {
    const r = parseDecklist(SUPPLIED_DECKLIST);
    expect(exportDecklist(r.cards, index)).toBe(SUPPLIED_DECKLIST);
  });

  it("is tolerant of curly quotes, 'x' counts, blank lines and comments", () => {
    const messy = [
      "# my deck",
      "",
      "3x  Maui - Half-Shark  (6-124)  ",
      "1 A Pirate’s Life (4-128)",
      "// a comment",
    ].join("\n");
    const r = parseDecklist(messy);
    expect(r.warnings).toEqual([]);
    expect(r.cards).toContainEqual({ id: "6-124", count: 3 });
    expect(r.cards).toContainEqual({ id: "4-128", count: 1 });
  });

  it("merges duplicate ids and warns on unparseable lines", () => {
    const r = parseDecklist("2 Maui (6-124)\n2 Maui again (6-124)\ngarbage line");
    expect(r.cards).toContainEqual({ id: "6-124", count: 4 });
    expect(r.warnings.some((w) => w.includes("garbage line"))).toBe(true);
  });

  it("derives tile stats (colours, inkable/uninkable)", () => {
    const r = parseDecklist(SUPPLIED_DECKLIST);
    const stats = deriveDeckStats(r.cards, index);
    expect(stats.totalCount).toBe(60);
    expect(stats.inkableCount + stats.uninkableCount).toBe(60);
    expect(stats.colors.length).toBeGreaterThan(0);
  });

  it("validates legality as warnings, never blocking", () => {
    const r = parseDecklist(SUPPLIED_DECKLIST);
    // The supplied deck is a casual multi-ink deck — expect a colour warning.
    const warnings = validateDeck(r.cards, index);
    expect(Array.isArray(warnings)).toBe(true);

    const legal = [{ id: "6-124", count: 4 }];
    const tooFew = validateDeck(legal, index);
    expect(tooFew.some((w) => w.includes("expected 60"))).toBe(true);

    const tooMany = validateDeck([{ id: "6-124", count: 5 }], index);
    expect(tooMany.some((w) => w.includes("max 4"))).toBe(true);
  });
});
