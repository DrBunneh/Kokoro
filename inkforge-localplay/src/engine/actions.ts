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
import { runSteps, type CardEffects, type EffectContext, type Step, type Trigger } from "./effects/dsl";
import { cardEffects as defaultCardEffects } from "./effects";
import { uid } from "@/lib/id";

export type Action =
  | { type: "CHOOSE_STARTING_PLAYER"; player: PlayerId }
  | { type: "MULLIGAN"; player: PlayerId; cardInstanceIds: string[] }
  | { type: "ADD_TO_INK"; cardInstanceId: string }
  | { type: "PLAY_CARD"; cardInstanceId: string; shiftOnto?: string; singers?: string[] }
  | { type: "QUEST"; cardInstanceId: string }
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
function fireTrigger(
  state: GameState,
  trigger: Trigger,
  source: CardInstance,
  controller: PlayerId,
  logs: LogEntry[],
  effects: CardEffects,
  surfaceManual: boolean,
): void {
  for (const sa of source.printed.specialAbilities) {
    const defs = effects[sa.slug] ?? [];
    const matching = defs.filter((d) => d.trigger === trigger);

    if (matching.length > 0) {
      for (const def of matching) {
        const ctx: EffectContext = { controller, source, vars: {} };
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
            resume: { steps: suspension.steps, vars: ctx.vars },
          });
        } else {
          logs.push(log({ turnNumber: state.turnNumber, player: controller, type: "ABILITY_TRIGGERED", message: `${sa.name} resolved`, cardRefs: [{ id: source.printed.id, name: source.printed.fullName }] }));
        }
      }
      continue;
    }

    // Not in the DSL — surface for Manual Mode (T2 honesty), on play only.
    if (surfaceManual && defs.length === 0) {
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

const BAG_BLOCKED = new Set(["ADD_TO_INK", "PLAY_CARD", "QUEST", "ATTACK", "END_TURN"]);

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
        fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true);
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
        fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true);
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
      fireTrigger(next, "on_play", card, next.currentPlayer, logs, effects, true);
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
      fireTrigger(next, "on_quest", card, next.currentPlayer, logs, effects, false);
      // Support (rules §10.13): add this character's {S} to another chosen one.
      if (hasKeyword(card, "Support")) {
        const amount = effectiveStrength(card);
        const steps: Step[] = [
          { do: "chooseCharacter", as: "ally", scope: "ally", text: `add +${amount} ¤ to another character this turn` },
          { do: "buff", to: "ally", strength: amount, duration: "end_of_turn" },
        ];
        const ctx: EffectContext = { controller: next.currentPlayer, source: card, vars: {} };
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
            resume: { steps: suspension.steps, vars: ctx.vars },
          });
        }
      }
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

      // Declaration: the attacker exerts.
      attacker.exerted = true;

      // Challenge damage (simultaneous), with Challenger +N and Resist applied.
      const atkStrength = effectiveStrength(attacker) + keywordValue(attacker, "Challenger");
      const defStrength = defenderIsChar ? effectiveStrength(defender) : 0;
      const toDefender = Math.max(0, atkStrength - keywordValue(defender, "Resist"));
      const toAttacker = Math.max(0, defStrength - keywordValue(attacker, "Resist"));
      defender.damage += toDefender;
      attacker.damage += toAttacker;
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_ATTACK", message: `${attacker.printed.fullName} challenged ${defender.printed.fullName}`, cardRefs: [{ id: attacker.printed.id, name: attacker.printed.fullName }, { id: defender.printed.id, name: defender.printed.fullName }] }));

      // Banish anything that took lethal damage (simultaneous).
      if (isBanished(defender)) banishCard(dp, defender, logs, next.turnNumber);
      if (isBanished(attacker)) banishCard(ap, attacker, logs, next.turnNumber);
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
          const ctx: EffectContext = { controller: prompt.controller, source, vars: prompt.resume.vars };
          // The follow-up may itself need another choice → re-suspend a prompt.
          const again = runSteps(next, prompt.resume.steps, ctx, logs, action.targetInstanceId);
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
              resume: { steps: again.steps, vars: ctx.vars },
            });
          }
        }
      }
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
