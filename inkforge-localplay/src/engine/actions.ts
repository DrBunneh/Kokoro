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
  effectiveLore,
  effectiveStrength,
  effectiveWillpower,
  hasKeyword,
  isBanished,
  keywordValue,
} from "./keywords";
import { banishCard, drawCards, findInstance, type Zone } from "./zones";
import { damagePrevented } from "./continuous";
import { classifyTrigger, runSteps, targetMatches, scryMatch, handCardMatches, type CardEffects, type Condition, type EffectContext, type EffectEvents, type Step, type Trigger } from "./effects/dsl";
import { cardEffects as defaultCardEffects } from "./effects";
import { uid } from "@/lib/id";

export type Action =
  | { type: "CHOOSE_STARTING_PLAYER"; player: PlayerId }
  | { type: "MULLIGAN"; player: PlayerId; cardInstanceIds: string[] }
  | { type: "ADD_TO_INK"; cardInstanceId: string }
  | { type: "PLAY_CARD"; cardInstanceId: string; shiftOnto?: string; singers?: string[] }
  | { type: "QUEST"; cardInstanceId: string }
  | { type: "MOVE_TO_LOCATION"; characterId: string; locationId: string }
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
  return { name, hand: [], field: [], items: [], inkwell: [], discard: [], deck, lore: 0, discounts: [], extraInk: 0, discardedThisTurn: 0, playedThisTurn: [] };
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

/** Ready (un-exerted) ink available to pay costs. */
function readyInk(p: PlayerState): CardInstance[] {
  return p.inkwell.filter((c) => !c.exerted);
}

/** Discounts that apply to playing this card (type + subtype match). */
function matchingDiscounts(p: PlayerState, card: CardInstance["printed"]) {
  return (p.discounts ?? []).filter(
    (d) =>
      d.uses > 0 &&
      (!d.cardType || d.cardType === card.type) &&
      (!d.subtypes || d.subtypes.some((s) => card.subtypes.some((cs) => cs.toLowerCase() === s.toLowerCase()))),
  );
}

/**
 * A card's own passive cost reduction ("you pay N less to play this …"), read
 * from its `cost`-trigger defs (flat, count-based, and/or condition-gated).
 */
function selfCostReduction(state: GameState, p: PlayerState, source: CardInstance, effects: CardEffects): number {
  let total = 0;
  for (const sa of source.printed.specialAbilities) {
    for (const def of effects[sa.slug] ?? []) {
      if (def.trigger !== "cost") continue;
      if (!conditionMet(state, p === state.players[1] ? 1 : 2, source, def.when)) continue;
      if (def.free) return source.printed.cost; // free play — reduce the whole cost
      total += def.reduce ?? 0;
      if (def.reducePer === "actionInDiscard") total += p.discard.filter((c) => c.printed.type === "action" || c.printed.type === "song").length;
      else if (def.reducePer === "characterInPlay") total += p.field.filter((c) => c.printed.type === "character").length;
      if (def.reduceSubtypeInDiscard) {
        const want = def.reduceSubtypeInDiscard.toLowerCase();
        total += p.discard.filter((c) => c.printed.type === "character" && c.printed.subtypes.some((s) => s.toLowerCase() === want)).length;
      }
      if (def.reduceTypeInDiscard) total += p.discard.filter((c) => c.printed.type === def.reduceTypeInDiscard).length;
      if (def.reducePerExerted) {
        for (const pid of [1, 2] as PlayerId[]) total += state.players[pid].field.filter((c) => c.printed.type === "character" && c.exerted).length;
      }
      if (def.reducePerInkwell) total += p.inkwell.length;
    }
  }
  return total;
}

/** Cost after "pay N less" discounts + the card's own passive reduction (≥0). */
function effectiveCost(state: GameState, p: PlayerState, card: CardInstance, effects: CardEffects): number {
  const reduction =
    matchingDiscounts(p, card.printed).reduce((sum, d) => sum + d.amount, 0) +
    selfCostReduction(state, p, card, effects);
  return Math.max(0, card.printed.cost - reduction);
}

/** Consume one use of each discount applied to this play; drop depleted ones. */
function consumeDiscounts(p: PlayerState, card: CardInstance["printed"]): void {
  for (const d of matchingDiscounts(p, card)) d.uses -= 1;
  p.discounts = (p.discounts ?? []).filter((d) => d.uses > 0);
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

/** Does a player control a character in play with the given (behavioural) static ability? */
function hasControllerStatic(state: GameState, owner: PlayerId, slug: string): boolean {
  return state.players[owner].field.some((c) => c.printed.type === "character" && c.printed.specialAbilities.some((a) => a.slug === slug));
}

/** Optional event context for conditions that reference the triggering event. */
type EventCtx = { banishedCard?: CardInstance; banishedOwner?: PlayerId; actor?: CardInstance };

/** Evaluate an effect's optional gate against the current state. */
function conditionMet(state: GameState, controller: PlayerId, source: CardInstance, when?: Condition, ev?: EventCtx): boolean {
  if (!when) return true;
  const p = state.players[controller];
  const played = p.playedThisTurn ?? [];
  if (when.playedType && !played.some((x) => x.type === when.playedType)) return false;
  if (when.playedSubtype) {
    const want = when.playedSubtype.toLowerCase();
    if (!played.some((x) => x.subtypes.some((s) => s.toLowerCase() === want))) return false;
  }
  if (when.playedOtherCharacterThisTurn && !played.some((x) => x.type === "character" && x.id !== source.instanceId)) return false;
  if (when.discardedAtLeast != null && (p.discardedThisTurn ?? 0) < when.discardedAtLeast) return false;
  if (when.selfUndamaged && source.damage > 0) return false;
  if (when.selfDamaged && source.damage <= 0) return false;
  if (when.selfExerted && !source.exerted) return false;
  if (when.exertedAlliesAtLeast != null && p.field.filter((c) => c.printed.type === "character" && c.exerted).length < when.exertedAlliesAtLeast) return false;
  if (when.haveCharacterNamed) {
    const want = when.haveCharacterNamed.toLowerCase();
    if (!p.field.some((c) => c.printed.name.toLowerCase() === want)) return false;
  }
  if (when.haveCharacterNamedAny) {
    const wants = when.haveCharacterNamedAny.map((n) => n.toLowerCase());
    if (!p.field.some((c) => wants.includes(c.printed.name.toLowerCase()))) return false;
  }
  if (when.firstTurnNotFirstPlayer && !(controller !== state.firstPlayer && state.turnNumber <= 2)) return false;
  const last = played[played.length - 1];
  if (when.lastPlayedType && last?.type !== when.lastPlayedType) return false;
  if (when.lastPlayedNonCharacter && (!last || last.type === "character")) return false;
  if (when.otherCharsAtLeast != null) {
    const want = when.otherSubtype?.toLowerCase();
    const n = p.field.filter((c) => c.printed.type === "character" && c.instanceId !== source.instanceId &&
      (!want || c.printed.subtypes.some((s) => s.toLowerCase() === want))).length;
    if (n < when.otherCharsAtLeast) return false;
  }
  if (when.opponentHasExerted) {
    const opp = state.players[otherPlayer(controller)];
    if (!opp.field.some((c) => c.printed.type === "character" && c.exerted)) return false;
  }
  if (when.haveSubtypeAny) {
    const wants = when.haveSubtypeAny.map((s) => s.toLowerCase());
    if (!p.field.some((c) => c.printed.type === "character" && c.printed.subtypes.some((s) => wants.includes(s.toLowerCase())))) return false;
  }
  if (when.lastPlayedSubtype) {
    const want = when.lastPlayedSubtype.toLowerCase();
    if (!last || !last.subtypes.some((s) => s.toLowerCase() === want)) return false;
  }
  if (when.onlyYourTurn && state.currentPlayer !== controller) return false;
  if (when.onlyOpponentTurn && state.currentPlayer === controller) return false;
  if (when.haveCharStrengthAtLeast != null && !p.field.some((c) => c.printed.type === "character" && effectiveStrength(state, c) >= when.haveCharStrengthAtLeast!)) return false;
  if (when.lacksCharStrengthAtLeast != null && p.field.some((c) => c.printed.type === "character" && effectiveStrength(state, c) >= when.lacksCharStrengthAtLeast!)) return false;
  if (when.actionsPlayedAtLeast != null && played.filter((x) => x.type === "action" || x.type === "song").length < when.actionsPlayedAtLeast) return false;
  if (when.banishedSubtype) {
    const want = when.banishedSubtype.toLowerCase();
    if (!ev?.banishedCard?.printed.subtypes.some((s) => s.toLowerCase() === want)) return false;
  }
  if (when.banishedMine && ev?.banishedOwner !== controller) return false;
  if (when.banishedOpponent && (ev?.banishedOwner == null || ev.banishedOwner === controller)) return false;
  if (when.actorSubtype) {
    const want = when.actorSubtype.toLowerCase();
    if (!ev?.actor?.printed.subtypes.some((s) => s.toLowerCase() === want)) return false;
  }
  if (when.selfHasCardUnder && source.cardsUnder.length === 0) return false;
  if (when.ownToyBanishedThisTurn && !p.ownToyBanishedThisTurn) return false;
  if (when.opponentInkwellMoreThanYou && state.players[otherPlayer(controller)].inkwell.length <= p.inkwell.length) return false;
  if (when.opponentHandMoreThanYou && state.players[otherPlayer(controller)].hand.length <= p.hand.length) return false;
  if (when.subtypeInDiscardAtLeast) {
    const want = when.subtypeInDiscardAtLeast.subtype.toLowerCase();
    const n = p.discard.filter((c) => c.printed.type === "character" && c.printed.subtypes.some((s) => s.toLowerCase() === want)).length;
    if (n < when.subtypeInDiscardAtLeast.count) return false;
  }
  if (when.haveOwnItem && p.items.length === 0) return false;
  if (when.haveItemsAtLeast != null && p.items.length < when.haveItemsAtLeast) return false;
  if (when.removedDamageThisTurn && !p.removedDamageThisTurn) return false;
  if (when.haveCharWillpowerAtLeast != null && !p.field.some((c) => c.printed.type === "character" && effectiveWillpower(state, c) >= when.haveCharWillpowerAtLeast!)) return false;
  if (when.opponentMoreCharacters) {
    const mine = p.field.filter((c) => c.printed.type === "character").length;
    const theirs = state.players[otherPlayer(controller)].field.filter((c) => c.printed.type === "character").length;
    if (theirs <= mine) return false;
  }
  if (when.enemyBanishedInChallengeThisTurn && !p.enemyBanishedInChallengeThisTurn) return false;
  if (when.nameBanishedThisTurn && !(state.banishedNamesThisTurn ?? []).some((n) => n.toLowerCase() === when.nameBanishedThisTurn!.toLowerCase())) return false;
  if (when.challengedThisTurn && !p.challengedThisTurn) return false;
  if (when.noCharacterChallengedThisTurn && p.challengedThisTurn) return false;
  if (when.anyBanishedThisTurn && !state.anyBanishedThisTurn) return false;
  if (when.haveDamagedCharacter && !p.field.some((c) => c.printed.type === "character" && c.damage > 0)) return false;
  if (when.usedShift && source.cardsUnder.length === 0) return false;
  if (when.opponentLoreAtMost != null && state.players[otherPlayer(controller)].lore > when.opponentLoreAtMost) return false;
  if (when.banishedMaxCost != null && (ev?.banishedCard == null || ev.banishedCard.printed.cost > when.banishedMaxCost)) return false;
  return true;
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
      // A gated effect only fires when its condition holds (else it's skipped).
      if (!conditionMet(state, controller, source, def.when)) continue;
      // "Once during your turn" triggered abilities resolve at most once per turn.
      if (def.oncePerTurn) {
        const key = `${source.instanceId}:${sa.slug}:${trigger}`;
        if ((state.usedActivated ?? []).includes(key)) continue;
        (state.usedActivated ??= []).push(key);
      }
      const ctx: EffectContext = { controller, source, vars: {}, banished, events: makeEvents(state, logs, effects, banished) };
      const suspension = runSteps(state, def.steps ?? [], ctx, logs);
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
          handOwner: suspension.handOwner,
          modes: suspension.modes,
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
    // Track own-Toy banishes this turn (Wind-Up Frog cost reduction).
    if (card.printed.type === "character" && card.printed.subtypes.some((s) => s.toLowerCase() === "toy")) {
      state.players[owner].ownToyBanishedThisTurn = true;
    }
    if (card.printed.type === "character") (state.banishedNamesThisTurn ??= []).push(card.printed.name);
    state.anyBanishedThisTurn = true;
    // "Whenever an item is banished during your turn" (Darkwing - Darkwarrior / Cool).
    if (card.printed.type === "item") fireWatch(state, "on_item_banished", state.currentPlayer, logs, effects, queue);
    fireTrigger(state, "on_banish", card, owner, logs, effects, true, queue);
    // "Whenever a character is banished while here" (The Library).
    if (card.atLocation) {
      const loc = state.players[owner].field.find((c) => c.instanceId === card.atLocation && c.printed.type === "location");
      if (loc) fireLocationHere(state, loc, owner, "on_banish_here", "banished", card.instanceId, logs, effects, queue);
    }
    // Controller-wide banish watches (Sid "double prizes", Babyhead, Emerald).
    const ev: EventCtx = { banishedCard: card, banishedOwner: owner };
    fireWatch(state, "on_other_banished", 1, logs, effects, queue, ev);
    fireWatch(state, "on_other_banished", 2, logs, effects, queue, ev);
  }
}

/** Record a card a player played this turn (for "if you played a …" gates). */
function recordPlay(p: PlayerState, card: CardInstance): void {
  (p.playedThisTurn ??= []).push({ type: card.printed.type, subtypes: card.printed.subtypes ?? [], name: card.printed.name, id: card.instanceId });
}

/**
 * Fire `on_ally_challenged` for each of `owner`'s characters when one of their
 * characters is challenged, pre-binding the attacker as the `challenger` var so
 * effects can target it (Tiana, Merida - Gifted Archer).
 */
function fireAllyChallenged(
  state: GameState,
  owner: PlayerId,
  attacker: CardInstance,
  defenderId: string,
  logs: LogEntry[],
  effects: CardEffects,
  banished?: BanishRef[],
): void {
  for (const c of [...state.players[owner].field]) {
    if (c.printed.type !== "character" || c.instanceId === defenderId) continue;
    for (const sa of c.printed.specialAbilities) {
      const defs = (effects[sa.slug] ?? []).filter((d) => d.trigger === "on_ally_challenged");
      for (const def of defs) {
        if (!conditionMet(state, owner, c, def.when)) continue;
        const ctx: EffectContext = { controller: owner, source: c, vars: { challenger: attacker.instanceId }, banished, events: makeEvents(state, logs, effects, banished) };
        const suspension = runSteps(state, def.steps ?? [], ctx, logs);
        if (suspension) {
          state.pendingPrompts.push({
            id: uid(), player: owner, sourceInstanceId: c.instanceId, kind: sa.slug,
            text: suspension.text ? `${sa.name}: ${suspension.text}` : `${sa.name}: ${sa.effect}`,
            auto: false, controller: owner, scope: suspension.scope, pick: suspension.pick,
            reveal: suspension.reveal, handOwner: suspension.handOwner, modes: suspension.modes,
            resume: { steps: suspension.steps, vars: ctx.vars },
          });
        }
      }
    }
  }
}

/**
 * Run an `on_*_watch` trigger for each of `owner`'s field characters, resolving
 * its DSL def (auto, or pushing a choice prompt). Used for controller-wide
 * watches (banish/inkwell) where the watcher isn't the event's primary source.
 */
function fireWatch(
  state: GameState,
  trigger: Trigger,
  owner: PlayerId,
  logs: LogEntry[],
  effects: CardEffects,
  banished?: BanishRef[],
  ev?: EventCtx,
): void {
  for (const c of [...state.players[owner].field]) {
    if (c.printed.type !== "character") continue;
    for (const sa of c.printed.specialAbilities) {
      const defs = (effects[sa.slug] ?? []).filter((d) => d.trigger === trigger);
      for (const def of defs) {
        if (!conditionMet(state, owner, c, def.when, ev)) continue;
        const ctx: EffectContext = { controller: owner, source: c, vars: {}, banished, events: makeEvents(state, logs, effects, banished) };
        const suspension = runSteps(state, def.steps ?? [], ctx, logs);
        if (suspension) {
          state.pendingPrompts.push({
            id: uid(), player: owner, sourceInstanceId: c.instanceId, kind: sa.slug,
            text: suspension.text ? `${sa.name}: ${suspension.text}` : `${sa.name}: ${sa.effect}`,
            auto: false, controller: owner, scope: suspension.scope, pick: suspension.pick,
            reveal: suspension.reveal, handOwner: suspension.handOwner, modes: suspension.modes,
            resume: { steps: suspension.steps, vars: ctx.vars },
          });
        }
      }
    }
  }
}

/**
 * Fire a location's "while here" trigger, binding the moving/questing character
 * as `varName` so the location effect can target it (Casa Madrigal, The Library,
 * Seven Dwarfs' Mine).
 */
function fireLocationHere(
  state: GameState,
  location: CardInstance,
  owner: PlayerId,
  trigger: Trigger,
  varName: string,
  boundId: string,
  logs: LogEntry[],
  effects: CardEffects,
  banished?: BanishRef[],
): void {
  for (const sa of location.printed.specialAbilities) {
    const defs = (effects[sa.slug] ?? []).filter((d) => d.trigger === trigger);
    for (const def of defs) {
      if (!conditionMet(state, owner, location, def.when)) continue;
      if (def.oncePerTurn) {
        const key = `${location.instanceId}:${sa.slug}:${trigger}`;
        if ((state.usedActivated ?? []).includes(key)) continue;
        (state.usedActivated ??= []).push(key);
      }
      const ctx: EffectContext = { controller: owner, source: location, vars: { [varName]: boundId }, banished, events: makeEvents(state, logs, effects, banished) };
      const suspension = runSteps(state, def.steps ?? [], ctx, logs);
      if (suspension) {
        state.pendingPrompts.push({
          id: uid(), player: owner, sourceInstanceId: location.instanceId, kind: sa.slug,
          text: suspension.text ? `${sa.name}: ${suspension.text}` : `${sa.name}: ${sa.effect}`,
          auto: false, controller: owner, scope: suspension.scope, pick: suspension.pick,
          reveal: suspension.reveal, handOwner: suspension.handOwner, modes: suspension.modes,
          resume: { steps: suspension.steps, vars: ctx.vars },
        });
      }
    }
  }
}

/**
 * Fire an "ally actor" watch for each of `owner`'s field characters (excluding
 * the actor), binding the actor as `varName` and exposing it to conditions as
 * `ev.actor` (Mickey-Expedition, Mr. Incredible, Pluto - Steel Champion).
 */
function fireAllyActor(
  state: GameState,
  trigger: Trigger,
  owner: PlayerId,
  actor: CardInstance,
  varName: string,
  logs: LogEntry[],
  effects: CardEffects,
  banished?: BanishRef[],
): void {
  const ev: EventCtx = { actor };
  for (const c of [...state.players[owner].field]) {
    if (c.printed.type !== "character" || c.instanceId === actor.instanceId) continue;
    for (const sa of c.printed.specialAbilities) {
      const defs = (effects[sa.slug] ?? []).filter((d) => d.trigger === trigger);
      for (const def of defs) {
        if (!conditionMet(state, owner, c, def.when, ev)) continue;
        const ctx: EffectContext = { controller: owner, source: c, vars: { [varName]: actor.instanceId }, banished, events: makeEvents(state, logs, effects, banished) };
        const suspension = runSteps(state, def.steps ?? [], ctx, logs);
        if (suspension) {
          state.pendingPrompts.push({
            id: uid(), player: owner, sourceInstanceId: c.instanceId, kind: sa.slug,
            text: suspension.text ? `${sa.name}: ${suspension.text}` : `${sa.name}: ${sa.effect}`,
            auto: false, controller: owner, scope: suspension.scope, pick: suspension.pick,
            reveal: suspension.reveal, handOwner: suspension.handOwner, modes: suspension.modes,
            resume: { steps: suspension.steps, vars: ctx.vars },
          });
        }
      }
    }
  }
}

/**
 * Build the mid-effect event hooks the interpreter calls when a draw/discard
 * happens inside an effect, so on_draw / opponent-discard watches fire. A guard
 * on the state prevents a watch's own draws from cascading.
 */
function makeEvents(state: GameState, logs: LogEntry[], effects: CardEffects, banished?: BanishRef[]): EffectEvents {
  return {
    onDraw: (player) => {
      if (state.eventGuard) return;
      state.eventGuard = true;
      try {
        fireWatch(state, "on_draw", player, logs, effects, banished);
        if (state.currentPlayer === player) fireWatch(state, "on_opponent_draw", otherPlayer(player), logs, effects, banished);
      } finally {
        state.eventGuard = false;
      }
    },
    onDiscard: (player) => {
      if (state.eventGuard) return;
      state.eventGuard = true;
      try {
        fireWatch(state, "on_opponent_discard", otherPlayer(player), logs, effects, banished);
      } finally {
        state.eventGuard = false;
      }
    },
    onRemoveDamage: (player) => {
      if (state.eventGuard) return;
      state.eventGuard = true;
      try {
        fireWatch(state, "on_remove_damage", player, logs, effects, banished);
      } finally {
        state.eventGuard = false;
      }
    },
  };
}

/** Fire an event trigger for every character a player controls (e.g. "whenever you play an action"). */
function fireForController(
  state: GameState,
  trigger: Trigger,
  controller: PlayerId,
  logs: LogEntry[],
  effects: CardEffects,
  banished?: BanishRef[],
  excludeId?: string,
): void {
  for (const c of [...state.players[controller].field]) {
    if (c.instanceId === excludeId) continue;
    if (c.printed.type === "character") fireTrigger(state, trigger, c, controller, logs, effects, true, banished);
  }
}

/** Parse the cost of an activated ability from the text before its em dash. */
function parseActivationCost(effect: string): { exert: boolean; ink: number; banishSelf: boolean } {
  // The cost is the text before the em dash; abilities with no em dash are free
  // (e.g. "Once during your turn, …"), so don't mistake effect numbers for a cost.
  if (!effect.includes("—")) return { exert: false, ink: 0, banishSelf: false };
  const head = effect.split("—")[0] ?? "";
  const inkMatch = head.match(/(\d+)\s*\{i\}/i);
  return {
    exert: /\{e\}/i.test(head),
    ink: inkMatch ? parseInt(inkMatch[1]!, 10) : 0,
    banishSelf: /banish this/i.test(head),
  };
}

/** Begin a player's turn: ready/set/draw. The first player skips the very first draw. */
function startTurn(state: GameState, player: PlayerId, logs: LogEntry[], isOpeningTurn: boolean, effects?: CardEffects): void {
  state.currentPlayer = player;
  state.hasInkedThisTurn = false;
  // Fresh per-turn windows for both players.
  for (const pid of [1, 2] as PlayerId[]) {
    state.players[pid].discardedThisTurn = 0;
    state.players[pid].playedThisTurn = [];
    state.players[pid].ownToyBanishedThisTurn = false;
    state.players[pid].removedDamageThisTurn = false;
    state.players[pid].enemyBanishedInChallengeThisTurn = false;
    state.players[pid].challengedThisTurn = false;
  }
  state.players[player].extraInk = 0;
  state.endStepDone = false;
  state.usedActivated = [];
  state.banishedNamesThisTurn = [];
  state.anyBanishedThisTurn = false;
  // "Can't be challenged until your next turn" expires when the caster's turn begins.
  for (const pid of [1, 2] as PlayerId[]) for (const c of state.players[pid].field) if (c.cantBeChallengedUntil === player) c.cantBeChallengedUntil = undefined;
  // "Until the start of your next turn" effects expire when their caster's turn begins.
  for (const pid of [1, 2] as PlayerId[]) {
    for (const c of [...state.players[pid].field, ...state.players[pid].items]) {
      c.appliedEffects = c.appliedEffects.filter((e) => !(e.duration === "untilNextTurn" && e.castBy === player));
    }
  }
  // A lockout ("opponents can't play …") expires when its caster's turn begins.
  if (state.lockout && state.lockout.caster === player) delete state.lockout;
  const p = state.players[player];

  // Ready step: ready all cards, clear drying. Demona "Stone by Day" can't ready
  // while its controller holds 3+ cards.
  for (const c of [...p.field, ...p.items, ...p.inkwell]) {
    c.justPlayed = false;
    c.questLockedThisTurn = false;
    c.damageShieldedThisTurn = false;
    c.challengeReadyThisTurn = false;
    const stoneLocked = p.hand.length >= 3 && c.printed.specialAbilities.some((a) => a.slug === "stonebyday");
    // "Rooted by Fear" (Mor'du): your other characters can't ready at the start of your turn.
    const rootLocked = c.printed.name.toLowerCase() !== "mor'du" && p.field.some((g) => g.printed.specialAbilities.some((a) => a.slug === "rootedbyfear"));
    if (c.cantReadyNextTurn) { c.cantReadyNextTurn = false; continue; } // skip readying once, then clear
    if (!stoneLocked && !rootLocked) c.exerted = false;
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
  // "Whenever you draw" / opponent-draw watches (Royal Guard, Diablo - Devoted).
  if (effects) {
    fireWatch(state, "on_draw", player, logs, effects);
    fireWatch(state, "on_opponent_draw", otherPlayer(player), logs, effects);
  }

  // Locations passively generate lore at the start of their controller's turn.
  for (const c of p.field) {
    if (c.printed.type !== "location") continue;
    const loc = effectiveLore(state, c);
    if (loc > 0) {
      p.lore += loc;
      logs.push(log({ turnNumber: state.turnNumber, player, type: "LORE_GAINED", message: `${c.printed.fullName} generated ${loc} lore`, data: { lore: p.lore }, cardRefs: [{ id: c.printed.id, name: c.printed.fullName }] }));
    }
  }

  // Start-of-turn triggers go to the bag (resolved by this player).
  if (effects) {
    fireForController(state, "start_of_turn", player, logs, effects);
    // Some start-of-turn abilities fire from the discard (e.g. Lilo "play me").
    // Only fire covered ones — don't surface manual prompts for stray discards.
    for (const c of [...state.players[player].discard]) {
      if (c.printed.specialAbilities.some((a) => (effects[a.slug] ?? []).some((d) => d.trigger === "start_of_turn"))) {
        fireTrigger(state, "start_of_turn", c, player, logs, effects, false);
      }
    }
  }
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

const BAG_BLOCKED = new Set(["ADD_TO_INK", "PLAY_CARD", "QUEST", "MOVE_TO_LOCATION", "ACTIVATE_ABILITY", "ATTACK", "END_TURN"]);

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
        startTurn(next, next.firstPlayer!, logs, true, effects);
      }
      return { state: next, logs };
    }

    case "ADD_TO_INK": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const inkP = next.players[next.currentPlayer];
      // One ink per turn, plus any granted extra inkings (Sail the Azurite Sea).
      if (next.hasInkedThisTurn && (inkP.extraInk ?? 0) <= 0) throw new GameError("Already inked this turn");
      const p = inkP;
      let idx = p.hand.findIndex((c) => c.instanceId === action.cardInstanceId);
      let fromZone: CardInstance[] = p.hand;
      // Moana "Ancestral Legacy": you can ink cards from your discard too.
      if (idx < 0 && p.field.some((c) => c.printed.specialAbilities.some((a) => a.slug === "ancestrallegacy"))) {
        idx = p.discard.findIndex((c) => c.instanceId === action.cardInstanceId);
        if (idx >= 0) fromZone = p.discard;
      }
      if (idx < 0) throw new GameError("Card not in hand");
      const card = fromZone[idx]!;
      if (!card.printed.inkable) throw new GameError("Card is not inkable");
      fromZone.splice(idx, 1);
      card.exerted = false;
      card.justPlayed = true; // shown face-up in the inkwell until end of this turn
      p.inkwell.push(card);
      if (!next.hasInkedThisTurn) next.hasInkedThisTurn = true;
      else p.extraInk -= 1;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PUT_INTO_INKWELL", message: `${p.name} inked ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
      // "Whenever a card is put into your inkwell" (Sapphire Coil "brilliant shine").
      fireWatch(next, "on_inkwell_added", next.currentPlayer, logs, effects, banished);
      drainBanish(next, banished, logs, effects);
      return { state: next, logs };
    }

    case "PLAY_CARD": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const p = next.players[next.currentPlayer];
      const idx = p.hand.findIndex((c) => c.instanceId === action.cardInstanceId);
      if (idx < 0) throw new GameError("Card not in hand");
      const card = p.hand[idx]!;

      // Lockout: opponents can't play actions (or items) until the caster's next turn.
      if (next.lockout && next.lockout.caster !== next.currentPlayer) {
        if (card.printed.type === "action" || card.printed.type === "song") throw new GameError("You can't play actions right now");
        if (next.lockout.items && card.printed.type === "item") throw new GameError("You can't play items right now");
      }

      // --- Shift: play onto a same-name character for the Shift cost (§10.8) ---
      if (action.shiftOnto) {
        const shiftCost = keywordValue(next, card, "Shift");
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
        recordPlay(p, card);
        fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true, banished);
        // The shifted-over card is now under the new one (Cheshire "it's loads of fun").
        if (card.cardsUnder.length > 0) { fireTrigger(next, "on_put_under", card, next.currentPlayer, logs, effects, true, banished); fireWatch(next, "on_any_put_under", next.currentPlayer, logs, effects, banished); }
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
          singValue += Math.max(s.printed.cost, keywordValue(next, s, "Singer"));
          return s;
        });
        if (singValue < card.printed.cost) throw new GameError("Singers can't afford this song");
        for (const s of singers) s.exerted = true;
        p.hand.splice(idx, 1);
        p.discard.push(card);
        p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1;
        recordPlay(p, card);
        logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `${p.name} sang ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
        fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true, banished);
        fireForController(next, "on_play_action", next.currentPlayer, logs, effects, banished);
        fireForController(next, "on_play_song", next.currentPlayer, logs, effects, banished);
        // A sung song pays no ink (≤ 2) → "whenever you pay 2 {I} or less to play a card".
        fireForController(next, "on_play_cheap", next.currentPlayer, logs, effects, banished);
        // Ursula "What a Deal": a singer may re-play the song from discard for free,
        // then put it on the bottom of the deck (auto-resolved here).
        if (singers.some((s) => s.printed.specialAbilities.some((a) => a.slug === "whatadeal"))) {
          fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, false, banished);
          const di = p.discard.indexOf(card);
          if (di >= 0) { p.discard.splice(di, 1); p.deck.push(card); }
          logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `What a Deal: replayed ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
        }
        drainBanish(next, banished, logs, effects);
        return { state: next, logs };
      }

      // --- Normal play: pay ink (after discounts + the card's own reduction) ---
      const cost = effectiveCost(next, p, card, effects);
      if (readyInk(p).length < cost) throw new GameError("Not enough ink");
      payInk(p, cost);
      consumeDiscounts(p, card.printed);
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
          p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1;
          break;
      }
      recordPlay(p, card);
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `${p.name} played ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
      fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true, banished);
      if (card.printed.type === "action" || card.printed.type === "song") fireForController(next, "on_play_action", next.currentPlayer, logs, effects, banished);
      if (card.printed.type === "song") fireForController(next, "on_play_song", next.currentPlayer, logs, effects, banished);
      if (card.printed.type === "character") fireForController(next, "on_play_character", next.currentPlayer, logs, effects, banished, card.instanceId);
      if (card.printed.type === "location") fireForController(next, "on_play_location", next.currentPlayer, logs, effects, banished);
      if (card.printed.type === "item") {
        // Item watchers (e.g. Maurice's Workshop) sit in the items zone, not the field.
        for (const w of [...next.players[next.currentPlayer].field, ...next.players[next.currentPlayer].items]) {
          if (w.instanceId === card.instanceId) continue;
          fireTrigger(next, "on_play_item", w, next.currentPlayer, logs, effects, true, banished);
        }
      }
      // "Whenever you pay 2 {I} or less to play a card" (Jessie, Buzz, Babyhead) —
      // the card being played doesn't see its own entry.
      if (cost <= 2) fireForController(next, "on_play_cheap", next.currentPlayer, logs, effects, banished, card.instanceId);
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
      if (card.questLockedThisTurn) throw new GameError("This character can't quest this turn");
      // Dash "Record Time" may quest the turn he's played (ignores drying).
      const questAnyTime = card.printed.specialAbilities.some((a) => a.slug === "recordtime");
      if (card.justPlayed && !questAnyTime) throw new GameError("Character is drying (played this turn)");
      // RC "Low Batteries": pay 1 {I} each time it quests.
      if (card.printed.specialAbilities.some((a) => a.slug === "lowbatteries")) {
        if (readyInk(p).length < 1) throw new GameError("This character must pay 1 ink to quest");
        payInk(p, 1);
      }
      card.exerted = true;
      const gained = effectiveLore(next, card);
      p.lore += gained;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_QUEST", message: `${card.printed.fullName} quested for ${gained}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "LORE_GAINED", message: `${p.name} now has ${p.lore} lore`, data: { lore: p.lore } }));
      fireTrigger(next, "on_quest", card, next.currentPlayer, logs, effects, true, banished);
      // "Whenever one of your other characters quests" (Mickey - Expedition Leader).
      fireAllyActor(next, "on_ally_quest", next.currentPlayer, card, "quester", logs, effects, banished);
      // "Whenever a character quests while here" (Casa Madrigal).
      if (card.atLocation) {
        const loc = next.players[next.currentPlayer].field.find((c) => c.instanceId === card.atLocation && c.printed.type === "location");
        if (loc) fireLocationHere(next, loc, next.currentPlayer, "on_quest_here", "quester", card.instanceId, logs, effects, banished);
      }
      // Support (rules §10.13): add this character's {S} to another chosen one.
      if (hasKeyword(next, card, "Support")) {
        const amount = effectiveStrength(next, card);
        const steps: Step[] = [
          { do: "chooseCharacter", as: "ally", scope: "ally", text: `add +${amount} ¤ to another character this turn` },
          { do: "buff", to: "ally", strength: amount, duration: "end_of_turn" },
        ];
        const ctx: EffectContext = { controller: next.currentPlayer, source: card, vars: {}, banished, events: makeEvents(next, logs, effects, banished) };
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
            handOwner: suspension.handOwner,
          modes: suspension.modes,
            resume: { steps: suspension.steps, vars: ctx.vars },
          });
        }
      }
      drainBanish(next, banished, logs, effects);
      return { state: next, logs };
    }

    case "MOVE_TO_LOCATION": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const p = next.players[next.currentPlayer];
      const mover = p.field.find((c) => c.instanceId === action.characterId);
      const location = p.field.find((c) => c.instanceId === action.locationId);
      if (!mover || mover.printed.type !== "character") throw new GameError("Not a character in play");
      if (!location || location.printed.type !== "location") throw new GameError("Not a location in play");
      if (mover.atLocation === location.instanceId) throw new GameError("Already at that location");
      const locSlugs = location.printed.specialAbilities.map((a) => a.slug);
      const isToy = mover.printed.subtypes.some((s) => s.toLowerCase() === "toy");
      // Free-move grants: Pizza Planet (your Toys) / Ring of Stones (your exerted).
      const freeMove = (isToy && locSlugs.includes("youarecleartoenter")) || (mover.exerted && locSlugs.includes("followyourfate"));
      const moveCost = freeMove ? 0 : (location.printed.moveCost ?? 0);
      if (readyInk(p).length < moveCost) throw new GameError("Not enough ink to move");
      payInk(p, moveCost);
      const firstHere = !p.field.some((c) => c.printed.type === "character" && c.atLocation === location.instanceId);
      mover.atLocation = location.instanceId;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `${mover.printed.fullName} moved to ${location.printed.fullName}`, cardRefs: [{ id: mover.printed.id, name: mover.printed.fullName }] }));
      // "First time you move a character here this turn" — approximate via no other
      // character currently here (Seven Dwarfs' Mine).
      if (firstHere) fireLocationHere(next, location, next.currentPlayer, "on_move_here", "mover", mover.instanceId, logs, effects, banished);
      drainBanish(next, banished, logs, effects);
      return { state: next, logs };
    }

    case "ACTIVATE_ABILITY": {
      if (next.status !== "playing") throw new GameError("Not in play");
      const p = next.players[next.currentPlayer];
      const source = [...p.field, ...p.items].find((c) => c.instanceId === action.cardInstanceId);
      if (!source) throw new GameError("Card not in play");

      // Dumbo "Making History" grants your other Evasive characters
      // "{E}, 1 {I} — Draw a card and gain 1 lore."
      if (action.slug === "makinghistory") {
        if (!hasKeyword(next, source, "Evasive")) throw new GameError("Only Evasive characters have this ability");
        if (!p.field.some((c) => c.instanceId !== source.instanceId && c.printed.specialAbilities.some((a) => a.slug === "makinghistory"))) throw new GameError("No granting character in play");
        if (source.exerted) throw new GameError("Source is already exerted");
        if (source.printed.type === "character" && source.justPlayed) throw new GameError("Character is drying");
        if (readyInk(p).length < 1) throw new GameError("Not enough ink");
        source.exerted = true;
        payInk(p, 1);
        drawCards(p, 1);
        p.lore += 1;
        logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "ABILITY_TRIGGERED", message: `${source.printed.fullName} drew a card and gained 1 lore`, data: { lore: p.lore } }));
        return { state: next, logs };
      }

      // Boost: "Once during your turn, pay N {I} to put the top card of your deck
      // facedown under this character." (Cheshire Cat, Pete - Ghost.)
      if (action.slug === "boost") {
        if (!source.printed.abilities.some((a) => a.ability.toLowerCase().startsWith("boost"))) throw new GameError("Card has no Boost");
        const m = source.printed.rulesText.match(/boost\D*(\d+)\s*\{i\}/i);
        const cost = m ? parseInt(m[1]!, 10) : 0;
        const onceKey = `${source.instanceId}:boost`;
        if ((next.usedActivated ?? []).includes(onceKey)) throw new GameError("Already boosted this turn");
        if (readyInk(p).length < cost) throw new GameError("Not enough ink");
        payInk(p, cost);
        (next.usedActivated ??= []).push(onceKey);
        const top = p.deck.shift();
        if (top) {
          source.cardsUnder.push(top);
          logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "ABILITY_TRIGGERED", message: `${p.name} boosted ${source.printed.fullName}`, cardRefs: [{ id: source.printed.id, name: source.printed.fullName }] }));
          fireTrigger(next, "on_put_under", source, next.currentPlayer, logs, effects, true, banished);
          fireWatch(next, "on_any_put_under", next.currentPlayer, logs, effects, banished);
        }
        drainBanish(next, banished, logs, effects);
        return { state: next, logs };
      }

      const sa = source.printed.specialAbilities.find(
        (a) => (action.slug ? a.slug === action.slug : true) && classifyTrigger(a.effect, source.printed.type) === "activated",
      );
      if (!sa) throw new GameError("No activated ability to use");

      // "Once during your turn" abilities (no cost) may only be used once per turn.
      const onceKey = `${source.instanceId}:${sa.slug}`;
      const isOncePerTurn = /^once (during|per) your turn/.test(sa.effect.trim().toLowerCase());
      if (isOncePerTurn && (next.usedActivated ?? []).includes(onceKey)) throw new GameError("Already used this turn");

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
      if (isOncePerTurn) (next.usedActivated ??= []).push(onceKey);
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
      if (attacker.printed.specialAbilities.some((a) => a.slug === "standshisground" || a.slug === "icebath")) throw new GameError("This character can't challenge");
      if (attacker.cantChallengeNextTurn) throw new GameError("This character can't challenge this turn");
      if (attacker.justPlayed && !hasKeyword(next, attacker, "Rush")) throw new GameError("Attacker is drying");
      // RC "Low Batteries": pay 1 {I} each time it challenges.
      if (attacker.printed.specialAbilities.some((a) => a.slug === "lowbatteries")) {
        if (readyInk(ap).length < 1) throw new GameError("This character must pay 1 ink to challenge");
        payInk(ap, 1);
      }

      const defender = dp.field.find((c) => c.instanceId === action.defenderId);
      if (!defender) throw new GameError("Defender is not in play");
      const defenderIsChar = defender.printed.type === "character";
      // Cinderella "The Singing Sword" lets the attacker challenge ready characters.
      if (defenderIsChar && !defender.exerted && !attacker.challengeReadyThisTurn) throw new GameError("Can only challenge exerted characters");
      if (defenderIsChar && hasKeyword(next, defender, "Evasive") && !hasKeyword(next, attacker, "Evasive") && !hasKeyword(next, attacker, "Alert")) {
        throw new GameError("Only Evasive characters can challenge an Evasive character");
      }
      // Diablo - Stone Servant "Villainous Bond": while it's exerted, your Villains can't be challenged.
      if (defenderIsChar && defender.printed.subtypes.some((s) => s.toLowerCase() === "villain") &&
          dp.field.some((c) => c.exerted && c.printed.specialAbilities.some((a) => a.slug === "villainousbond"))) {
        throw new GameError("That character can't be challenged");
      }
      // Bodyguard: if a legal enemy target has Bodyguard, one must be chosen.
      const legalTargets = dp.field.filter((c) => c.printed.type !== "character" || c.exerted);
      const hasBodyguardTarget = legalTargets.some((c) => hasKeyword(next, c, "Bodyguard"));
      if (hasBodyguardTarget && !hasKeyword(next, defender, "Bodyguard")) {
        throw new GameError("Must challenge a character with Bodyguard");
      }

      if (defenderIsChar && defender.cantBeChallengedUntil != null) throw new GameError("That character can't be challenged right now");
      // Declaration: the attacker exerts, then any "whenever this challenges"
      // ability goes on the bag.
      attacker.exerted = true;
      next.players[next.currentPlayer].challengedThisTurn = true;
      fireTrigger(next, "on_challenge", attacker, next.currentPlayer, logs, effects, true, banished);
      // "Whenever a character here challenges another character" (Beast's Castle).
      if (attacker.atLocation) {
        const al = ap.field.find((c) => c.instanceId === attacker.atLocation && c.printed.type === "location");
        if (al) fireLocationHere(next, al, next.currentPlayer, "on_challenge_from_here", "challenger", attacker.instanceId, logs, effects, banished);
      }
      // "Whenever one of your [Super] characters challenges" (Mr. Incredible).
      fireAllyActor(next, "on_ally_challenge", next.currentPlayer, attacker, "challenger", logs, effects, banished);
      if (defenderIsChar) {
        fireTrigger(next, "on_challenged", defender, otherPlayer(next.currentPlayer), logs, effects, true, banished);
        fireAllyChallenged(next, otherPlayer(next.currentPlayer), attacker, defender.instanceId, logs, effects, banished);
        // "Whenever a character is challenged while here" (Pizza Planet).
        if (defender.atLocation) {
          const dl = dp.field.find((c) => c.instanceId === defender.atLocation && c.printed.type === "location");
          if (dl) fireLocationHere(next, dl, otherPlayer(next.currentPlayer), "on_challenged_here", "challenged", defender.instanceId, logs, effects, banished);
        }
      }

      // Challenge damage (simultaneous), with Challenger +N and Resist applied.
      // Dale "Spike Suit": your characters deal challenge damage with willpower.
      const atkBase = hasControllerStatic(next, next.currentPlayer, "spikesuit") ? effectiveWillpower(next, attacker) : effectiveStrength(next, attacker);
      const defBase = !defenderIsChar ? 0 : hasControllerStatic(next, otherPlayer(next.currentPlayer), "spikesuit") ? effectiveWillpower(next, defender) : effectiveStrength(next, defender);
      const atkStrength = atkBase + keywordValue(next, attacker, "Challenger");
      const defStrength = defBase;
      let toDefender = Math.max(0, atkStrength - keywordValue(next, defender, "Resist"));
      let toAttacker = Math.max(0, defStrength - keywordValue(next, attacker, "Resist"));
      // Damage-prevention (Hercules - Mighty Leader, Lilo - Bundled Up). The
      // defender is "being challenged"; the attacker is not.
      if (defenderIsChar && toDefender > 0 && damagePrevented(next, defender, "defender")) toDefender = 0;
      if (toAttacker > 0 && damagePrevented(next, attacker, "attacker")) toAttacker = 0;
      defender.damage += toDefender;
      attacker.damage += toAttacker;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_ATTACK", message: `${attacker.printed.fullName} challenged ${defender.printed.fullName}`, cardRefs: [{ id: attacker.printed.id, name: attacker.printed.fullName }, { id: defender.printed.id, name: defender.printed.fullName }] }));

      // Banish anything that took lethal damage (simultaneous).
      const defenderDies = defenderIsChar && isBanished(next, defender);
      const attackerDies = isBanished(next, attacker);
      if (defenderDies) { banishCard(dp, defender, logs, next.turnNumber); banished.push({ card: defender, owner: otherPlayer(next.currentPlayer) }); next.players[next.currentPlayer].enemyBanishedInChallengeThisTurn = true; }
      if (attackerDies) { banishCard(ap, attacker, logs, next.turnNumber); banished.push({ card: attacker, owner: next.currentPlayer }); next.players[otherPlayer(next.currentPlayer)].enemyBanishedInChallengeThisTurn = true; }
      // "Whenever this character banishes another character in a challenge" — only
      // if the attacker survived to do the banishing (Calhoun, Robin, Tinker Bell).
      if (defenderDies && !attackerDies) {
        fireTrigger(next, "on_challenge_banish", attacker, next.currentPlayer, logs, effects, true, banished);
        // "Whenever one of your other [Steel] characters banishes in a challenge" (Pluto - Steel).
        fireAllyActor(next, "on_ally_challenge_banish", next.currentPlayer, attacker, "challenger", logs, effects, banished);
        // "...banishes another in a challenge while here" (Island of Nomanisan).
        if (attacker.atLocation) {
          const al = ap.field.find((c) => c.instanceId === attacker.atLocation && c.printed.type === "location");
          if (al) fireLocationHere(next, al, next.currentPlayer, "on_challenge_banish_here", "banisher", attacker.instanceId, logs, effects, banished);
        }
      }
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
          const ctx: EffectContext = { controller: prompt.controller, source, vars: prompt.resume.vars, banished, events: makeEvents(next, logs, effects, banished) };
          let steps = prompt.resume.steps;
          let inject = action.targetInstanceId;
          const lead = steps[0];
          if (lead && lead.do === "mayConfirm") {
            // Yes (a sentinel target) runs on; No (no target) aborts the effect.
            if (action.targetInstanceId == null) steps = [];
          } else if (lead && lead.do === "modal") {
            // The chosen option index arrives as the "target"; default to the first.
            const idx = action.targetInstanceId != null ? parseInt(action.targetInstanceId, 10) : 0;
            inject = String(Number.isFinite(idx) && idx >= 0 && idx < lead.options.length ? idx : 0);
          } else if (lead && lead.do === "lookAtTop") {
            const pd = next.players[prompt.controller].deck;
            const kept = parseInt(prompt.resume.vars["__scryKept"] ?? "0", 10);
            const n = parseInt(prompt.resume.vars["__scryN"] ?? String(lead.count), 10);
            const window = pd.slice(0, Math.max(0, n - kept));
            const legal = window.filter((c) => scryMatch(c.printed, lead.filter));
            if (action.targetInstanceId != null) {
              if (!legal.some((c) => c.instanceId === action.targetInstanceId)) throw new GameError("Not a valid card to keep");
              inject = action.targetInstanceId;
            } else {
              // No pick: stop if allowed (optional, or already kept ≥1); else
              // force-keep the first legal card so a mandatory scry can't stall.
              const mustKeep = !(lead.optional ?? false) && kept === 0 && legal.length > 0;
              inject = mustKeep ? legal[0]!.instanceId : "__scrystop__";
            }
          } else if (lead && lead.do === "returnFromDiscard") {
            const dpile = next.players[prompt.controller].discard;
            const kept = parseInt(prompt.resume.vars["__rfdKept"] ?? "0", 10);
            const legal = dpile.filter((c) => (!lead.cardType || c.printed.type === lead.cardType) && (lead.maxCost == null || c.printed.cost <= lead.maxCost));
            if (action.targetInstanceId != null) {
              if (!legal.some((c) => c.instanceId === action.targetInstanceId)) throw new GameError("Not a valid card to return");
              inject = action.targetInstanceId;
            } else {
              const mustKeep = !(lead.optional ?? false) && kept === 0 && legal.length > 0;
              inject = mustKeep ? legal[0]!.instanceId : "__rfdstop__";
            }
          } else if (lead && lead.do === "scryTopOrBottom") {
            const pd = next.players[prompt.controller].deck;
            const window = pd.slice(0, lead.count);
            inject = action.targetInstanceId != null && window.some((c) => c.instanceId === action.targetInstanceId) ? action.targetInstanceId : "__sobstop__";
          } else if (lead && lead.do === "scryToInkwell") {
            const pd = next.players[prompt.controller].deck;
            const window = pd.slice(0, lead.count);
            if (action.targetInstanceId != null && window.some((c) => c.instanceId === action.targetInstanceId)) {
              inject = action.targetInstanceId;
            } else {
              inject = window[0]?.instanceId; // mandatory: default to the first
            }
          } else if (lead && lead.do === "playFree") {
            const from = lead.from ?? "hand";
            const zone = from === "discard" ? next.players[prompt.controller].discard : next.players[prompt.controller].hand;
            const legal = zone.filter((c) =>
              (c.printed.type === "character" || c.printed.type === "item" || c.printed.type === "location") &&
              (!lead.cardType || c.printed.type === lead.cardType) &&
              (lead.maxCost == null || c.printed.cost <= lead.maxCost) &&
              (!lead.subtype || c.printed.subtypes.some((s) => s.toLowerCase() === lead.subtype!.toLowerCase())));
            if (action.targetInstanceId != null) {
              if (!legal.some((c) => c.instanceId === action.targetInstanceId)) throw new GameError("Not a valid card to play for free");
              inject = action.targetInstanceId;
            } else {
              inject = "__pfstop__"; // declined (playFree is always optional)
            }
          } else if (lead && lead.do === "chooseItem") {
            if (action.targetInstanceId != null) {
              const loc = findInstance(next, action.targetInstanceId);
              const scope = lead.scope ?? "any";
              const okScope = !loc ? false : scope === "ally" ? loc.owner === prompt.controller : scope === "enemy" ? loc.owner !== prompt.controller : true;
              const okCost = lead.maxCost == null || (loc != null && loc.card.printed.cost <= lead.maxCost);
              if (!loc || loc.card.printed.type !== "item" || !okScope || !okCost) throw new GameError("Not a valid item");
              inject = action.targetInstanceId;
            } else if (lead.optional) {
              steps = steps.slice(1);
              inject = undefined;
            }
          } else if (lead && lead.do === "discardChoose") {
            // Mandatory discard: a valid own-hand card, or default to the first.
            const hand = next.players[prompt.controller].hand;
            if (action.targetInstanceId != null && hand.some((c) => c.instanceId === action.targetInstanceId)) inject = action.targetInstanceId;
            else inject = hand[0]?.instanceId;
          } else if (lead && (lead.do === "chooseCharacter" || lead.do === "chooseFromHand")) {
            if (action.targetInstanceId != null) {
              const loc = findInstance(next, action.targetInstanceId);
              if (lead.do === "chooseCharacter") {
                // Reject an illegal target (wrong scope, or fails the filter).
                if (!loc || loc.zone !== "field" || !targetMatches(loc.card, loc.owner, prompt.controller, lead, effectiveStrength(next, loc.card))) {
                  throw new GameError("Not a legal target for this ability");
                }
              } else {
                // chooseFromHand: the card must be in the right hand (own, or an
                // opponent's for "you choose what they discard") and match the filter.
                const handOwner = lead.from === "opponent" ? otherPlayer(prompt.controller) : prompt.controller;
                if (!loc || loc.zone !== "hand" || loc.owner !== handOwner || !handCardMatches(loc.card, lead)) {
                  throw new GameError("Not a valid card to choose");
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
              handOwner: again.handOwner,
              modes: again.modes,
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
      // End-of-turn triggers fire (and resolve) before the turn passes — once.
      if (!next.endStepDone) {
        fireForController(next, "end_of_turn", ending, logs, effects, banished);
        // "At the end of each player's turn" — fires for both players (Goliath).
        fireForController(next, "end_of_any_turn", ending, logs, effects, banished);
        fireForController(next, "end_of_any_turn", otherPlayer(ending), logs, effects, banished);
        drainBanish(next, banished, logs, effects);
        next.endStepDone = true;
        // If one needs resolving, hold the turn; the player resolves then ends again.
        if (next.pendingPrompts.length > 0) return { state: next, logs };
      }
      // Expire "until end of turn" effects across all cards.
      for (const pid of [1, 2] as PlayerId[]) {
        for (const c of [...next.players[pid].field, ...next.players[pid].items]) {
          c.appliedEffects = c.appliedEffects.filter((e) => e.duration !== "end_of_turn");
        }
      }
      // "Can't challenge during their next turn" clears at the end of that turn.
      for (const c of next.players[ending].field) c.cantChallengeNextTurn = false;
      // Freshly-inked cards flip to face-down at the end of the turn they were played.
      for (const c of next.players[ending].inkwell) c.justPlayed = false;
      // "Pay N less this turn" discounts expire at end of turn.
      next.players[ending].discounts = [];
      logs.push(log({ turnNumber: next.turnNumber, player: ending, type: "TURN_END", message: `${next.players[ending].name} ends turn` }));
      next.turnNumber += 1;
      startTurn(next, otherPlayer(ending), logs, false, effects);
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
