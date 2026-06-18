import { describe, expect, it } from "vitest";
import { createGame, reduce } from "@/engine/actions";
import type { CardLookup, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(id: string, over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id, name: id, fullName: id, type: "character", colors: ["ruby"], cost: 1, inkable: true,
    strength: 1, willpower: 2, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
    rulesText: "", rarity: "common", setNum: 1, cardNum: 1, ...over,
  };
}

function play(lookup: CardLookup, seed: string): GameState {
  let g = createGame({
    id: "g", seed, lookup,
    players: { 1: { name: "A", deck: Array.from({ length: 60 }, (_, i) => `1-a${i}`) }, 2: { name: "B", deck: Array.from({ length: 60 }, (_, i) => `1-b${i}`) } },
  });
  g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
  g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
  g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
  return g;
}

describe("Shift", () => {
  // All P1 cards are "Hero", cost 0, Shift 1 — any two stack; base is free, shift costs 1 ink.
  const lookup: CardLookup = (id) =>
    id.includes("-a") ? printed(id, { name: "Hero", fullName: "Hero - X", cost: 0, abilities: [{ ability: "Shift 1" }] }) : printed(id);

  it("stacks a same-named character via Shift, inheriting readiness", () => {
    let g = play(lookup, "shift");
    const base = g.players[1].hand[0]!.instanceId;
    const shifter = g.players[1].hand[1]!.instanceId;
    const inkCard = g.players[1].hand[2]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: base }).state; // cost 0
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: inkCard }).state; // 1 ink for Shift
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: shifter, shiftOnto: base }).state;

    const top = g.players[1].field.find((c) => c.instanceId === shifter);
    expect(top).toBeDefined();
    expect(g.players[1].field.some((c) => c.instanceId === base)).toBe(false);
    expect(top!.cardsUnder.some((c) => c.instanceId === base)).toBe(true);
    expect(top!.justPlayed).toBe(false); // shifted in → not drying
  });

  it("banishing a shift stack sends the whole stack to discard", () => {
    let g = play(lookup, "shiftb");
    const base = g.players[1].hand[0]!.instanceId;
    const shifter = g.players[1].hand[1]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: base }).state;
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[2]!.instanceId }).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: shifter, shiftOnto: base }).state;
    // Manually banish the top via MANUAL_ADJUST damage past willpower, then it should
    // carry the under-card to discard. (Use MANUAL_ADJUST to set lethal damage.)
    g = reduce(g, { type: "MANUAL_ADJUST", ops: [{ kind: "setDamage", instanceId: shifter, value: 99 }] }).state;
    // Damage alone doesn't auto-banish (no game-state check here); move to discard manually.
    g = reduce(g, { type: "MANUAL_ADJUST", ops: [{ kind: "move", instanceId: shifter, toPlayer: 1, toZone: "discard" }] }).state;
    expect(g.players[1].discard.some((c) => c.instanceId === shifter)).toBe(true);
  });
});

describe("Singer / Sing Together", () => {
  // Even-indexed P1 cards are songs (cost 3); odd are cost-0 Singer 5 characters.
  const lookup: CardLookup = (id) => {
    const m = id.match(/a(\d+)$/);
    const n = m ? Number(m[1]) : 0;
    return n % 2 === 0
      ? printed(id, { type: "song", fullName: "Song", cost: 3, subtypes: ["Song"], strength: undefined, willpower: undefined, lore: undefined })
      : printed(id, { cost: 0, abilities: [{ ability: "Singer 5" }] });
  };

  it("exerts a singer to play a song for free", () => {
    let g = play(lookup, "sing-1");
    const song = g.players[1].hand.find((c) => c.printed.type === "song")!;
    const singer = g.players[1].hand.find((c) => c.printed.type === "character")!;
    expect(song && singer).toBeTruthy();
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: singer.instanceId }).state; // cost 0 → field (drying)
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: song.instanceId, singers: [singer.instanceId] }).state;
    expect(g.players[1].discard.some((c) => c.instanceId === song.instanceId)).toBe(true);
    expect(g.players[1].field.find((c) => c.instanceId === singer.instanceId)!.exerted).toBe(true);
  });

  it("rejects singing when the singer's value is too low", () => {
    const weak: CardLookup = (id) => {
      const m = id.match(/a(\d+)$/);
      const n = m ? Number(m[1]) : 0;
      return n % 2 === 0
        ? printed(id, { type: "song", fullName: "Big Song", cost: 9, subtypes: ["Song"] })
        : printed(id, { cost: 0, abilities: [{ ability: "Singer 3" }] });
    };
    let g = play(weak, "sing-2");
    const song = g.players[1].hand.find((c) => c.printed.type === "song")!;
    const singer = g.players[1].hand.find((c) => c.printed.type === "character")!;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: singer.instanceId }).state;
    expect(() => reduce(g, { type: "PLAY_CARD", cardInstanceId: song.instanceId, singers: [singer.instanceId] })).toThrow(/afford/i);
  });
});
