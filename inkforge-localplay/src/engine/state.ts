/**
 * Engine state model (spec §4.2). The engine is a pure function of
 * (state, action); it imports nothing from React, the DOM, the network, or
 * persistence. Printed card data is denormalised into each CardInstance at game
 * start (injected via a lookup), so the engine never needs the external DB
 * mid-game.
 *
 * The engine holds full state for both players; hidden-information redaction is
 * a concern of the view layer in PvP (spec §8.3), not here.
 */
import type { PrintedCard } from "@/data/card-types";
import type { Scope, Step } from "./effects/dsl";

export type GameStatus = "coin_toss" | "mulligan" | "playing" | "finished";
export type PlayerId = 1 | 2;
export type VictoryReason = "lore" | "concession" | "deckout";

export interface AppliedEffect {
  source: string;
  strength?: number;
  willpower?: number;
  lore?: number;
  /** When the effect expires. */
  duration: "end_of_turn" | "permanent";
}

export interface CardInstance {
  /** Unique per physical card in this game. */
  instanceId: string;
  /** Denormalised printed data (copied at game start). */
  printed: PrintedCard;
  // Runtime:
  damage: number;
  exerted: boolean;
  /** "drying" — played this turn, can't quest/challenge yet (Rush exempts challenge). */
  justPlayed: boolean;
  appliedEffects: AppliedEffect[];
  /** Shift stacks / tucked cards. */
  cardsUnder: CardInstance[];
}

export interface PlayerState {
  name: string;
  hand: CardInstance[];
  field: CardInstance[]; // characters + locations in play
  items: CardInstance[];
  inkwell: CardInstance[]; // facedown ink
  discard: CardInstance[];
  deck: CardInstance[]; // ordered; top = index 0
  lore: number;
}

export interface CoinToss {
  /** The player who won the toss and chooses who goes first. */
  winner: PlayerId;
}

export interface MulliganState {
  done: Record<PlayerId, boolean>;
}

export interface Prompt {
  id: string;
  /** Player who must resolve this. */
  player: PlayerId;
  /** Source card instance, if any. */
  sourceInstanceId?: string;
  /** Ability slug / kind ("manual" for an uncovered ability). */
  kind: string;
  /** Human-readable text (for Manual Mode). */
  text: string;
  /** Whether the engine can auto-resolve (no choice needed). */
  auto: boolean;
  /** Controller of the source, for resuming the deferred effect. */
  controller?: PlayerId;
  /** Suspended effect sequence to resume once a target is chosen. */
  resume?: { steps: Step[]; vars: Record<string, string> };
  /** Allowed target scope for the pending choice (UI hint). */
  scope?: Scope;
  /** What the resolver picks: a board character, a hand card, or a Yes/No. */
  pick?: "character" | "hand" | "confirm";
}

export interface GameState {
  id: string;
  status: GameStatus;
  currentPlayer: PlayerId;
  turnNumber: number;
  firstPlayer: PlayerId | null;
  hasInkedThisTurn: boolean;
  players: Record<PlayerId, PlayerState>;
  /** "the bag" — triggered abilities awaiting resolution (spec §4.6). */
  pendingPrompts: Prompt[];
  coinToss?: CoinToss;
  mulliganState?: MulliganState;
  winner: PlayerId | null;
  victoryReason?: VictoryReason;
  rngSeed: string;
  rngCursor: number;
}

export const WIN_LORE = 20;
export const OPENING_HAND = 7;

export const otherPlayer = (p: PlayerId): PlayerId => (p === 1 ? 2 : 1);

/** Printed-card lookup injected by the caller — keeps the engine DB-free. */
export type CardLookup = (id: string) => PrintedCard | undefined;
