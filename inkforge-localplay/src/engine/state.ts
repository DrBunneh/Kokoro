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
  /** A keyword granted for the duration (e.g. "Challenger", "Rush", "Evasive"). */
  keyword?: string;
  /** Numeric value for a stacking granted keyword (e.g. Challenger +3). */
  keywordValue?: number;
  /** When the effect expires. "untilNextTurn" lasts until `castBy`'s next turn begins. */
  duration: "end_of_turn" | "permanent" | "untilNextTurn";
  /** The player who applied this effect — used to expire "untilNextTurn" effects. */
  castBy?: PlayerId;
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
  /** Number of cards that were under this card when it was last banished (on_banish payoffs). */
  banishedUnderCount?: number;
  /** Readied but barred from questing for the rest of this turn (Lilo - Causing an Uproar). */
  questLockedThisTurn?: boolean;
  /** Used this turn's one-time damage shield (Lilo - Bundled Up "extra layers"). */
  damageShieldedThisTurn?: boolean;
  /** May challenge ready (unexerted) characters this turn (Cinderella - Stouthearted). */
  challengeReadyThisTurn?: boolean;
  /** The location (instanceId) this character is currently at, if any. */
  atLocation?: string;
  /** Can't challenge during its controller's next turn (cleared at their turn end). */
  cantChallengeNextTurn?: boolean;
  /** Can't ready at the start of its controller's next turn (cleared when skipped). */
  cantReadyNextTurn?: boolean;
  /** Can't be challenged until the caster's next turn (Mother Will Protect You). */
  cantBeChallengedUntil?: PlayerId;
}

/** A turn-scoped "pay N less for the next matching play" discount. */
export interface Discount {
  amount: number;
  cardType?: import("@/data/card-types").CardType;
  /** If set, the played card must have one of these subtypes (e.g. Princess/Queen). */
  subtypes?: string[];
  /** Remaining applications this turn. */
  uses: number;
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
  /** Pending "pay N less" discounts, cleared at end of turn. */
  discounts: Discount[];
  /** Extra inkings allowed this turn beyond the normal one (reset each turn). */
  extraInk: number;
  /** Cards put into this player's discard this turn (for "if 2+ discarded" gates). */
  discardedThisTurn: number;
  /** Cards this player has played this turn (for "if you played a Princess" gates). */
  playedThisTurn: { type: import("@/data/card-types").CardType; subtypes: string[]; name: string; id?: string }[];
  /** One of this player's own Toy characters was banished this turn (Wind-Up Frog). */
  ownToyBanishedThisTurn?: boolean;
  /** This player removed damage from a character this turn (Julieta's Arepas). */
  removedDamageThisTurn?: boolean;
  /** An opposing character was banished in a challenge this turn (Card Advantage). */
  enemyBanishedInChallengeThisTurn?: boolean;
  /** One of this player's characters challenged this turn (John Smith, Mother's Necklace). */
  challengedThisTurn?: boolean;
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
  /** What the resolver picks. */
  pick?: "character" | "hand" | "confirm" | "deck" | "item" | "discard" | "mode";
  /** For pick === "deck"/"discard": the revealed card instanceIds to show face-up. */
  reveal?: string[];
  /** For pick === "hand": whose hand to choose from (self or an opponent's). */
  handOwner?: PlayerId;
  /** For pick === "mode": the option labels to choose between. */
  modes?: string[];
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
  /** "Opponents can't play actions (or items) until the caster's next turn." */
  lockout?: { caster: PlayerId; items: boolean };
  /** Whether the current turn's end-of-turn triggers have already fired. */
  endStepDone?: boolean;
  /** "instanceId:slug" of free once-per-turn abilities already used this turn. */
  usedActivated?: string[];
  /** Re-entrancy guard so a draw/discard watch's own draws don't cascade. */
  eventGuard?: boolean;
  /** Names of characters banished this turn (Buzz's Arm "Missing Piece"). Reset each turn. */
  banishedNamesThisTurn?: string[];
  /** Any character was banished this turn (Marching Off to Battle). Reset each turn. */
  anyBanishedThisTurn?: boolean;
}

export const WIN_LORE = 20;
export const OPENING_HAND = 7;

export const otherPlayer = (p: PlayerId): PlayerId => (p === 1 ? 2 : 1);

/** Printed-card lookup injected by the caller — keeps the engine DB-free. */
export type CardLookup = (id: string) => PrintedCard | undefined;
