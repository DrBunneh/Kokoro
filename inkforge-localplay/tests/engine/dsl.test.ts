import { describe, expect, it } from "vitest";
import { createGame, reduce } from "@/engine/actions";
import type { CardEffects } from "@/engine/effects/dsl";
import type { CardLookup, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(id: string, over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id, name: id, fullName: id, type: "character", colors: ["ruby"], cost: 1, inkable: true,
    strength: 1, willpower: 1, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
    rulesText: "", rarity: "common", setNum: 1, cardNum: 1, ...over,
  };
}

/** P1's cards all carry the given special ability so the opening hand has it. */
function lookupP1Ability(name: string, slug: string, effect: string): CardLookup {
  return (id) => (id.includes("-a") ? printed(id, { specialAbilities: [{ name, slug, effect }] }) : printed(id));
}

function toPlay(lookup: CardLookup, seed = "dsl"): GameState {
  let g = createGame({
    id: "g", seed, lookup,
    players: { 1: { name: "A", deck: Array.from({ length: 60 }, (_, i) => `1-a${i}`) }, 2: { name: "B", deck: Array.from({ length: 60 }, (_, i) => `1-b${i}`) } },
  });
  g = reduce(g, { type: "CHOOSE_STARTING_PLAYER", player: 1 }).state;
  g = reduce(g, { type: "MULLIGAN", player: 1, cardInstanceIds: [] }).state;
  g = reduce(g, { type: "MULLIGAN", player: 2, cardInstanceIds: [] }).state;
  return g;
}

describe("Effect DSL + the bag", () => {
  it("auto-resolves a no-choice on_play effect (draw)", () => {
    const effects: CardEffects = { drawer: [{ trigger: "on_play", steps: [{ do: "draw", player: "self", amount: 1 }] }] };
    let g = toPlay(lookupP1Ability("Drawer", "drawer", "When you play this, draw a card."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const deckBefore = g.players[1].deck.length;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(g.players[1].deck.length).toBe(deckBefore - 1); // the auto draw
  });

  it("surfaces an uncovered ability as a Manual-Mode prompt that blocks play", () => {
    let g = toPlay(lookupP1Ability("Mystery", "mystery", "Do something unusual."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, {}).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, {}).state;
    expect(g.pendingPrompts).toHaveLength(1);
    expect(g.pendingPrompts[0]!.kind).toBe("manual");
    // The bag blocks normal actions until resolved.
    expect(() => reduce(g, { type: "END_TURN" }, {})).toThrow(/pending/i);
    const promptId = g.pendingPrompts[0]!.id;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId }, {}).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(() => reduce(g, { type: "END_TURN" }, {})).not.toThrow();
  });

  it("pushes a choice prompt for a targeted effect, then resolves on target", () => {
    const effects: CardEffects = {
      zap: [{ trigger: "on_play", steps: [{ do: "chooseCharacter", as: "t", scope: "any" }, { do: "dealDamage", to: "t", amount: 2 }] }],
    };
    let g = toPlay(lookupP1Ability("Zap", "zap", "Deal 2 damage to chosen character."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const playId = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: playId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(1);
    expect(g.pendingPrompts[0]!.resume).toBeDefined();
    // Resolve against the just-played character itself → 2 damage applied.
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: playId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    // 2 damage to a willpower-1 character banishes it (proves the step resolved).
    expect(g.players[1].field.some((c) => c.instanceId === playId)).toBe(false);
    expect(g.players[1].discard.some((c) => c.instanceId === playId)).toBe(true);
  });

  it("MANUAL_ADJUST edits damage and lore (recorded as a normal action)", () => {
    let g = toPlay((id) => printed(id)); // no abilities
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }).state;
    const played = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: played }).state;
    g = reduce(g, {
      type: "MANUAL_ADJUST",
      ops: [
        { kind: "setDamage", instanceId: played, value: 1 },
        { kind: "setLore", player: 1, value: 5 },
      ],
    }).state;
    expect(g.players[1].field.find((c) => c.instanceId === played)!.damage).toBe(1);
    expect(g.players[1].lore).toBe(5);
  });
});
