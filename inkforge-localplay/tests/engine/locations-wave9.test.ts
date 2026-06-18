import { describe, expect, it } from "vitest";
import { createGame, reduce } from "@/engine/actions";
import type { CardLookup, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(id: string, over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id, name: id, fullName: id, type: "character", colors: ["ruby"], cost: 1, inkable: true,
    strength: 3, willpower: 3, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
    rulesText: "", rarity: "common", setNum: 1, cardNum: 1, ...over,
  };
}
function toPlay(lookup: CardLookup, seed = "w9"): GameState {
  let g = createGame({
    id: "g", seed, lookup,
    players: { 1: { name: "A", deck: Array.from({ length: 60 }, (_, i) => `1-a${i}`) }, 2: { name: "B", deck: Array.from({ length: 60 }, (_, i) => `1-b${i}`) } },
  });
  g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
  g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
  g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
  return g;
}

describe("Wave 9 — locations & challenge-ready", () => {
  it("a location generates its lore at the start of its controller's turn", () => {
    let g = toPlay((id) => printed(id));
    // Drop a location worth 2 lore onto P1's field.
    g.players[1].field.push({
      instanceId: "loc", printed: printed("loc", { type: "location", lore: 2, willpower: 5 }),
      damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [],
    });
    const before = g.players[1].lore;
    g = reduce(g, { type: "END_TURN" }).state; // P1 -> P2
    g = reduce(g, { type: "END_TURN" }).state; // P2 -> P1 (start fires location lore)
    expect(g.players[1].lore).toBe(before + 2);
  });

  it("Cinderella 'singing sword': the attacker may challenge a ready (unexerted) character", () => {
    const effects = { sword: [{ trigger: "on_play_song" as const, steps: [{ do: "grantChallengeReady" as const, to: "self" }] }] };
    let g = toPlay((id) => printed(id));
    const attacker = g.players[1].hand.shift()!;
    attacker.exerted = false; attacker.justPlayed = false; attacker.challengeReadyThisTurn = true;
    g.players[1].field.push(attacker);
    const readyDefender = g.players[2].hand.shift()!;
    readyDefender.exerted = false; // NOT exerted
    g.players[2].field.push(readyDefender);
    // Normally illegal, but challengeReadyThisTurn permits it.
    expect(() => reduce(g, { type: "ATTACK", attackerId: attacker.instanceId, defenderId: readyDefender.instanceId }, effects)).not.toThrow();
  });
});
