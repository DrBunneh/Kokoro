import { describe, expect, it } from "vitest";
import { createGame, reduce } from "@/engine/actions";
import type { CardEffects } from "@/engine/effects/dsl";
import type { CardLookup, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(id: string, over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id, name: id, fullName: id, type: "character", colors: ["ruby"], cost: 1, inkable: true,
    strength: 3, willpower: 3, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
    rulesText: "", rarity: "common", setNum: 1, cardNum: 1, ...over,
  };
}
function toPlay(lookup: CardLookup, seed = "boost"): GameState {
  let g = createGame({
    id: "g", seed, lookup,
    players: { 1: { name: "A", deck: Array.from({ length: 60 }, (_, i) => `1-a${i}`) }, 2: { name: "B", deck: Array.from({ length: 60 }, (_, i) => `1-b${i}`) } },
  });
  g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
  g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
  g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
  return g;
}

describe("Boost + on_put_under", () => {
  it("Boost pays ink, tucks the top card under, and fires on_put_under once per turn", () => {
    const effects: CardEffects = {
      loads: [{ trigger: "on_put_under", steps: [{ do: "gainLore", player: "self", amount: 1 }] }],
    };
    const cheshire = printed("ch", {
      abilities: [{ ability: "Boost" }],
      rulesText: "Boost 2 {I} (pay 2 to put the top card under this character.) It's Loads of Fun ...",
      specialAbilities: [{ name: "It's Loads of Fun", slug: "loads", effect: "Whenever you put a card under this character, gain 1 lore." }],
    });
    let g = toPlay((id) => (id === "boostcard" ? cheshire : printed(id)));
    // Put Cheshire in play and give 2 ready ink.
    g.players[1].field.push({ instanceId: "ch1", printed: cheshire, damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    for (let i = 0; i < 2; i++) {
      const ink = g.players[1].hand.pop()!;
      ink.exerted = false;
      g.players[1].inkwell.push(ink);
    }
    const deckBefore = g.players[1].deck.length;
    g = reduce(g, { type: "ACTIVATE_ABILITY", cardInstanceId: "ch1", slug: "boost" }, effects).state;
    const ch = g.players[1].field.find((c) => c.instanceId === "ch1")!;
    expect(ch.cardsUnder).toHaveLength(1); // top card tucked under
    expect(g.players[1].deck.length).toBe(deckBefore - 1);
    expect(g.players[1].inkwell.filter((c) => c.exerted)).toHaveLength(2); // paid 2
    expect(g.players[1].lore).toBe(1); // on_put_under fired
    // Second Boost in the same turn is rejected (once per turn).
    expect(() => reduce(g, { type: "ACTIVATE_ABILITY", cardInstanceId: "ch1", slug: "boost" }, effects)).toThrow(/boost/i);
  });
});
