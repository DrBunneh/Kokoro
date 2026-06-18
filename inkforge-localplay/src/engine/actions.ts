/**
 * Action vocabulary + the `applyAction` reducer (spec §4.3). Every player intent
 * is one action. `applyAction` validates legality, computes the next state
 * purely, and emits one frame (a JSON-Patch diff) plus log entries. Illegal
 * actions throw `GameError` and emit no frame.
 *
 * This slice implements the setup phase and turn structure (ready/set/draw,
 * ink, end-turn/pass, deckout, concession). Play/quest/challenge/abilities and
 * the bag land in subsequent work packages.
 */
import {
  type CardInstance,
  type CardLookup,
  type GameState,
  type PlayerId,
  type PlayerState,
  OPENING_HAND,
  WIN_LORE,
  otherPlayer,
} from "./state";
import { Rng } from "./rng";
import { makeFrame, makeLog as log, type Frame, type LogEntry } from "./replay";
import {
  effectiveStrength,
  hasKeyword,
  isBanished,
  keywordValue,
} from "./keywords";
import { banishCard, drawCards, findInstance, type Zone } from "./zones";
import { classifyTrigger, runSteps, targetMatches, type CardEffects, type EffectContext, type Step, type Trigger } from "./effects/dsl";
import { cardEffects as defaultCardEffects } from "./effects";
import { uid } from "@/lib/id";

export type Action =
  | { type: "CHOOSE_STARTING_PLAYER"; player: PlayerId }
  | { type: "MULLIGAN"; player: PlayerId; cardInstanceIds: string[] }
  | { type: "ADD_TO_INK"; cardInstanceId: string }
  | { type: "PLAY_CARD"; cardInstanceId: string; shiftOnto?: string; singers?: string[] }
  | { type: "QUEST"; cardInstanceId: string }
  | { type: "ACTIVATE_ABILITY"; cardInstanceId: string; slug?: string }
  | { type: "ATTACK"; attackerId: string; defenderId: string }
  | { type: "RESPOND_TO_PROMPT"; promptId: string; targetInstanceId?: string }
  | { type: "MANUAL_ADJUST"; ops: ManualOp[] }
  | { type: "END_TURN" }
  | { type: "GAME_FINISH"; winner: PlayerId; reason: "concession" };

/** Manual Mode adjustments (spec §7.3) — every change is recorded as a frame. */
export type ManualOp =
  | { kind: "setDamage"; instanceId: string; value: number }
  | { kind: "setExerted"; instanceId: string; value: boolean }
  | { kind: "setLore"; player: PlayerId; value: number }
  | { kind: "move"; instanceId: string; toPlayer: PlayerId; toZone: Zone };

export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}

export interface NewGameConfig {
  id: string;
  seed: string;
  lookup: CardLookup;
  players: Record<PlayerId, { name: string; deck: string[] }>;
}

function buildDeck(lookup: CardLookup, ids: string[], player: PlayerId): CardInstance[] {
  return ids.map((id, i) => {
    const printed = lookup(id);
    if (!printed) throw new GameError(`Unknown card id in deck: ${id}`);
    return {
      instanceId: `p${player}c${i}`,
      printed,
      damage: 0,
      exerted: false,
      justPlayed: false,
      appliedEffects: [],
      cardsUnder: [],
    };
  });
}

function emptyPlayer(name: string, deck: CardInstance[]): PlayerState {
  return { name, hand: [], field: [], items: [], inkwell: [], discard: [], deck, lore: 0 };
}

/**
 * Create a new game at the coin-toss stage. Decks are shuffled and the toss is
 * decided from the seeded stream (order: shuffle P1, shuffle P2, toss) so the
 * whole game is reproducible from seed + frames.
 */
export function createGame(cfg: NewGameConfig): GameState {
  const rng = new Rng(cfg.seed);
  const p1Deck = rng.shuffle(buildDeck(cfg.lookup, cfg.players[1].deck, 1));
  const p2Deck = rng.shuffle(buildDeck(cfg.lookup, cfg.players[2].deck, 2));
  const tossWinner: PlayerId = rng.int(2) === 0 ? 1 : 2;

  return {
    id: cfg.id,
    status: "coin_toss",
    currentPlayer: tossWinner,
    turnNumber: 0,
    firstPlayer: null,
    hasInkedThisTurn: false,
    players: {
      1: emptyPlayer(cfg.players[1].name, p1Deck),
      2: emptyPlayer(cfg.players[2].name, p2Deck),
    },
    pendingPrompts: [],
    coinToss: { winner: tossWinner },
    winner: null,
    rngSeed: cfg.seed,
    rngCursor: rng.cursor,
  };
}

function clone(state: GameState): GameState {
  return structuredClone(state);
}

/** Effective value of a stat including temporary buffs/debuffs. */
function effectiveLore(card: CardInstance): number {
  const base = card.printed.lore ?? 0;
  const delta = card.appliedEffects.reduce((n, e) => n + (e.lore ?? 0), 0);
  return base + delta;
}

/** Ready (un-exerted) ink available to pay costs. */
function readyInk(p: PlayerState): CardInstance[] {
  return p.inkwell.filter((c) => !c.exerted);
}

/** Pay a cost by exerting that many ready ink. Caller must check affordability. */
function payInk(p: PlayerState, cost: number): void {
  let paid = 0;
  for (const ink of p.inkwell) {
    if (paid >= cost) break;
    if (!ink.exerted) {
      ink.exerted = true;
      paid += 1;
    }
  }
}

/**
 * Fire a trigger for a source card: resolve DSL-covered effects (auto, or push
 * a choice prompt), and surface uncovered special abilities as Manual-Mode
 * prompts. This is the bag (spec §4.6, §7): the engine blocks normal actions
 * while prompts are pending.
 */
type BanishRef = { card: CardInstance; owner: PlayerId };
type AbilitySpec = { name: string; slug: string; effect: string };

/** slugify mirrors build-card-db so effect keys line up with the seeded data. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Strip leading reminder text from an action/song so a surfaced prompt shows the
 * actual instruction: drop a leading "(…)" reminder and a "Sing Together N (…)"
 * / "Singer N (…)" prefix.
 */
function actionEffectText(rules: string): string {
  let t = rules.replace(/\s+/g, " ").trim();
  t = t.replace(/^\((?:[^()]|\([^()]*\))*\)\s*/, ""); // leading parenthetical reminder
  t = t.replace(/^(Sing Together|Singer)\s+\d+\s*\((?:[^()]|\([^()]*\))*\)\s*/i, "");
  return t.trim();
}

/** Resolve one ability for a trigger: run its DSL def, or surface it for Manual Mode. */
function runAbility(
  state: GameState,
  sa: AbilitySpec,
  trigger: Trigger,
  cardType: CardInstance["printed"]["type"],
  source: CardInstance,
  controller: PlayerId,
  logs: LogEntry[],
  effects: CardEffects,
  surfaceManual: boolean,
  banished?: BanishRef[],
): void {
  const matching = (effects[sa.slug] ?? []).filter((d) => d.trigger === trigger);
  if (matching.length > 0) {
    for (const def of matching) {
      const ctx: EffectContext = { controller, source, vars: {}, banished };
      const suspension = runSteps(state, def.steps, ctx, logs);
      if (suspension) {
        state.pendingPrompts.push({
          id: uid(),
          player: controller,
          sourceInstanceId: source.instanceId,
          kind: sa.slug,
          text: suspension.text ? `${sa.name}: ${suspension.text}` : `${sa.name}: ${sa.effect}`,
          auto: false,
          controller,
          scope: suspension.scope,
          pick: suspension.pick,
          reveal: suspension.reveal,
          resume: { steps: suspension.steps, vars: ctx.vars },
        });
      } else {
        logs.push(log({ turnNumber: state.turnNumber, player: controller, type: "ABILITY_TRIGGERED", message: `${sa.name} resolved`, cardRefs: [{ id: source.printed.id, name: source.printed.fullName }] }));
      }
    }
    return;
  }
  // Not in the DSL — surface for Manual Mode only if it fires on THIS event.
  if (surfaceManual && classifyTrigger(sa.effect, cardType) === trigger) {
    state.pendingPrompts.push({
      id: uid(),
      player: controller,
      sourceInstanceId: source.instanceId,
      kind: "manual",
      text: `${sa.name}: ${sa.effect}`,
      auto: false,
    });
  }
}

function fireTrigger(
  state: GameState,
  trigger: Trigger,
  source: CardInstance,
  controller: PlayerId,
  logs: LogEntry[],
  effects: CardEffects,
  surfaceManual: boolean,
  banished?: BanishRef[],
  onlySlug?: string,
): void {
  const type = source.printed.type;
  const abilities: AbilitySpec[] = [...source.printed.specialAbilities];
  // Actions/songs carry their effect in rulesText with no named ability — treat
  // the whole rules text as an implicit on-play ability so it fires / surfaces.
  if (abilities.length === 0 && (type === "action" || type === "song") && source.printed.rulesText) {
    const effect = actionEffectText(source.printed.rulesText);
    if (effect) abilities.push({ name: source.printed.fullName, slug: slugify(source.printed.fullName), effect });
  }
  for (const sa of abilities) {
    if (onlySlug && sa.slug !== onlySlug) continue;
    runAbility(state, sa, trigger, type, source, controller, logs, effects, surfaceManual, banished);
  }
}

/**
 * Fire `on_banish` for each banished card, draining the queue. on_banish effects
 * may themselves banish more cards (chains), so we loop until the queue empties.
 * The banished card is its own effect source (its slug abilities are read off
 * `printed`), so it resolves correctly even though it now sits in discard.
 */
function drainBanish(state: GameState, queue: BanishRef[], logs: LogEntry[], effects: CardEffects): void {
  let guard = 0;
  while (queue.length > 0 && guard++ < 64) {
    const { card, owner } = queue.shift()!;
    fireTrigger(state, "on_banish", card, owner, logs, effects, true, queue);
  }
}

/** Parse the cost of an activated ability from the text before its em dash. */
function parseActivationCost(effect: string): { exert: boolean; ink: number; banishSelf: boolean } {
  const head = effect.split("—")[0] ?? "";
  const inkMatch = head.match(/(\d+)\s*\{i\}/i);
  return {
    exert: /\{e\}/i.test(head),
    ink: inkMatch ? parseInt(inkMatch[1]!, 10) : 0,
    banishSelf: /banish this/i.test(head),
  };
}

/** Begin a player's turn: ready/set/draw. The first player skips the very first draw. */
function startTurn(state: GameState, player: PlayerId, logs: LogEntry[], isOpeningTurn: boolean): void {
  state.currentPlayer = player;
  state.hasInkedThisTurn = false;
  const p = state.players[player];

  // Ready step: ready all cards, clear drying.
  for (const c of [...p.field, ...p.items, ...p.inkwell]) {
    c.exerted = false;
    c.justPlayed = false;
  }
  logs.push(log({ turnNumber: state.turnNumber, player, type: "TURN_START", message: `${p.name}'s turn` }));
  logs.push(log({ turnNumber: state.turnNumber, player, type: "READY", message: "Ready step" }));
  // Set step (start-of-turn triggers go to the bag — none in this slice).
  logs.push(log({ turnNumber: state.turnNumber, player, type: "SET", message: "Set step" }));

  // Draw step.
  if (isOpeningTurn) {
    logs.push(log({ turnNumber: state.turnNumber, player, type: "DRAW", message: "First player skips the first draw" }));
    return;
  }
  if (!drawCards(p, 1)) {
    state.status = "finished";
    state.winner = otherPlayer(player);
    state.victoryReason = "deckout";
    logs.push(log({ turnNumber: state.turnNumber, player, type: "GAME_END", message: `${p.name} decked out` }));
    return;
  }
  logs.push(log({ turnNumber: state.turnNumber, player, type: "CARD_DRAWN", message: `${p.name} drew a card` }));
}

function checkLoreWin(state: GameState, logs: LogEntry[]): void {
  for (const pid of [1, 2] as PlayerId[]) {
    if (state.players[pid].lore >= WIN_LORE) {
      state.status = "finished";
      state.winner = pid;
      state.victoryReason = "lore";
      logs.push(log({ turnNumber: state.turnNumber, player: pid, type: "GAME_END", message: `${state.players[pid].name} reached ${WIN_LORE} lore` }));
    }
  }
}

const BAG_BLOCKED = new Set(["ADD_TO_INK", "PLAY_CARD", "QUEST", "ACTIVATE_ABILITY", "ATTACK", "END_TURN"]);

/** Pure rules reducer. Returns the next state and logs; throws on illegal actions. */
export function reduce(
  state: GameState,
  action: Action,
  effects: CardEffects = defaultCardEffects,
): { state: GameState; logs: LogEntry[] } {
  if (state.status === "finished") throw new GameError("Game is finished");
  // The bag blocks normal actions while triggered abilities await resolution.
  if (state.pendingPrompts.length > 0 && BAG_BLOCKED.has(action.type)) {
    throw new GameError("Resolve pending abilities first");
  }
  const next = clone(state);
  const logs: LogEntry[] = [];
  // Cards banished during this action; their on_banish triggers fire after the
  // primary resolution (drained in the relevant branches below).
  const banished: BanishRef[] = [];

  switch (action.type) {
    case "CHOOSE_STARTING_PLAYER": {
      if (next.status !== "coin_toss") throw new GameError("Not in coin-toss");
      next.firstPlayer = action.player;
      next.currentPlayer = action.player;
      next.status = "mulligan";
      delete next.coinToss;
      next.mulliganState = { done: { 1: false, 2: false } };
      logs.push(log({ turnNumber: 0, player: action.player, type: "GAME_START", message: `${next.players[action.player].name} goes first` }));
      for (const pid of [1, 2] as PlayerId[]) {
        drawCards(next.players[pid], OPENING_HAND);
        logs.push(log({ turnNumber: 0, player: pid, type: "INITIAL_HAND", message: `${next.players[pid].name} draws ${OPENING_HAND}` }));
      }
      return { state: next, logs };
    }

    case "MULLIGAN": {
      if (next.status !== "mulligan") throw new GameError("Not in mulligan");
      const ms = next.mulliganState!;
      if (ms.done[action.player]) throw new GameError("Player already mulliganed");
      const p = next.players[action.player];
      const ids = new Set(action.cardInstanceIds);
      const chosen = p.hand.filter((c) => ids.has(c.instanceId));
      if (chosen.length !== ids.size) throw new GameError("Mulligan card not in hand");
      const kept = p.hand.filter((c) => !ids.has(c.instanceId));
      // Bottom chosen, draw equal from top, then shuffle.
      p.deck.push(...chosen);
      const drawn = p.deck.splice(0, chosen.length);
      p.hand = [...kept, ...drawn];
      const rng = new Rng(next.rngSeed, next.rngCursor);
      p.deck = rng.shuffle(p.deck);
      next.rngCursor = rng.cursor;
      ms.done[action.player] = true;
      logs.push(log({ turnNumber: 0, player: action.player, type: "MULLIGAN", message: `${p.name} mulliganed ${chosen.length}`, data: { mulliganCount: chosen.length } }));

      if (ms.done[1] && ms.done[2]) {
        delete next.mulliganState;
        next.status = "playing";
        next.turnNumber = 1;
        startTurn(next, next.firstPlayer!, logs, true);
      }
      return { state: next, logs };
    }

    case "ADD_TO_INK": {
      if (next.status !== "playing") throw new GameError("Not in play");
      if (next.hasInkedThisTurn) throw new GameError("Already inked this turn");
      const p = next.players[next.currentPlayer];
      const idx = p.hand.findIndex((c) => c.instanceId === action.cardInstanceId);
      if (idx < 0) throw new GameError("Card not in hand");
      const card = p.hand[idx]!;
      if (!card.printed.inkable) throw new GameError("Card is not inkable");
      p.hand.splice(idx, 1);
      card.exerted = false;
      card.justPlayed = true; // shown face-up in the inkwell until end of this turn
      p.inkwell.push(card);
      next.hasInkedThisTurn = true;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PUT_INTO_INKWELL", message: `${p.name} inked ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
      return { state: next, logs };
    }

    case "PLAY_CARD": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const p = next.players[next.currentPlayer];
      const idx = p.hand.findIndex((c) => c.instanceId === action.cardInstanceId);
      if (idx < 0) throw new GameError("Card not in hand");
      const card = p.hand[idx]!;

      // --- Shift: play onto a same-name character for the Shift cost (§10.8) ---
      if (action.shiftOnto) {
        const shiftCost = keywordValue(card, "Shift");
        if (shiftCost <= 0) throw new GameError("Card has no Shift");
        const base = p.field.find((c) => c.instanceId === action.shiftOnto);
        if (!base || base.printed.type !== "character") throw new GameError("Shift target not in play");
        if (base.printed.name !== card.printed.name) throw new GameError("Shift requires a same-named character");
        if (readyInk(p).length < shiftCost) throw new GameError("Not enough ink");
        payInk(p, shiftCost);
        p.hand.splice(idx, 1);
        // The shifted character inherits damage/readiness and forms a stack.
        card.damage = base.damage;
        card.exerted = base.exerted;
        card.justPlayed = false; // not drying — it's been in play
        card.cardsUnder = [...base.cardsUnder, base];
        base.cardsUnder = [];
        const fi = p.field.indexOf(base);
        p.field.splice(fi, 1, card);
        logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `${p.name} shifted ${card.printed.fullName} onto ${base.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
        fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true, banished);
        drainBanish(next, banished, logs, effects);
        return { state: next, logs };
      }

      // --- Sing / Sing Together: exert singers to play a song for free (§10.9/10.12) ---
      if (action.singers && action.singers.length > 0) {
        if (card.printed.type !== "song") throw new GameError("Only songs can be sung");
        let singValue = 0;
        const singers = action.singers.map((sid) => {
          const s = p.field.find((c) => c.instanceId === sid);
          if (!s || s.printed.type !== "character") throw new GameError("Singer not in play");
          if (s.exerted) throw new GameError("Singer is exerted");
          singValue += Math.max(s.printed.cost, keywordValue(s, "Singer"));
          return s;
        });
        if (singValue < card.printed.cost) throw new GameError("Singers can't afford this song");
        for (const s of singers) s.exerted = true;
        p.hand.splice(idx, 1);
        p.discard.push(card);
        logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `${p.name} sang ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
        fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true, banished);
        drainBanish(next, banished, logs, effects);
        return { state: next, logs };
      }

      // --- Normal play: pay ink ---
      const cost = card.printed.cost;
      if (readyInk(p).length < cost) throw new GameError("Not enough ink");
      payInk(p, cost);
      p.hand.splice(idx, 1);

      switch (card.printed.type) {
        case "character":
          card.justPlayed = true; // drying
          card.exerted = false;
          card.damage = 0;
          p.field.push(card);
          break;
        case "location":
          card.justPlayed = false;
          card.exerted = false;
          p.field.push(card);
          break;
        case "item":
          card.justPlayed = false;
          p.items.push(card);
          break;
        case "action":
        case "song":
          p.discard.push(card);
          break;
      }
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `${p.name} played ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
      fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true, banished);
      drainBanish(next, banished, logs, effects);
      return { state: next, logs };
    }

    case "QUEST": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const p = next.players[next.currentPlayer];
      const card = p.field.find((c) => c.instanceId === action.cardInstanceId);
      if (!card) throw new GameError("Character not in play");
      if (card.printed.type !== "character") throw new GameError("Only characters can quest");
      if (card.exerted) throw new GameError("Character is exerted");
      if (card.justPlayed) throw new GameError("Character is drying (played this turn)");
      card.exerted = true;
      const gained = effectiveLore(card);
      p.lore += gained;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_QUEST", message: `${card.printed.fullName} quested for ${gained}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "LORE_GAINED", message: `${p.name} now has ${p.lore} lore`, data: { lore: p.lore } }));
      fireTrigger(next, "on_quest", card, next.currentPlayer, logs, effects, true, banished);
      // Support (rules §10.13): add this character's {S} to another chosen one.
      if (hasKeyword(card, "Support")) {
        const amount = effectiveStrength(card);
        const steps: Step[] = [
          { do: "chooseCharacter", as: "ally", scope: "ally", text: `add +${amount} ¤ to another character this turn` },
          { do: "buff", to: "ally", strength: amount, duration: "end_of_turn" },
        ];
        const ctx: EffectContext = { controller: next.currentPlayer, source: card, vars: {}, banished };
        const suspension = runSteps(next, steps, ctx, logs);
        if (suspension) {
          next.pendingPrompts.push({
            id: uid(),
            player: next.currentPlayer,
            sourceInstanceId: card.instanceId,
            kind: "support",
            text: `Support — ${suspension.text}`,
            auto: false,
            controller: next.currentPlayer,
            scope: suspension.scope,
            pick: suspension.pick,
            reveal: suspension.reveal,
            resume: { steps: suspension.steps, vars: ctx.vars },
          });
        }
      }
      drainBanish(next, banished, logs, effects);
      return { state: next, logs };
    }

    case "ACTIVATE_ABILITY": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const p = next.players[next.currentPlayer];
      const source = [...p.field, ...p.items].find((c) => c.instanceId === action.cardInstanceId);
      if (!source) throw new GameError("Card not in play");
      const sa = source.printed.specialAbilities.find(
        (a) => (action.slug ? a.slug === action.slug : true) && classifyTrigger(a.effect, source.printed.type) === "activated",
      );
      if (!sa) throw new GameError("No activated ability to use");

      const cost = parseActivationCost(sa.effect);
      // Exert cost: the source must be ready, and a drying character can't exert.
      if (cost.exert) {
        if (source.exerted) throw new GameError("Source is already exerted");
        if (source.printed.type === "character" && source.justPlayed) throw new GameError("Character is drying");
      }
      if (cost.ink > 0 && readyInk(p).length < cost.ink) throw new GameError("Not enough ink");

      // Pay the cost.
      if (cost.exert) source.exerted = true;
      if (cost.ink > 0) payInk(p, cost.ink);
      if (cost.banishSelf) {
        banishCard(p, source, logs, next.turnNumber);
        banished.push({ card: source, owner: next.currentPlayer });
      }
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "ABILITY_TRIGGERED", message: `${p.name} activated ${sa.name}`, cardRefs: [{ id: source.printed.id, name: source.printed.fullName }] }));

      // Resolve only this ability's effect (or surface it for Manual Mode).
      fireTrigger(next, "activated", source, next.currentPlayer, logs, effects, true, banished, sa.slug);
      drainBanish(next, banished, logs, effects);
      return { state: next, logs };
    }

    case "ATTACK": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const ap = next.players[next.currentPlayer];
      const dp = next.players[otherPlayer(next.currentPlayer)];
      const attacker = ap.field.find((c) => c.instanceId === action.attackerId);
      if (!attacker || attacker.printed.type !== "character") throw new GameError("Attacker is not a character in play");
      if (attacker.exerted) throw new GameError("Attacker is exerted");
      if (attacker.justPlayed && !hasKeyword(attacker, "Rush")) throw new GameError("Attacker is drying");

      const defender = dp.field.find((c) => c.instanceId === action.defenderId);
      if (!defender) throw new GameError("Defender is not in play");
      const defenderIsChar = defender.printed.type === "character";
      if (defenderIsChar && !defender.exerted) throw new GameError("Can only challenge exerted characters");
      if (defenderIsChar && hasKeyword(defender, "Evasive") && !hasKeyword(attacker, "Evasive")) {
        throw new GameError("Only Evasive characters can challenge an Evasive character");
      }
      // Bodyguard: if a legal enemy target has Bodyguard, one must be chosen.
      const legalTargets = dp.field.filter((c) => c.printed.type !== "character" || c.exerted);
      const hasBodyguardTarget = legalTargets.some((c) => hasKeyword(c, "Bodyguard"));
      if (hasBodyguardTarget && !hasKeyword(defender, "Bodyguard")) {
        throw new GameError("Must challenge a character with Bodyguard");
      }

      // Declaration: the attacker exerts, then any "whenever this challenges"
      // ability goes on the bag.
      attacker.exerted = true;
      fireTrigger(next, "on_challenge", attacker, next.currentPlayer, logs, effects, true, banished);

      // Challenge damage (simultaneous), with Challenger +N and Resist applied.
      const atkStrength = effectiveStrength(attacker) + keywordValue(attacker, "Challenger");
      const defStrength = defenderIsChar ? effectiveStrength(defender) : 0;
      const toDefender = Math.max(0, atkStrength - keywordValue(defender, "Resist"));
      const toAttacker = Math.max(0, defStrength - keywordValue(attacker, "Resist"));
      defender.damage += toDefender;
      attacker.damage += toAttacker;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_ATTACK", message: `${attacker.printed.fullName} challenged ${defender.printed.fullName}`, cardRefs: [{ id: attacker.printed.id, name: attacker.printed.fullName }, { id: defender.printed.id, name: defender.printed.fullName }] }));

      // Banish anything that took lethal damage (simultaneous).
      if (isBanished(defender)) { banishCard(dp, defender, logs, next.turnNumber); banished.push({ card: defender, owner: otherPlayer(next.currentPlayer) }); }
      if (isBanished(attacker)) { banishCard(ap, attacker, logs, next.turnNumber); banished.push({ card: attacker, owner: next.currentPlayer }); }
      drainBanish(next, banished, logs, effects);
      return { state: next, logs };
    }

    case "RESPOND_TO_PROMPT": {
      const i = next.pendingPrompts.findIndex((p) => p.id === action.promptId);
      if (i < 0) throw new GameError("No such prompt");
      const prompt = next.pendingPrompts[i]!;
      next.pendingPrompts.splice(i, 1);
      if (prompt.resume && prompt.controller) {
        const source = findInstance(next, prompt.sourceInstanceId ?? "")?.card;
        if (source) {
          const ctx: EffectContext = { controller: prompt.controller, source, vars: prompt.resume.vars, banished };
          let steps = prompt.resume.steps;
          let inject = action.targetInstanceId;
          const lead = steps[0];
          if (lead && lead.do === "mayConfirm") {
            // Yes (a sentinel target) runs on; No (no target) aborts the effect.
            if (action.targetInstanceId == null) steps = [];
          } else if (lead && lead.do === "lookAtTop") {
            // Keep the chosen revealed card; default to the top card if none/invalid.
            const top = next.players[prompt.controller].deck.slice(0, lead.count).map((c) => c.instanceId);
            inject = action.targetInstanceId && top.includes(action.targetInstanceId) ? action.targetInstanceId : top[0];
          } else if (lead && (lead.do === "chooseCharacter" || lead.do === "chooseFromHand")) {
            if (action.targetInstanceId != null) {
              const loc = findInstance(next, action.targetInstanceId);
              if (lead.do === "chooseCharacter") {
                // Reject an illegal target (wrong scope, or fails the filter).
                if (!loc || loc.zone !== "field" || !targetMatches(loc.card, loc.owner, prompt.controller, lead, effectiveStrength(loc.card))) {
                  throw new GameError("Not a legal target for this ability");
                }
              } else {
                // chooseFromHand: the card must be in the resolver's own hand.
                if (!loc || loc.zone !== "hand" || loc.owner !== prompt.controller) {
                  throw new GameError("Must choose a card from your hand");
                }
              }
            } else if (lead.optional) {
              // Declined an optional choice → skip it; dependent steps no-op.
              steps = steps.slice(1);
              inject = undefined;
            }
          }
          // The follow-up may itself need another choice → re-suspend a prompt.
          const again = runSteps(next, steps, ctx, logs, inject);
          if (again) {
            next.pendingPrompts.push({
              id: uid(),
              player: prompt.player,
              sourceInstanceId: prompt.sourceInstanceId,
              kind: prompt.kind,
              text: again.text ? `${prompt.kind}: ${again.text}` : prompt.text,
              auto: false,
              controller: prompt.controller,
              scope: again.scope,
              pick: again.pick,
              reveal: again.reveal,
              resume: { steps: again.steps, vars: ctx.vars },
            });
          }
        }
      }
      drainBanish(next, banished, logs, effects);
      logs.push(log({ turnNumber: next.turnNumber, player: prompt.player, type: "CHOICE_RESOLVED", message: `Resolved: ${prompt.text}` }));
      return { state: next, logs };
    }

    case "MANUAL_ADJUST": {
      for (const op of action.ops) {
        if (op.kind === "setLore") {
          next.players[op.player].lore = Math.max(0, op.value);
          continue;
        }
        const found = findInstance(next, op.instanceId);
        if (!found) continue;
        if (op.kind === "setDamage") found.card.damage = Math.max(0, op.value);
        else if (op.kind === "setExerted") found.card.exerted = op.value;
        else if (op.kind === "move") {
          const fromArr = next.players[found.owner][found.zone];
          const j = fromArr.indexOf(found.card);
          if (j >= 0) fromArr.splice(j, 1);
          next.players[op.toPlayer][op.toZone].push(found.card);
        }
      }
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "MANUAL_ADJUST", message: `Manual adjustment (${action.ops.length})` }));
      return { state: next, logs };
    }

    case "END_TURN": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const ending = next.currentPlayer;
      // Expire "until end of turn" effects across all cards.
      for (const pid of [1, 2] as PlayerId[]) {
        for (const c of [...next.players[pid].field, ...next.players[pid].items]) {
          c.appliedEffects = c.appliedEffects.filter((e) => e.duration !== "end_of_turn");
        }
      }
      // Freshly-inked cards flip to face-down at the end of the turn they were played.
      for (const c of next.players[ending].inkwell) c.justPlayed = false;
      logs.push(log({ turnNumber: next.turnNumber, player: ending, type: "TURN_END", message: `${next.players[ending].name} ends turn` }));
      next.turnNumber += 1;
      startTurn(next, otherPlayer(ending), logs, false);
      return { state: next, logs };
    }

    case "GAME_FINISH": {
      next.status = "finished";
      next.winner = action.winner;
      next.victoryReason = action.reason;
      logs.push(log({ turnNumber: next.turnNumber, player: otherPlayer(action.winner), type: "GAME_CONCEDED", message: `${next.players[otherPlayer(action.winner)].name} conceded` }));
      return { state: next, logs };
    }

    default: {
      const _exhaustive: never = action;
      throw new GameError(`Unknown action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function actingPlayer(state: GameState, action: Action): PlayerId {
  if (action.type === "CHOOSE_STARTING_PLAYER" || action.type === "MULLIGAN") return action.player;
  if (action.type === "GAME_FINISH") return otherPlayer(action.winner);
  return state.currentPlayer;
}

export interface ApplyResult {
  nextState: GameState;
  frame: Frame;
  logs: LogEntry[];
}

/**
 * Apply an action: validate + reduce, then emit one frame (state diff) and its
 * logs. `seq`/`prevLogCount` are supplied by the recording session.
 */
export function applyAction(
  state: GameState,
  action: Action,
  seq: number,
  prevLogCount = 0,
  effects?: CardEffects,
): ApplyResult {
  const { state: nextState, logs } = reduce(state, action, effects);
  // Lore wins are checked after every action.
  checkLoreWin(nextState, logs);
  const frame = makeFrame(
    state,
    nextState,
    {
      actionType: action.type,
      player: actingPlayer(state, action),
      turnNumber: nextState.turnNumber,
      logCountAfter: prevLogCount + logs.length,
    },
    seq,
  );
  return { nextState, frame, logs };
}
