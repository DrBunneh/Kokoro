import { describe, expect, it } from "vitest";
import { createGame, reduce } from "@/engine/actions";
import type { CardLookup } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

const lookup: CardLookup = (id) => ({
  id, name: id, fullName: id, type: "character", colors: ["ruby"], cost: 1, inkable: true,
  strength: 1, willpower: 1, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
  rulesText: "", rarity: "common", setNum: 1, cardNum: 1,
}) satisfies PrintedCard;

// Same 60-card list for BOTH players (mirror match).
const deck = Array.from({ length: 60 }, (_, i) => `card-${i % 15}`);

describe("shuffle independence (mirror match)", () => {
  it("gives the two players different deck orders from one seed", () => {
    const g = createGame({ id: "g", seed: "fixed-seed", lookup, players: { 1: { name: "A", deck }, 2: { name: "B", deck } } });
    const p1 = g.players[1].deck.map((c) => c.printed.id);
    const p2 = g.players[2].deck.map((c) => c.printed.id);
    expect(p1).not.toEqual(p2);
  });

  it("gives the two opening hands different cards", () => {
    let g = createGame({ id: "g", seed: "abc", lookup, players: { 1: { name: "A", deck }, 2: { name: "B", deck } } });
    g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
    const h1 = g.players[1].hand.map((c) => c.printed.id).join(",");
    const h2 = g.players[2].hand.map((c) => c.printed.id).join(",");
    expect(h1).not.toEqual(h2);
  });
});
