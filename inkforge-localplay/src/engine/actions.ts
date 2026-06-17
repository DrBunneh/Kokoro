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
import { makeFrame, type Frame, type LogEntry } from "./replay";

export type Action =
  | { type: "CHOOSE_STARTING_PLAYER"; player: PlayerId }
  | { type: "MULLIGAN"; player: PlayerId; cardInstanceIds: string[] }
  | { type: "ADD_TO_INK"; cardInstanceId: string }
  | { type: "PLAY_CARD"; cardInstanceId: string }
  | { type: "QUEST"; cardInstanceId: string }
  | { type: "END_TURN" }
  | { type: "GAME_FINISH"; winner: PlayerId; reason: "concession" };

export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}

let logSeq = 0;
function log(
  partial: Omit<LogEntry, "id" | "timestamp"> & { timestamp?: number },
): LogEntry {
  return { id: `log-${logSeq++}`, timestamp: partial.timestamp ?? Date.now(), ...partial };
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

/** Draw `n` from the top of a player's deck; returns false if they decked out. */
function drawCards(p: PlayerState, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const card = p.deck.shift();
    if (!card) return false;
    p.hand.push(card);
  }
  return true;
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

/** Pure rules reducer. Returns the next state and logs; throws on illegal actions. */
export function reduce(state: GameState, action: Action): { state: GameState; logs: LogEntry[] } {
  if (state.status === "finished") throw new GameError("Game is finished");
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
          // Effects resolve via the DSL / Manual Mode (later WP); the card goes
          // to discard after resolving.
          p.discard.push(card);
          break;
      }
      logs.push(log({ turnNumber: next.turnNumber, player: next.currentPlayer, type: "CARD_PLAYED", message: `${p.name} played ${card.printed.fullName}`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
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
): ApplyResult {
  const { state: nextState, logs } = reduce(state, action);
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
