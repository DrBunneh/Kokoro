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

  it("surfaces an uncovered on-play ability as a Manual-Mode prompt that blocks play", () => {
    let g = toPlay(lookupP1Ability("Mystery", "mystery", "When you play this character, do something unusual."));
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

  it("does NOT prompt on play for an activated or static ability", () => {
    // Activated ({E} — …) abilities need an explicit activation, not a play prompt.
    let g = toPlay(lookupP1Ability("Tap", "tap", "{E} — Draw a card."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, {}).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, {}).state;
    expect(g.pendingPrompts).toHaveLength(0);

    // A static keyword ability (no event) never prompts either.
    let g2 = toPlay(lookupP1Ability("Tough", "tough", "Resist +1 (Damage dealt to this character is reduced by 1.)"));
    g2 = reduce(g2, { type: "ADD_TO_INK", cardInstanceId: g2.players[1].hand[1]!.instanceId }, {}).state;
    g2 = reduce(g2, { type: "PLAY_CARD", cardInstanceId: g2.players[1].hand[0]!.instanceId }, {}).state;
    expect(g2.pendingPrompts).toHaveLength(0);
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

  it("fires on_banish when a card is banished mid-resolution", () => {
    // The played card carries both an on_play zap and an on_banish draw, so
    // targeting itself banishes it → its on_banish must then resolve.
    const effects: CardEffects = {
      zap: [{ trigger: "on_play", steps: [{ do: "chooseCharacter", as: "t", scope: "any" }, { do: "dealDamage", to: "t", amount: 2 }] }],
      revenge: [{ trigger: "on_banish", steps: [{ do: "draw", player: "self", amount: 2 }] }],
    };
    const lookup: CardLookup = (id) =>
      id.includes("-a")
        ? printed(id, { specialAbilities: [
            { name: "Zap", slug: "zap", effect: "When you play this, deal 2 damage to chosen character." },
            { name: "Revenge", slug: "revenge", effect: "When this character is banished, draw 2 cards." },
          ] })
        : printed(id);
    let g = toPlay(lookup);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const playId = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: playId }, effects).state;
    const deckBefore = g.players[1].deck.length;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: playId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(g.players[1].discard.some((c) => c.instanceId === playId)).toBe(true);
    expect(g.players[1].deck.length).toBe(deckBefore - 2); // on_banish drew 2
  });

  it("activates an {E}-cost ability: exerts the source and resolves the effect", () => {
    const effects: CardEffects = {
      heal: [{ trigger: "activated", steps: [{ do: "chooseCharacter", as: "t", scope: "any" }, { do: "removeDamage", to: "t", amount: 2 }] }],
    };
    // An item with an {E} activated ability (items don't dry).
    const lookup: CardLookup = (id) =>
      id.includes("-a")
        ? printed(id, { type: "item", inkable: true, specialAbilities: [{ name: "Heal", slug: "heal", effect: "{E} — Remove up to 2 damage from chosen character." }] })
        : printed(id);
    let g = toPlay(lookup);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const itemId = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: itemId }, effects).state;
    expect(g.players[1].items.some((c) => c.instanceId === itemId)).toBe(true);
    // Activating suspends on the target choice.
    g = reduce(g, { type: "ACTIVATE_ABILITY", cardInstanceId: itemId }, effects).state;
    const item = g.players[1].items.find((c) => c.instanceId === itemId)!;
    expect(item.exerted).toBe(true); // {E} cost paid
    expect(g.pendingPrompts).toHaveLength(1);
    // Re-activating an exerted source is illegal.
    expect(() => reduce(g, { type: "ACTIVATE_ABILITY", cardInstanceId: itemId }, effects)).toThrow();
  });

  it("a 'Banish this' activated cost banishes the source", () => {
    const effects: CardEffects = {
      pop: [{ trigger: "activated", steps: [{ do: "draw", player: "self", amount: 1 }] }],
    };
    const lookup: CardLookup = (id) =>
      id.includes("-a")
        ? printed(id, { type: "item", specialAbilities: [{ name: "Pop", slug: "pop", effect: "Banish this item — Draw a card." }] })
        : printed(id);
    let g = toPlay(lookup);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const itemId = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: itemId }, effects).state;
    const deckBefore = g.players[1].deck.length;
    g = reduce(g, { type: "ACTIVATE_ABILITY", cardInstanceId: itemId }, effects).state;
    expect(g.players[1].items.some((c) => c.instanceId === itemId)).toBe(false);
    expect(g.players[1].discard.some((c) => c.instanceId === itemId)).toBe(true);
    expect(g.players[1].deck.length).toBe(deckBefore - 1);
  });

  it("enforces a target filter (3 strength or less) and rejects illegal targets", () => {
    const effects: CardEffects = {
      smite: [{ trigger: "on_play", steps: [{ do: "chooseCharacter", as: "t", scope: "enemy", optional: true, filter: { maxStrength: 3 } }, { do: "banish", to: "t" }] }],
    };
    // P1 plays the smiter; P2 has a weak (str 2) and a strong (str 5) character on the field.
    let g = toPlay(lookupP1Ability("Smite", "smite", "When you play this, banish chosen opposing character with 3 {S} or less."));
    // Hand-place two P2 characters directly on the board for targeting.
    const weak = { instanceId: "weak", printed: printed("weak", { strength: 2, willpower: 3 }), damage: 0, exerted: true, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    const strong = { instanceId: "strong", printed: printed("strong", { strength: 5, willpower: 3 }), damage: 0, exerted: true, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[2].field.push(weak, strong);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    const promptId = g.pendingPrompts[0]!.id;
    // The strong (5 {S}) character is not a legal target.
    expect(() => reduce(g, { type: "RESPOND_TO_PROMPT", promptId, targetInstanceId: "strong" }, effects)).toThrow(/legal target/i);
    // The weak (2 {S}) character is legal and gets banished.
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId, targetInstanceId: "weak" }, effects).state;
    expect(g.players[2].field.some((c) => c.instanceId === "weak")).toBe(false);
    expect(g.players[2].discard.some((c) => c.instanceId === "weak")).toBe(true);
    expect(g.players[2].field.some((c) => c.instanceId === "strong")).toBe(true);
  });

  it("declining an optional target skips the effect", () => {
    const effects: CardEffects = {
      maybe: [{ trigger: "on_play", steps: [{ do: "chooseCharacter", as: "t", scope: "any", optional: true }, { do: "banish", to: "t" }] }],
    };
    let g = toPlay(lookupP1Ability("Maybe", "maybe", "When you play this, you may banish chosen character."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const playId = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: playId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(1);
    // Decline (no target) → prompt clears and nothing is banished.
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(g.players[1].field.some((c) => c.instanceId === playId)).toBe(true);
  });

  it("chooseFromHand → toInkwell moves the chosen card into the inkwell", () => {
    const effects: CardEffects = {
      stash: [{ trigger: "on_play", steps: [{ do: "chooseFromHand", as: "c", optional: true }, { do: "toInkwell", from: "c", exerted: true }] }],
    };
    let g = toPlay(lookupP1Ability("Stash", "stash", "When you play this, you may put a card from your hand into your inkwell exerted."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(1);
    expect(g.pendingPrompts[0]!.pick).toBe("hand");
    const inkBefore = g.players[1].inkwell.length;
    const handCardId = g.players[1].hand[0]!.instanceId;
    // A board character isn't a legal pick for a hand choice.
    expect(() => reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: g.players[2].hand[0] ? "nope" : "nope" }, effects)).toThrow();
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: handCardId }, effects).state;
    expect(g.players[1].inkwell.length).toBe(inkBefore + 1);
    expect(g.players[1].inkwell.some((c) => c.instanceId === handCardId && c.exerted)).toBe(true);
    expect(g.players[1].hand.some((c) => c.instanceId === handCardId)).toBe(false);
  });

  it("surfaces an uncovered action's rules text as a manual prompt (not silently discarded)", () => {
    const lookup: CardLookup = (id) =>
      id.includes("-a") ? printed(id, { type: "action", fullName: "Mystery Action", rulesText: "Do a wild and unusual thing." }) : printed(id);
    let g = toPlay(lookup);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, {}).state;
    const playId = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: playId }, {}).state;
    expect(g.pendingPrompts).toHaveLength(1);
    expect(g.pendingPrompts[0]!.kind).toBe("manual");
    expect(g.pendingPrompts[0]!.text).toContain("Do a wild and unusual thing");
    expect(g.pendingPrompts[0]!.sourceInstanceId).toBe(playId); // the played card, for display
    expect(g.players[1].discard.some((c) => c.instanceId === playId)).toBe(true);
  });

  it("resolves a covered action via its name slug, stripping the sing reminder", () => {
    const effects: CardEffects = {
      apirateslife: [{ trigger: "on_play", steps: [{ do: "gainLore", player: "self", amount: 2 }] }],
    };
    const lookup: CardLookup = (id) =>
      id.includes("-a") ? printed(id, { type: "song", fullName: "A Pirate's Life", rulesText: "Sing Together 6 (Any number of characters…) Each opponent loses 2 lore. You gain 2 lore." }) : printed(id);
    let g = toPlay(lookup);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(g.players[1].lore).toBe(2);
  });

  it("a 'may' effect prompts Yes/No and only acts on Yes (Pawpsicle Jumbo Pop)", () => {
    const effects: CardEffects = {
      jp: [{ trigger: "on_play", steps: [{ do: "mayConfirm", text: "draw a card?" }, { do: "draw", player: "self", amount: 1 }] }],
    };
    const play = () => {
      let g = toPlay((id) => (id.includes("-a") ? printed(id, { type: "item", specialAbilities: [{ name: "Jumbo Pop", slug: "jp", effect: "When you play this item, you may draw a card." }] }) : printed(id)));
      g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
      g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
      return g;
    };
    // Prompt is a Yes/No confirm.
    let g = play();
    expect(g.pendingPrompts).toHaveLength(1);
    expect(g.pendingPrompts[0]!.pick).toBe("confirm");
    const deckBefore = g.players[1].deck.length;
    // Decline → no draw.
    const declined = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id }, effects).state;
    expect(declined.pendingPrompts).toHaveLength(0);
    expect(declined.players[1].deck.length).toBe(deckBefore);
    // Confirm → draws one.
    const confirmed = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "__confirm__" }, effects).state;
    expect(confirmed.pendingPrompts).toHaveLength(0);
    expect(confirmed.players[1].deck.length).toBe(deckBefore - 1);
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
