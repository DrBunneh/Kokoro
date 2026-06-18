import { describe, expect, it } from "vitest";
import { createGame, reduce } from "@/engine/actions";
import { keywordValue } from "@/engine/keywords";
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

  it("scry (lookAtTop): keeps the chosen card, sends the rest to the bottom", () => {
    const effects: CardEffects = {
      scry: [{ trigger: "on_play", steps: [{ do: "lookAtTop", count: 2, rest: "bottom" }] }],
    };
    let g = toPlay(lookupP1Ability("Scry", "scry", "Look at the top 2 cards. Put one into your hand and the other on the bottom."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(1);
    expect(g.pendingPrompts[0]!.pick).toBe("deck");
    expect(g.pendingPrompts[0]!.reveal).toHaveLength(2);
    const [topId, secondId] = g.pendingPrompts[0]!.reveal!;
    const handBefore = g.players[1].hand.length;
    const deckBefore = g.players[1].deck.length;
    // Keep the second revealed card.
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: secondId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(g.players[1].hand.some((c) => c.instanceId === secondId)).toBe(true);
    expect(g.players[1].hand.length).toBe(handBefore + 1);
    // The other revealed card went to the bottom of the deck.
    expect(g.players[1].deck.at(-1)!.instanceId).toBe(topId);
    expect(g.players[1].deck.length).toBe(deckBefore - 1); // one moved to hand
  });

  it("scry to inkwell (How Far I'll Go variant) puts the rest in the inkwell exerted", () => {
    const effects: CardEffects = {
      sing: [{ trigger: "on_play", steps: [{ do: "lookAtTop", count: 2, rest: "inkwellExerted" }] }],
    };
    let g = toPlay(lookupP1Ability("Sing", "sing", "Look at the top 2 cards. Put one into your hand and the other into your inkwell exerted."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const inkBefore = g.players[1].inkwell.length;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    const keepId = g.pendingPrompts[0]!.reveal![0]!;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: keepId }, effects).state;
    expect(g.players[1].hand.some((c) => c.instanceId === keepId)).toBe(true);
    expect(g.players[1].inkwell.length).toBe(inkBefore + 1);
    expect(g.players[1].inkwell.at(-1)!.exerted).toBe(true);
  });

  it("banishAll (Be Prepared) banishes every character on both sides", () => {
    const effects: CardEffects = {
      wipe: [{ trigger: "on_play", steps: [{ do: "banishAll", scope: "any" }] }],
    };
    let g = toPlay(lookupP1Ability("Wipe", "wipe", "Banish all characters."));
    const mine = { instanceId: "m1", printed: printed("m1", { willpower: 3 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    const theirs = { instanceId: "t1", printed: printed("t1", { willpower: 3 }), damage: 0, exerted: true, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[1].field.push(mine);
    g.players[2].field.push(theirs);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.players[1].field).toHaveLength(0);
    expect(g.players[2].field).toHaveLength(0);
    expect(g.players[1].discard.some((c) => c.instanceId === "m1")).toBe(true);
    expect(g.players[2].discard.some((c) => c.instanceId === "t1")).toBe(true);
  });

  it("resolves seeded action slugs via the synthetic ability path (Brawl)", () => {
    // Brawl: banish chosen character with 2 strength or less (filter enforced).
    const effects: CardEffects = {
      brawl: [{ trigger: "on_play", steps: [{ do: "chooseCharacter", as: "t", scope: "any", optional: true, filter: { maxStrength: 2 } }, { do: "banish", to: "t" }] }],
    };
    const lookup: CardLookup = (id) =>
      id.includes("-a") ? printed(id, { type: "action", fullName: "Brawl", rulesText: "Banish chosen character with 2 {S} or less." }) : printed(id);
    let g = toPlay(lookup);
    const weak = { instanceId: "weak", printed: printed("weak", { strength: 2, willpower: 4 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    const strong = { instanceId: "strong", printed: printed("strong", { strength: 5, willpower: 4 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[2].field.push(weak, strong);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts[0]!.pick).toBe("character");
    expect(() => reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "strong" }, effects)).toThrow(/legal target/i);
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "weak" }, effects).state;
    expect(g.players[2].discard.some((c) => c.instanceId === "weak")).toBe(true);
  });

  it("filtered scry: only a matching card may be kept; non-matching is rejected", () => {
    const effects: CardEffects = {
      reveal: [{ trigger: "on_play", steps: [{ do: "lookAtTop", count: 3, rest: "bottom", optional: true, filter: { cardType: "song" } }] }],
    };
    // Stack the top of P1's deck: [character, song, character] by instanceId.
    const lookup: CardLookup = (id) => {
      if (id === "1-aSONG") return printed(id, { type: "song", inkable: false });
      return id.includes("-a") ? printed(id, { specialAbilities: [{ name: "Reveal", slug: "reveal", effect: "Look at the top 3, you may reveal a song." }] }) : printed(id);
    };
    let g = toPlay(lookup);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    // Force a known top-of-deck order with one song in the middle.
    const deck = g.players[1].deck;
    const song = deck.find((c) => c.printed.type === "song") ?? deck[1]!;
    // Move the song to slot 1 so it's within the top 3.
    g.players[1].deck = [deck[0]!, song, ...deck.filter((c) => c !== deck[0] && c !== song)];
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts[0]!.pick).toBe("deck");
    const reveal = g.pendingPrompts[0]!.reveal!;
    const nonSong = reveal.find((id) => g.players[1].deck.find((c) => c.instanceId === id)!.printed.type !== "song")!;
    // A non-song can't be kept.
    expect(() => reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: nonSong }, effects)).toThrow(/valid card to keep/i);
    // Declining is allowed (optional) — nothing kept, top cards go to bottom.
    const handBefore = g.players[1].hand.length;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(g.players[1].hand.length).toBe(handBefore); // kept nothing
  });

  it("cost reduction: grantDiscount lowers the next matching play, once", () => {
    const effects: CardEffects = {
      cheaper: [{ trigger: "on_play", steps: [{ do: "grantDiscount", amount: 2, cardType: "character", uses: 1 }] }],
    };
    // Deck cards are plain cost-3 characters; the discounter item is injected.
    const lookup: CardLookup = (id) => printed(id, { type: "character", cost: 3, willpower: 3 });
    let g = toPlay(lookup);
    // Give the player plenty of ready ink, plus the discounter item in hand.
    g.players[1].inkwell = Array.from({ length: 6 }, (_, j) => ({ instanceId: `ink${j}`, printed: printed(`ink${j}`), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] }));
    g.players[1].hand.push({ instanceId: "disc", printed: printed("disc", { type: "item", cost: 1, specialAbilities: [{ name: "Cheaper", slug: "cheaper", effect: "You pay 2 less for the next character." }] }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: "disc" }, effects).state;
    expect(g.players[1].discounts).toHaveLength(1);
    const readyBefore = g.players[1].inkwell.filter((c) => !c.exerted).length;
    const charId = g.players[1].hand.find((c) => c.printed.type === "character")!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: charId }, effects).state;
    // Character costs 3, discounted to 1 → only 1 ink exerted, discount consumed.
    expect(g.players[1].inkwell.filter((c) => !c.exerted).length).toBe(readyBefore - 1);
    expect(g.players[1].discounts).toHaveLength(0);
  });

  it("AoE damage (dealDamageAll) hits and banishes all enemy characters", () => {
    const effects: CardEffects = {
      quake: [{ trigger: "on_play", steps: [{ do: "dealDamageAll", scope: "enemy", amount: 2 }] }],
    };
    let g = toPlay(lookupP1Ability("Quake", "quake", "Deal 2 damage to each opposing character."));
    const a = { instanceId: "ea", printed: printed("ea", { willpower: 2 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    const b = { instanceId: "eb", printed: printed("eb", { willpower: 5 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[2].field.push(a, b);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.players[2].field.some((c) => c.instanceId === "ea")).toBe(false); // 2 dmg ≥ 2 wp → banished
    expect(g.players[2].field.find((c) => c.instanceId === "eb")!.damage).toBe(2); // survives
  });

  it("count-based damage scales with your characters in play", () => {
    const effects: CardEffects = {
      blaze: [{ trigger: "on_play", steps: [
        { do: "chooseCharacter", as: "t", scope: "any", optional: true },
        { do: "dealDamage", to: "t", amountPer: { scope: "ally" } },
      ] }],
    };
    let g = toPlay(lookupP1Ability("Blaze", "blaze", "Deal damage equal to your character count."));
    // Two ally characters already in play → amount should be 2.
    g.players[1].field.push(
      { instanceId: "m1", printed: printed("m1"), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] },
      { instanceId: "m2", printed: printed("m2"), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] },
    );
    const victim = { instanceId: "v", printed: printed("v", { willpower: 9 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[2].field.push(victim);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "v" }, effects).state;
    // Two pre-existing allies + the just-played source character = 3 in play.
    expect(g.players[2].field.find((c) => c.instanceId === "v")!.damage).toBe(3);
  });

  it("buffAll excludes the source and lasts until end of turn", () => {
    const effects: CardEffects = {
      rally: [{ trigger: "on_play", steps: [{ do: "buffAll", scope: "ally", strength: 3, excludeSelf: true, duration: "end_of_turn" }] }],
    };
    let g = toPlay(lookupP1Ability("Rally", "rally", "Your other characters get +3 this turn."));
    const ally = { instanceId: "ally1", printed: printed("ally1", { strength: 1 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[1].field.push(ally);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    const buffed = g.players[1].field.find((c) => c.instanceId === "ally1")!;
    expect(buffed.appliedEffects.some((e) => e.strength === 3)).toBe(true);
    // The just-played source got no buff (excludeSelf).
    const source = g.players[1].field.find((c) => c.instanceId !== "ally1")!;
    expect(source.appliedEffects.some((e) => e.strength === 3)).toBe(false);
  });

  it("forced discard: caster picks a filtered card from the opponent's hand", () => {
    const effects: CardEffects = {
      mindrot: [{ trigger: "on_play", steps: [
        { do: "chooseFromHand", as: "d", from: "opponent", excludeCardType: "character", optional: true },
        { do: "discardCard", from: "d" },
      ] }],
    };
    let g = toPlay(lookupP1Ability("Mindrot", "mindrot", "Opponent discards a non-character of your choice."));
    // Put a known character + a known action in P2's hand.
    const char = { instanceId: "ohchar", printed: printed("ohchar", { type: "character" }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    const action = { instanceId: "ohact", printed: printed("ohact", { type: "action" }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[2].hand.push(char, action);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts[0]!.pick).toBe("hand");
    expect(g.pendingPrompts[0]!.handOwner).toBe(2); // choosing from P2's hand
    // A character isn't a legal pick (excludeCardType).
    expect(() => reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "ohchar" }, effects)).toThrow(/valid card/i);
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "ohact" }, effects).state;
    expect(g.players[2].discard.some((c) => c.instanceId === "ohact")).toBe(true);
    expect(g.players[2].hand.some((c) => c.instanceId === "ohchar")).toBe(true);
  });

  it("opponentDiscard prompts the opponent to discard their own choice", () => {
    const effects: CardEffects = {
      forget: [{ trigger: "on_play", steps: [{ do: "opponentDiscard", amount: 2 }] }],
    };
    let g = toPlay(lookupP1Ability("Forget", "forget", "Each opponent discards 2 cards."));
    const p2HandBefore = g.players[2].hand.length;
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    // The prompt is directed at player 2 (they choose their own cards).
    expect(g.pendingPrompts[0]!.player).toBe(2);
    expect(g.pendingPrompts[0]!.handOwner).toBe(2);
    // P2 discards two of their own, one at a time.
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: g.players[2].hand[0]!.instanceId }, effects).state;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: g.players[2].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts).toHaveLength(0);
    expect(g.players[2].hand.length).toBe(p2HandBefore - 2);
    expect(g.players[2].discard.length).toBe(2);
  });

  it("grantKeyword adds Challenger for the turn (read by keywordValue)", () => {
    const effects: CardEffects = {
      pump: [{ trigger: "on_play", steps: [{ do: "chooseCharacter", as: "t", scope: "any", optional: true }, { do: "grantKeyword", to: "t", keyword: "Challenger", value: 3, duration: "end_of_turn" }] }],
    };
    let g = toPlay(lookupP1Ability("Pump", "pump", "Chosen character gains Challenger +3."));
    const ally = { instanceId: "al", printed: printed("al"), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[1].field.push(ally);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "al" }, effects).state;
    expect(keywordValue(g.players[1].field.find((c) => c.instanceId === "al")!, "Challenger")).toBe(3);
  });

  it("returnFromDiscard pulls a filtered card back to hand", () => {
    const effects: CardEffects = {
      recur: [{ trigger: "on_play", steps: [{ do: "returnFromDiscard", cardType: "item", keepUpTo: 1, optional: true }] }],
    };
    let g = toPlay(lookupP1Ability("Recur", "recur", "Return an item from your discard."));
    g.players[1].discard.push(
      { instanceId: "ditem", printed: printed("ditem", { type: "item" }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] },
      { instanceId: "dchar", printed: printed("dchar", { type: "character" }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] },
    );
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts[0]!.pick).toBe("discard");
    expect(g.pendingPrompts[0]!.reveal).toEqual(["ditem"]); // only the item is offered
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "ditem" }, effects).state;
    expect(g.players[1].hand.some((c) => c.instanceId === "ditem")).toBe(true);
    expect(g.players[1].discard.some((c) => c.instanceId === "ditem")).toBe(false);
  });

  it("chooseItem + banish removes a chosen item", () => {
    const effects: CardEffects = {
      smash: [{ trigger: "on_play", steps: [{ do: "chooseItem", as: "it", scope: "any", optional: true }, { do: "banish", to: "it" }] }],
    };
    let g = toPlay(lookupP1Ability("Smash", "smash", "Banish chosen item."));
    g.players[2].items.push({ instanceId: "anitem", printed: printed("anitem", { type: "item" }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts[0]!.pick).toBe("item");
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "anitem" }, effects).state;
    expect(g.players[2].items.some((c) => c.instanceId === "anitem")).toBe(false);
    expect(g.players[2].discard.some((c) => c.instanceId === "anitem")).toBe(true);
  });

  it("lockout stops the opponent from playing actions until the caster's next turn", () => {
    const effects: CardEffects = { hush: [{ trigger: "on_play", steps: [{ do: "lockout", items: false }] }] };
    let g = toPlay(lookupP1Ability("Hush", "hush", "Opponents can't play actions."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.lockout?.caster).toBe(1);
    g = reduce(g, { type: "END_TURN" }, effects).state; // now player 2's turn
    // Give P2 ink and an action in hand.
    g.players[2].inkwell = [{ instanceId: "i", printed: printed("i"), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] }];
    g.players[2].hand.push({ instanceId: "act", printed: printed("act", { type: "action", cost: 1 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    expect(() => reduce(g, { type: "PLAY_CARD", cardInstanceId: "act" }, effects)).toThrow(/can't play actions/i);
  });

  it("grantExtraInk allows a second inking this turn", () => {
    const effects: CardEffects = { sail: [{ trigger: "on_play", steps: [{ do: "grantExtraInk", amount: 1 }, { do: "draw", player: "self", amount: 1 }] }] };
    let g = toPlay((id) => printed(id, { inkable: true }));
    // Ink once normally, then a second ink is rejected.
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(() => reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects)).toThrow(/already inked/i);
    // Inject + play a Sail action that grants an extra ink; give ready ink for its cost.
    g.players[1].inkwell.push({ instanceId: "rdy", printed: printed("rdy"), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    g.players[1].hand.push({ instanceId: "sail", printed: printed("sail", { type: "action", cost: 1, specialAbilities: [{ name: "Sail", slug: "sail", effect: "ink extra, draw" }] }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: "sail" }, effects).state;
    expect(g.players[1].extraInk).toBe(1);
    // Now a second ink is allowed and consumes the bonus.
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.players[1].extraInk).toBe(0);
  });

  it("modal 'choose one' runs the picked branch", () => {
    const effects: CardEffects = {
      lever: [{ trigger: "on_play", steps: [{ do: "modal", options: [
        { label: "Draw 2", steps: [{ do: "draw", player: "self", amount: 2 }] },
        { label: "Opp discards", steps: [{ do: "opponentDiscard", amount: 1 }] },
      ] }] }],
    };
    let g = toPlay(lookupP1Ability("Lever", "lever", "Choose one."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.pendingPrompts[0]!.pick).toBe("mode");
    expect(g.pendingPrompts[0]!.modes).toEqual(["Draw 2", "Opp discards"]);
    const deckBefore = g.players[1].deck.length;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "0" }, effects).state;
    expect(g.players[1].deck.length).toBe(deckBefore - 2); // drew 2
    expect(g.pendingPrompts).toHaveLength(0);
  });

  it("toBottomAll bottoms all matching enemy characters (Under the Sea)", () => {
    const effects: CardEffects = { wave: [{ trigger: "on_play", steps: [{ do: "toBottomAll", scope: "enemy", maxStrength: 2 }] }] };
    let g = toPlay(lookupP1Ability("Wave", "wave", "Bottom all opposing with 2 strength or less."));
    const weak = { instanceId: "w", printed: printed("w", { strength: 1 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    const big = { instanceId: "b", printed: printed("b", { strength: 5 }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[2].field.push(weak, big);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.players[2].field.some((c) => c.instanceId === "w")).toBe(false);
    expect(g.players[2].deck.some((c) => c.instanceId === "w")).toBe(true);
    expect(g.players[2].field.some((c) => c.instanceId === "b")).toBe(true); // 5 str stays
  });

  it("condition gate: an effect only fires when its 'when' holds", () => {
    const effects: CardEffects = {
      gated: [{ trigger: "on_play", when: { discardedAtLeast: 2 }, steps: [{ do: "gainLore", player: "self", amount: 3 }] }],
    };
    // No discards this turn → gate fails → no lore, no prompt.
    let g = toPlay(lookupP1Ability("Gated", "gated", "If 2+ discarded, gain 3 lore."));
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.players[1].lore).toBe(0);
    expect(g.pendingPrompts).toHaveLength(0);
  });

  it("on_play_action fires your other characters' triggers (Wayfinding)", () => {
    const effects: CardEffects = {
      wf: [{ trigger: "on_play_action", steps: [{ do: "gainLore", player: "self", amount: 1 }] }],
      zap: [{ trigger: "on_play", steps: [{ do: "draw", player: "self", amount: 1 }] }],
    };
    // A character with Wayfinding is already in play.
    let g = toPlay((id) => printed(id, { type: "action", inkable: true, specialAbilities: [{ name: "Zap", slug: "zap", effect: "When you play this, draw." }] }));
    const maui = { instanceId: "maui", printed: printed("maui", { specialAbilities: [{ name: "Wayfinding", slug: "wf", effect: "Whenever you play an action, gain 1 lore." }] }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[1].field.push(maui);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    const loreBefore = g.players[1].lore;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    expect(g.players[1].lore).toBe(loreBefore + 1); // Wayfinding fired on the action
  });

  it("end_of_turn triggers fire and hold the turn for resolution", () => {
    const effects: CardEffects = {
      eot: [{ trigger: "end_of_turn", steps: [{ do: "gainLore", player: "self", amount: 1 }] }],
    };
    let g = toPlay((id) => printed(id, { specialAbilities: [{ name: "Eot", slug: "eot", effect: "At the end of your turn, gain 1 lore." }] }));
    // Put the character in play, then end the turn.
    g.players[1].field.push({ instanceId: "eotc", printed: printed("eotc", { specialAbilities: [{ name: "Eot", slug: "eot", effect: "At end of turn, gain 1 lore." }] }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    const loreBefore = g.players[1].lore;
    g = reduce(g, { type: "END_TURN" }, effects).state;
    expect(g.players[1].lore).toBe(loreBefore + 1); // end-of-turn gain resolved
    expect(g.currentPlayer).toBe(2); // turn advanced (no prompt needed)
  });

  it("self-cost reduction lowers a card's own cost (About Time)", () => {
    const effects: CardEffects = { abouttime: [{ trigger: "cost", reducePer: "actionInDiscard" }] };
    const lookup: CardLookup = (id) => printed(id, { type: "character", cost: 5, willpower: 3, specialAbilities: [{ name: "About Time", slug: "abouttime", effect: "For each action in your discard, pay 1 less." }] });
    let g = toPlay(lookup);
    // Two actions in discard → pay 2 less → cost 3.
    g.players[1].discard.push(
      { instanceId: "a1", printed: printed("a1", { type: "action" }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] },
      { instanceId: "a2", printed: printed("a2", { type: "action" }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] },
    );
    g.players[1].inkwell = Array.from({ length: 5 }, (_, j) => ({ instanceId: `ink${j}`, printed: printed(`ink${j}`), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] }));
    const cardId = g.players[1].hand[0]!.instanceId;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: cardId }, effects).state;
    expect(g.players[1].inkwell.filter((c) => !c.exerted).length).toBe(2); // 5 - 3 cost
  });

  it("removeDamageDraw heals and draws per damage removed (Rapunzel)", () => {
    const effects: CardEffects = { heal: [{ trigger: "on_play", steps: [{ do: "chooseCharacter", as: "t", scope: "ally", optional: true }, { do: "removeDamageDraw", to: "t", amount: 3 }] }] };
    let g = toPlay(lookupP1Ability("Heal", "heal", "Remove up to 3 damage; draw per damage removed."));
    const ally = { instanceId: "hurt", printed: printed("hurt", { willpower: 9 }), damage: 2, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] };
    g.players[1].field.push(ally);
    g = reduce(g, { type: "ADD_TO_INK", cardInstanceId: g.players[1].hand[1]!.instanceId }, effects).state;
    g = reduce(g, { type: "PLAY_CARD", cardInstanceId: g.players[1].hand[0]!.instanceId }, effects).state;
    const deckBefore = g.players[1].deck.length;
    g = reduce(g, { type: "RESPOND_TO_PROMPT", promptId: g.pendingPrompts[0]!.id, targetInstanceId: "hurt" }, effects).state;
    expect(g.players[1].field.find((c) => c.instanceId === "hurt")!.damage).toBe(0);
    expect(g.players[1].deck.length).toBe(deckBefore - 2); // drew 2 (damage removed)
  });

  it("gainLoreByStrength gains lore equal to source strength, capped (Mulan)", () => {
    const effects: CardEffects = { rt: [{ trigger: "on_quest", steps: [{ do: "gainLoreByStrength", max: 6 }] }] };
    let g = toPlay((id) => printed(id));
    // Strength-4 character with Rigorous Training that can quest.
    g.players[1].field.push({ instanceId: "m", printed: printed("m", { strength: 4, lore: 0, specialAbilities: [{ name: "Rigorous Training", slug: "rt", effect: "Quest: gain lore equal to strength." }] }), damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [] });
    g = reduce(g, { type: "QUEST", cardInstanceId: "m" }, effects).state;
    expect(g.players[1].lore).toBe(4); // 0 from quest (lore 0) + 4 from strength
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
