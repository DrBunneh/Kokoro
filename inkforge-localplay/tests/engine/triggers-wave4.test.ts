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
function toPlay(lookup: CardLookup, seed = "w4"): GameState {
  let g = createGame({
    id: "g", seed, lookup,
    players: { 1: { name: "A", deck: Array.from({ length: 60 }, (_, i) => `1-a${i}`) }, 2: { name: "B", deck: Array.from({ length: 60 }, (_, i) => `1-b${i}`) } },
  });
  g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
  g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
  g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
  return g;
}

describe("Wave 4 — new triggers", () => {
  it("on_play_cheap fires for a permanent in play when a ≤2 card is played (and not for the played card itself)", () => {
    const effects: CardEffects = { gravy: [{ trigger: "on_play_cheap", steps: [{ do: "gainLore", player: "self", amount: 1 }] }] };
    const lookup: CardLookup = (id) =>
      id.includes("-a") ? printed(id, { cost: 1, specialAbilities: [{ name: "Gravy", slug: "gravy", effect: "Whenever you pay 2 {I} or less to play a card, gain 1 lore." }] }) : printed(id);
    let g = toPlay(lookup);
    // Put a watcher (carrying the cheap-play trigger) directly into play.
    const watcher = g.players[1].hand.shift()!;
    watcher.justPlayed = false;
    g.players[1].field.push(watcher);
    // One ready ink to pay for a cost-1 card.
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    // Watcher fires once; the just-played card does NOT trigger its own copy.
    expect(g.players[1].lore).toBe(1);
  });

  it("on_ally_challenged: an exerted watcher debuffs the challenging attacker", () => {
    const effects: CardEffects = {
      tiana: [{ trigger: "on_ally_challenged", when: { selfExerted: true }, steps: [{ do: "debuff", to: "challenger", strength: 3, duration: "end_of_turn" }] }],
    };
    const lookup: CardLookup = (id) =>
      id.includes("-a")
        ? printed(id, { strength: 4, willpower: 4, specialAbilities: [{ name: "Tiana", slug: "tiana", effect: "Whenever a character of yours is challenged while this character is exerted, the challenging character gets -3 {S} this turn." }] })
        : printed(id, { strength: 4, willpower: 6 });
    let g = toPlay(lookup);
    // P2 is the defender's controller: place an exerted watcher + an exerted defender.
    const watcher = g.players[1].hand.shift()!; watcher.exerted = true; watcher.justPlayed = false;
    const defender = g.players[1].hand.shift()!; defender.exerted = true; defender.justPlayed = false;
    g.players[1].field.push(watcher, defender);
    // P2 (current player after we flip) attacks. Simplest: make P1 current and attack P2…
    // Instead, set P2 as attacker's owner.
    const attacker = g.players[2].hand.shift()!; attacker.exerted = false; attacker.justPlayed = false;
    g.players[2].field.push(attacker);
    g.currentPlayer = 2;
    g = reduce(g, { type: "ATTACK", attackerId: attacker.instanceId, defenderId: defender.instanceId }, effects).state;
    // Watcher (exerted, P1) debuffs the attacker by 3 → its applied effect is present.
    const atkNow = g.players[2].field.find((c) => c.instanceId === attacker.instanceId)!;
    expect(atkNow.appliedEffects.some((e) => e.strength === -3)).toBe(true);
  });

  it("on_challenge_banish fires for the attacker when it banishes the defender", () => {
    const effects: CardEffects = { winner: [{ trigger: "on_challenge_banish", steps: [{ do: "gainLore", player: "self", amount: 2 }] }] };
    const lookup: CardLookup = (id) =>
      id.includes("-a")
        ? printed(id, { strength: 5, willpower: 5, specialAbilities: [{ name: "Winner", slug: "winner", effect: "Whenever this character banishes another character in a challenge, gain 2 lore." }] })
        : printed(id, { strength: 1, willpower: 1 });
    let g = toPlay(lookup);
    // Hand-place an attacker for P1 (ready) and an exerted weak defender for P2.
    const atk = g.players[1].hand.shift()!;
    atk.justPlayed = false; atk.exerted = false;
    g.players[1].field.push(atk);
    const def = g.players[2].hand.shift()!;
    def.exerted = true;
    g.players[2].field.push(def);
    g = reduce(g, { type: "ATTACK", attackerId: atk.instanceId, defenderId: def.instanceId }, effects).state;
    // Defender (willpower 1) takes 5 → banished; attacker survives → +2 lore.
    expect(g.players[2].field).toHaveLength(0);
    expect(g.players[1].lore).toBe(2);
  });
});
