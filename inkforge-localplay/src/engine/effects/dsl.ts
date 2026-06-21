/**
 * Composable effect DSL (spec §7, revised). An effect is an ordered list of
 * primitive **actions**; the interpreter runs them in sequence. A `choose…`
 * step that needs a target suspends the sequence (pushing a prompt); resuming
 * binds the chosen target into the context and continues. Most cards reuse a
 * small set of primitives, so coverage grows by data, not code.
 */
import { otherPlayer, type CardInstance, type GameState, type PlayerId } from "../state";
import { makeLog, type LogEntry } from "../replay";
import { banishCard, drawCards, findInstance } from "../zones";
import { effectiveStrength, effectiveWillpower, effectiveLore } from "../keywords";
import { damagePrevented } from "../continuous";
import { Rng } from "../rng";
import { uid } from "@/lib/id";
import type { CardType } from "@/data/card-types";

export type Trigger =
  | "on_play"
  | "on_quest"
  | "on_challenge"
  | "on_banish"
  | "on_challenged" // when THIS character is challenged
  | "on_ally_challenged" // when one of your characters is challenged (binds `challenger`)
  | "on_ally_quest" // when one of your OTHER characters quests (binds `quester`)
  | "on_ally_challenge" // when one of your characters challenges (actor = attacker)
  | "on_ally_challenge_banish" // when one of your OTHER characters banishes in a challenge
  | "on_play_action" // whenever you play an action/song (for your other cards)
  | "on_play_song" // whenever you play a song specifically
  | "on_play_character" // whenever you play a character (for your other cards)
  | "on_play_item" // whenever you play an item (for your other cards)
  | "on_play_location" // whenever you play a location (for your other cards)
  | "on_any_put_under" // whenever you put a card under one of your cards (controller-wide)
  | "on_play_cheap" // whenever you pay 2 {I} or less to play a card (for your other cards)
  | "on_challenge_banish" // when this character banishes another in a challenge
  | "on_other_banished" // whenever any character is banished (controller-wide watch)
  | "on_inkwell_added" // whenever a card is put into your inkwell (controller-wide watch)
  | "on_draw" // whenever you draw a card (your field watches)
  | "on_opponent_draw" // whenever an opponent draws on their turn (your field watches)
  | "on_opponent_discard" // whenever an opponent discards a card (your field watches)
  | "on_put_under" // whenever a card is put under this character (Boost / Shift)
  | "on_remove_damage" // whenever you remove damage from one of your characters (your field watches)
  | "on_move_here" // a character was moved to this location (binds `mover`)
  | "on_quest_here" // a character quested while at this location (binds `quester`)
  | "on_banish_here" // a character was banished while at this location
  | "on_challenged_here" // a character at this location was challenged (Pizza Planet)
  | "on_challenge_banish_here" // a character here banished another in a challenge (Island of Nomanisan)
  | "on_challenge_from_here" // a character at this location challenges (Beast's Castle)
  | "on_item_banished" // whenever an item is banished, during your turn
  | "start_of_turn"
  | "end_of_turn"
  | "end_of_any_turn" // at the end of either player's turn (Goliath - Clan Leader)
  | "activated"
  | "cost"; // passive self-cost reduction, evaluated when this card is played

export type Scope = "any" | "ally" | "enemy";
export type Who = "self" | "opponent";

/** A predicate that gates whether an effect fires (Lorcana "if …" clauses). */
export interface Condition {
  /** You played a card of this type this turn. */
  playedType?: CardType;
  /** You played a character with this subtype this turn (e.g. "Princess"). */
  playedSubtype?: string;
  /** You played a character *other than the source* this turn ("Traveler" cards). */
  playedOtherCharacterThisTurn?: boolean;
  /** At least N cards were put into your discard this turn. */
  discardedAtLeast?: number;
  /** The source character has no damage. */
  selfUndamaged?: boolean;
  /** The source character has damage on it. */
  selfDamaged?: boolean;
  /** The source character is exerted (Tiana, Merida — "while this character is exerted"). */
  selfExerted?: boolean;
  /** You have at least N exerted characters in play. */
  exertedAlliesAtLeast?: number;
  /** You have a character with this name in play. */
  haveCharacterNamed?: string;
  /** You have a character with one of these names in play (Bullseye — Woody/Jessie). */
  haveCharacterNamedAny?: string[];
  /** It's your first turn and you're not the first player. */
  firstTurnNotFirstPlayer?: boolean;
  /** The most-recently-played card this turn is of this type (for on_play_cheap). */
  lastPlayedType?: CardType;
  /** The most-recently-played card this turn is NOT a character (for on_play_cheap). */
  lastPlayedNonCharacter?: boolean;
  /** You have at least N *other* characters in play (optionally of `otherSubtype`). */
  otherCharsAtLeast?: number;
  otherSubtype?: string;
  /** An opponent has an exerted character in play (Honeymaren). */
  opponentHasExerted?: boolean;
  /** You control a character of one of these subtypes (Sleepy, Julieta's Arepas). */
  haveSubtypeAny?: string[];
  /** The most-recently-played character this turn has this subtype (Pluto - Steel). */
  lastPlayedSubtype?: string;
  /** It's currently the controller's own turn (Pterodactyl). */
  onlyYourTurn?: boolean;
  /** It's currently an opponent's turn (Rex). */
  onlyOpponentTurn?: boolean;
  /** You have a character in play with at least this {S} (Maximus). */
  haveCharStrengthAtLeast?: number;
  /** You have NO character in play with this {S} or more (Maximus "instead" tier). */
  lacksCharStrengthAtLeast?: number;
  /** You have played at least N actions/songs this turn (Lilo - Causing an Uproar). */
  actionsPlayedAtLeast?: number;
  /** (on_other_banished) the banished character had this subtype (Sid — Toy). */
  banishedSubtype?: string;
  /** (on_other_banished) the banished character was the watcher's own (Babyhead, Emerald). */
  banishedMine?: boolean;
  /** There's at least one card under the source (Ariel - Ethereal Voice). */
  selfHasCardUnder?: boolean;
  /** One of your own Toy characters was banished this turn (Wind-Up Frog). */
  ownToyBanishedThisTurn?: boolean;
  /** An opponent has more cards in their inkwell than you (Webby - Junior Prospector). */
  opponentInkwellMoreThanYou?: boolean;
  /** An opponent has more cards in hand than you (Clarabelle - Light on Her Hooves). */
  opponentHandMoreThanYou?: boolean;
  /** You have at least N characters of this subtype in your discard (Hand-in-the-Box). */
  subtypeInDiscardAtLeast?: { subtype: string; count: number };
  /** You control at least one item (Belle - Apprentice Inventor). */
  haveOwnItem?: boolean;
  /** The banished character belonged to an opponent (Headless Horseman). */
  banishedOpponent?: boolean;
  /** The triggering actor (challenger/quester) has this subtype (Mr. Incredible, Pluto-Steel). */
  actorSubtype?: string;
  /** You control at least N items (Scrooge - Resourceful Miser). */
  haveItemsAtLeast?: number;
  /** You removed damage from a character this turn (Julieta's Arepas). */
  removedDamageThisTurn?: boolean;
  /** You have a character in play with at least this {W} (Chip - Team Player, Monterey Jack). */
  haveCharWillpowerAtLeast?: number;
  /** An opponent has more characters in play than you (When You Need Help, Just Call). */
  opponentMoreCharacters?: boolean;
  /** An opposing character was banished in a challenge this turn (Card Advantage). */
  enemyBanishedInChallengeThisTurn?: boolean;
  /** A character with this name was banished this turn (Buzz's Arm). */
  nameBanishedThisTurn?: string;
  /** One of your characters challenged this turn (John Smith's Compass). */
  challengedThisTurn?: boolean;
  /** None of your characters challenged this turn (Mother's Necklace, John Smith). */
  noCharacterChallengedThisTurn?: boolean;
  /** Any character was banished this turn (Marching Off to Battle). */
  anyBanishedThisTurn?: boolean;
  /** You have a character in play with damage (Mulan - Ready for Battle). */
  haveDamagedCharacter?: boolean;
  /** You used Shift to play the source (Pocahontas - Peacekeeper) — approximated via cards-under. */
  usedShift?: boolean;
  /** An opponent has at most this much lore (Scrooge - Ebenezer "Foreclosure"). */
  opponentLoreAtMost?: number;
  /** (on_other_banished) the banished character cost at most this (Cruella - Style Icon). */
  banishedMaxCost?: number;
}

/** A magnitude that scales with the number of characters in a scope. */
export interface AmountPer {
  scope: Scope;
  excludeSelf?: boolean;
}

/** Restricts which characters are a legal target (e.g. "with 3 {S} or less"). */
export interface TargetFilter {
  maxStrength?: number;
  minStrength?: number;
  maxCost?: number;
  subtype?: string;
  /** Target must be exerted (Pocahontas — "another chosen exerted character"). */
  exerted?: boolean;
  /** Target must have damage on it (Buzz — "chosen opposing damaged character"). */
  damaged?: boolean;
  /** Target must have the Boost keyword (Roo, Lonely Grave — "with Boost"). */
  hasBoost?: boolean;
  /** Target must be a location (Touch the Sky). */
  onlyLocations?: boolean;
  /** Target must have this keyword (Wipe Out — Bodyguard). */
  hasKeyword?: string;
}

/** Restricts which revealed deck cards a scry may keep (e.g. "a song card"). */
export interface ScryFilter {
  cardType?: CardType;
  maxCost?: number;
  subtype?: string;
}

/** Does a revealed card satisfy a scry filter (used by the keep-picker)? */
export function scryMatch(card: import("@/data/card-types").PrintedCard, f?: ScryFilter): boolean {
  if (!f) return true;
  if (f.cardType && card.type !== f.cardType) return false;
  if (f.maxCost != null && card.cost > f.maxCost) return false;
  if (f.subtype && !card.subtypes.some((s) => s.toLowerCase() === f.subtype!.toLowerCase())) return false;
  return true;
}

/** A single primitive action. `to`/`target` reference a bound var name or "self". */
export type Step =
  // Targeting (suspends for a tap; binds the chosen instance to `as`):
  | { do: "chooseCharacter"; as: string; scope?: Scope; text?: string; optional?: boolean; filter?: TargetFilter; includeLocations?: boolean }
  // Optional "may" gate — suspends for a Yes/No before the steps that follow:
  | { do: "mayConfirm"; text?: string }
  // Scry: reveal the top `count` of your deck, keep up to `keepUpTo` (default 1,
  // optionally filtered) in hand, send the rest to the bottom or inkwell. When
  // `optional`, the player may keep none.
  | { do: "lookAtTop"; count: number; countFromUnder?: boolean; rest?: "bottom" | "inkwellExerted" | "discard"; filter?: ScryFilter; keepUpTo?: number; optional?: boolean; text?: string }
  // Banish every character (Be Prepared) — or a scoped subset, optionally
  // limited to damaged characters or those at/under a strength (Prince Phillip / Sisu).
  | { do: "banishAll"; scope?: Scope; damaged?: boolean; maxStrength?: number }
  // Put every matching character in scope on the bottom of their deck (Under the Sea).
  | { do: "toBottomAll"; scope?: Scope; maxStrength?: number }
  // Put every matching character into its owner's inkwell, exerted (Spooky Sight).
  | { do: "putToInkwellAll"; scope?: Scope; maxCost?: number }
  // "Choose one" of several sub-effects (Pull the Lever / Wrong Lever).
  | { do: "modal"; options: { label: string; steps: Step[] }[] }
  // Mill the top card of your deck, then run the branch matching its type
  // (Jack-Jack Parr "Weird Things Are Happening").
  | { do: "branchOnMill"; onCharacter?: Step[]; onActionItem?: Step[]; onLocation?: Step[] }
  // "Pay N less for the next matching card you play this turn."
  | { do: "grantDiscount"; amount: number; cardType?: CardType; subtypes?: string[]; uses?: number }
  // Choose a card from a hand (your own, or an opponent's revealed hand):
  | { do: "chooseFromHand"; as: string; from?: "self" | "opponent"; cardType?: CardType; excludeCardType?: CardType; text?: string; optional?: boolean }
  // Each opponent chooses and discards `amount` cards from their own hand.
  | { do: "opponentDiscard"; amount: number; cardType?: CardType; excludeCardType?: CardType }
  // Each opponent reveals their top card: cards of `cardType` go to their hand,
  // the rest to the bottom of their deck (Daisy Duck "Big Prize").
  | { do: "opponentTopByType"; cardType: CardType }
  // Each opponent chooses and banishes one of their own characters (Sid Phillips).
  | { do: "opponentBanishChoose" }
  // Grant the active player an extra ink this turn (Sail the Azurite Sea):
  | { do: "grantExtraInk"; amount?: number }
  // Move a bound (hand) card into the inkwell / discard:
  | { do: "toInkwell"; from: string; exerted?: boolean }
  | { do: "discardCard"; from: string }
  // Damage (amount may instead scale with a character count via amountPer):
  | { do: "dealDamage"; to: string; amount?: number; amountPer?: AmountPer }
  | { do: "removeDamage"; to: string; amount: number }
  // Remove up to `amount` damage from a target, then draw that many cards (Rapunzel):
  | { do: "removeDamageDraw"; to: string; amount: number }
  // Gain lore equal to the source's strength, optionally capped (Mulan):
  | { do: "gainLoreByStrength"; max?: number }
  // Gain lore equal to a bound character's stat (Pocahontas {L} / Go Go damage / Lucky Dime {L}):
  | { do: "gainLoreEqual"; from: string; stat: "lore" | "damage" | "strength" }
  // Area damage to every character in scope (optionally excluding the source):
  | { do: "dealDamageAll"; scope?: Scope; amount: number; excludeSelf?: boolean }
  // Add a bound character's own {W}/{S} to its own {S} this turn (Ranger Team-Up):
  | { do: "buffByOwnStat"; to: string; stat: "strength" | "willpower" }
  // Movement / removal:
  | { do: "banish"; to: string }
  | { do: "returnToHand"; to: string }
  // Stats (until end of turn unless duration given):
  | { do: "buff" | "debuff"; to: string; strength?: number; willpower?: number; lore?: number; duration?: "end_of_turn" | "permanent" | "untilNextTurn"; amountPer?: AmountPer }
  // Area stat change to every character in scope (optionally excluding the source):
  | { do: "buffAll" | "debuffAll"; scope?: Scope; subtype?: string; keywordFilter?: string; strength?: number; willpower?: number; lore?: number; keyword?: string; keywordValue?: number; duration?: "end_of_turn" | "permanent" | "untilNextTurn"; excludeSelf?: boolean }
  | { do: "ready" | "exert"; to: string }
  // Bar a bound character from questing for the rest of this turn (Lilo - Uproar):
  | { do: "lockQuest"; to: string }
  // Let a bound character challenge ready characters this turn (Cinderella - Stouthearted):
  | { do: "grantChallengeReady"; to: string }
  // Apply a "next turn" restriction to a bound character (Syndrome's Remote, Hamish):
  | { do: "applyStatus"; to: string; status: "cantChallengeNextTurn" | "cantReadyNextTurn" }
  // Add the source's own {S}/{W} to a bound target's strength this turn (Zipper, Support-like):
  | { do: "buffBySourceStat"; to: string; stat: "strength" | "willpower" }
  // Exert every character in scope (Demona):
  | { do: "exertAll"; scope?: Scope }
  // Grant a keyword to a target for this turn / permanently:
  | { do: "grantKeyword"; to: string; keyword: string; value?: number; duration?: "end_of_turn" | "permanent" | "untilNextTurn" }
  // Move up to `amount` damage counters from one bound target to another:
  | { do: "moveDamage"; from: string; to: string; amount: number }
  // Move `amount` damage from every other character to a bound target (Morgana):
  | { do: "moveDamageAll"; to: string; amount: number; scope?: Scope }
  // Protect a bound character from being challenged until your next turn (Mother Will Protect You):
  | { do: "protectFromChallenge"; to: string }
  // Zone control on a bound character:
  | { do: "putToInkwell"; to: string; exerted?: boolean } // into its owner's inkwell
  | { do: "toBottom"; to: string }                         // to the bottom of its owner's deck
  // Choose an item in play (suspends), then act on it (banish):
  | { do: "chooseItem"; as: string; scope?: Scope; maxCost?: number; text?: string; optional?: boolean }
  // Return card(s) from your discard to hand (suspends on a discard picker):
  | { do: "returnFromDiscard"; cardType?: CardType; maxCost?: number; minWillpower?: number; cardName?: string; subtype?: string; keepUpTo?: number; to?: "hand" | "bottom" | "inkwellExerted" | "top"; optional?: boolean; text?: string }
  // Shuffle all character cards from discard(s) back into deck(s) (DunBroch Tapestry):
  | { do: "shuffleDiscardIntoDeck"; player?: Who | "each"; cardType?: CardType }
  // Draw cards equal to a bound character's stat (Scar — strength; Touch the Sky — location lore):
  | { do: "drawByStat"; from: string; stat: "strength" | "willpower" | "lore" }
  // Move a bound character to a bound location (Touch the Sky):
  | { do: "moveBoundToLocation"; char: string; location: string }
  // Protect every one of your characters from being challenged until your next turn (Pocahontas - Peacekeeper):
  | { do: "protectAllFromChallenge"; scope?: Scope }
  // The player whose turn is ending discards down to `size` cards (Goliath):
  | { do: "discardToHandSize"; size: number }
  // Discard your whole hand, then draw `draw` cards (Doc / A Whole New World):
  | { do: "discardHandDraw"; player?: Who; draw: number }
  // A player discards `amount` random cards (default the opponent):
  | { do: "randomDiscard"; amount: number; player?: Who }
  // Opponents can't play actions (or items) until your next turn:
  | { do: "lockout"; items?: boolean }
  // Cards / lore ("each" draws for both players — Amethyst Chromicon / Donald):
  | { do: "draw"; player?: Who | "each"; amount?: number; amountPer?: AmountPer }
  | { do: "drawTo"; player?: Who; count: number }
  // Choose and discard from your own hand `amount` (or per-count) cards:
  | { do: "discardChoose"; amount?: number; amountPer?: AmountPer; text?: string }
  // Put the top card of your deck into your inkwell (Webby - Junior Prospector):
  | { do: "putTopToInkwell"; exerted?: boolean }
  // Mill the top `amount` cards of your deck into your discard (Preston, Lyle):
  | { do: "mill"; amount: number; player?: Who }
  // Put the top card of your deck facedown under a bound character (Mickey - Bob Cratchit):
  | { do: "putTopUnder"; to: string }
  // Put the source card itself facedown under a bound character/location (Roo - Little Helper):
  | { do: "putSelfUnder"; to: string }
  // Opponent loses lore equal to a bound character's damage, capped (Nani's Payback):
  | { do: "loseLoreByDamage"; from: string; max?: number }
  // Put all cards under a bound character into your hand (Alice - Well-Read Whisper):
  | { do: "cardsUnderToHand"; from: string }
  // Move all cards under a bound character/item/location to a zone (Come Out and Fight):
  | { do: "cardsUnderTo"; from: string; to: "hand" | "inkwellExerted" | "bottom" }
  // Harvest all cards from under all your characters/locations into a zone (Visiting Christmas Past):
  | { do: "harvestUnder"; to: "hand" | "inkwellExerted" | "bottom" }
  // Each opponent discards a card per card that was under the source (Goofy - Jacob Marley):
  | { do: "opponentDiscardPerUnder" }
  // Remove up to `amount` damage from every character in scope (Piglet - Cocoa Maker):
  | { do: "removeDamageAll"; scope?: Scope; amount: number }
  // Put up to `amount` cards from a player's discard on the bottom of their deck (Taran, Anna):
  | { do: "discardToBottom"; player?: Who; amount: number }
  // Put the top card under each of the controller's other characters (Scrooge - Reformed):
  | { do: "putTopUnderEachOther" }
  // Banish all locations in play (Freeze the Vine):
  | { do: "banishLocations" }
  // Look at the top `count`, put each on the top or bottom of your deck (Dr. Sara Bellum):
  | { do: "scryTopOrBottom"; count: number; text?: string }
  // Search your deck for a matching card, put it into your hand, then shuffle (Don't Be Nervous):
  | { do: "searchDeck"; cardType?: CardType; subtype?: string; text?: string }
  // Look at the top `count`, put the chosen one into your inkwell (exerted), rest
  // stay on top in order (Kida - Creative Thinker):
  | { do: "scryToInkwell"; count: number; text?: string }
  // Draw until your hand matches the opponent's size (Clarabelle - Light on Her Hooves):
  | { do: "drawToMatchOpponentHand" }
  // Play the source card from your discard into play (Lilo - Escape Artist):
  | { do: "playFromDiscard"; exerted?: boolean }
  // Play ANOTHER card (from hand or discard) into play for free (Lady - Family Dog,
  // Woody - Jungle Guide, Tamatoa). The freely-played card's own on_play does not
  // chain (board state only).
  | { do: "playFree"; from?: "hand" | "discard"; cardType?: CardType; maxCost?: number; subtype?: string; as?: string; optional?: boolean; text?: string }
  // Mark a bound character to be banished at the end of this turn (Mystical Inkcaster temp-summon):
  | { do: "markBanishEndOfTurn"; to: string }
  // Return the source card from your discard to your hand (Will o' the Wisp / Snow White):
  | { do: "returnSelfToHand" }
  | { do: "discard"; player?: Who; amount?: number }
  // A player reveals their hand (informational — a no-op in the hot-seat sim):
  | { do: "revealHand"; player?: Who }
  // Run `steps` for each target player, with that player as the controller — each
  // resolves their own copy (Escape Plan, Kida-Crystal flood-of-power).
  | { do: "eachPlayer"; who?: "each" | "opponents"; steps: Step[] }
  | { do: "gainLore" | "loseLore"; player?: Who; amount?: number };

export interface EffectDef {
  trigger: Trigger;
  steps?: Step[];
  /** Optional gate: the effect only fires when this condition holds. */
  when?: Condition;
  /** For trigger "cost": flat ink reduction when playing this card. */
  reduce?: number;
  /** For trigger "cost": reduction that scales with a count. */
  reducePer?: "actionInDiscard" | "characterInPlay";
  /** For trigger "cost": reduction that scales with characters of this subtype in your discard (Bouncing Ducky — Toy). */
  reduceSubtypeInDiscard?: string;
  /** For trigger "cost": reduction that scales with cards of this type in your discard (Stegmutt — item). */
  reduceTypeInDiscard?: CardType;
  /** For trigger "cost": reduction that scales with exerted characters in play (Eeyore). */
  reducePerExerted?: boolean;
  /** For trigger "cost": reduction that scales with cards in your inkwell (Gramma Tala). */
  reducePerInkwell?: boolean;
  /** For trigger "cost": play this card for free when `when` holds (Lilo - Causing an Uproar). */
  free?: boolean;
  /** Triggered abilities that may only resolve once per turn (Ariel - Ethereal Voice). */
  oncePerTurn?: boolean;
}

export type CardEffects = Record<string, EffectDef[]>;

export type AbilityKind = Trigger | "activated" | "static";

/**
 * Classify when an ability's printed text fires, so we only auto-resolve or
 * surface a Manual-Mode prompt on the matching event (not for every ability on
 * play). Activated abilities need an explicit activation; statics never prompt.
 */
export function classifyTrigger(effectText: string, cardType: CardType): AbilityKind {
  const t = effectText.trim().toLowerCase();
  if (/^when you play this/.test(t)) return "on_play";
  if (/^whenever this character quests/.test(t)) return "on_quest";
  if (/^whenever this character challenges/.test(t)) return "on_challenge";
  if (/^when this character is banished/.test(t)) return "on_banish";
  // Activated: a cost (exert/ink/"banish this") preceding an em dash.
  if (/^(\{e\}|\d+\s*\{[il]\}|banish this)[^—]*—/.test(t) || /^\{e\}/.test(t)) return "activated";
  // Free "Once during your turn, …" abilities are player-activated (once/turn).
  if (/^once (during|per) your turn/.test(t)) return "activated";
  // For actions/songs the whole text is the on-play effect.
  if (cardType === "song" || cardType === "action") return "on_play";
  return "static";
}

export interface EffectContext {
  controller: PlayerId;
  source: CardInstance;
  vars: Record<string, string>; // bound var name -> instanceId
  /** Cards banished while these steps ran, so on_banish triggers can fire after. */
  banished?: { card: CardInstance; owner: PlayerId }[];
  /** Hooks the reducer wires up so draws/discards inside an effect fire further
   * triggers (on_draw / opponent-discard watches). */
  events?: EffectEvents;
}

/** Reducer-supplied callbacks for events that happen mid-effect. */
export interface EffectEvents {
  onDraw?(player: PlayerId): void;
  onDiscard?(player: PlayerId): void;
  onRemoveDamage?(player: PlayerId, amount: number): void;
}

/** A suspended sequence awaiting a target choice. Serialisable (frame-safe). */
export interface Suspension {
  steps: Step[]; // remaining, starting with the choose step
  scope: Scope;
  text?: string;
  optional: boolean;
  filter?: TargetFilter;
  /** What the resolver picks. */
  pick: "character" | "hand" | "confirm" | "deck" | "item" | "discard" | "mode";
  /** For pick === "deck"/"discard": the revealed card instanceIds to show face-up. */
  reveal?: string[];
  /** For pick === "hand": whose hand to choose from. */
  handOwner?: PlayerId;
  /** For pick === "mode": the option labels to choose between. */
  modes?: string[];
}

/** Does a hand card satisfy a chooseFromHand step's type filter? */
export function handCardMatches(card: CardInstance, step: Extract<Step, { do: "chooseFromHand" }>): boolean {
  if (step.cardType && card.printed.type !== step.cardType) return false;
  if (step.excludeCardType && card.printed.type === step.excludeCardType) return false;
  return true;
}

/**
 * Does a chosen character satisfy a choose step's scope + filter? Used by the
 * reducer to reject illegal targets when resuming a suspended effect.
 */
export function targetMatches(
  card: CardInstance,
  owner: PlayerId,
  controller: PlayerId,
  step: Extract<Step, { do: "chooseCharacter" }>,
  strength: number,
): boolean {
  if (card.printed.type !== "character" && !(step.includeLocations && card.printed.type === "location")) return false;
  const scope = step.scope ?? "any";
  if (scope === "ally" && owner !== controller) return false;
  if (scope === "enemy" && owner === controller) return false;
  const f = step.filter;
  if (f) {
    if (f.maxStrength != null && strength > f.maxStrength) return false;
    if (f.minStrength != null && strength < f.minStrength) return false;
    if (f.maxCost != null && card.printed.cost > f.maxCost) return false;
    if (f.subtype && !card.printed.subtypes.some((s) => s.toLowerCase() === f.subtype!.toLowerCase())) return false;
    if (f.exerted && !card.exerted) return false;
    if (f.damaged && card.damage <= 0) return false;
    if (f.hasBoost && !card.printed.abilities.some((a) => a.ability.toLowerCase().startsWith("boost"))) return false;
    if (f.onlyLocations && card.printed.type !== "location") return false;
    if (f.hasKeyword) {
      const want = f.hasKeyword.toLowerCase();
      if (!(card.printed.abilities.some((a) => a.ability.toLowerCase().startsWith(want)) || card.appliedEffects.some((e) => e.keyword?.toLowerCase() === want))) return false;
    }
  }
  return true;
}

const player = (ctx: EffectContext, who: Who | undefined): PlayerId =>
  who === "opponent" ? otherPlayer(ctx.controller) : ctx.controller;

function resolveTarget(state: GameState, ctx: EffectContext, ref: string): CardInstance | undefined {
  if (ref === "self") return ctx.source;
  const id = ctx.vars[ref];
  return id ? findInstance(state, id)?.card : undefined;
}

/** Characters in play within a scope, relative to the controller. */
function charsInScope(state: GameState, controller: PlayerId, scope: Scope): CardInstance[] {
  const out: CardInstance[] = [];
  for (const owner of [1, 2] as PlayerId[]) {
    if (scope === "ally" && owner !== controller) continue;
    if (scope === "enemy" && owner === controller) continue;
    for (const c of state.players[owner].field) if (c.printed.type === "character") out.push(c);
  }
  return out;
}

/** Resolve a numeric magnitude that may scale with a character count. */
function dynAmount(state: GameState, ctx: EffectContext, base: number | undefined, per?: AmountPer): number {
  if (!per) return base ?? 0;
  let n = charsInScope(state, ctx.controller, per.scope).length;
  if (per.excludeSelf) n = Math.max(0, n - 1);
  return n;
}

/** Move a set of "under" cards to a destination zone for `controller`. */
function moveUnderCards(state: GameState, controller: PlayerId, cards: CardInstance[], to: "hand" | "inkwellExerted" | "bottom"): void {
  const p = state.players[controller];
  for (const c of cards) {
    c.damage = 0; c.justPlayed = to === "inkwellExerted"; c.exerted = to === "inkwellExerted"; c.appliedEffects = [];
    if (to === "hand") p.hand.push(c);
    else if (to === "inkwellExerted") p.inkwell.push(c);
    else p.deck.push(c);
  }
}

/** Apply damage to a character, banishing it (and recording so) if it dies. */
function hit(state: GameState, ctx: EffectContext, t: CardInstance, amount: number, logs: LogEntry[]): void {
  if (amount > 0 && damagePrevented(state, t, "effect")) return; // Hercules, Lilo - Bundled Up
  t.damage += amount;
  const loc = findInstance(state, t.instanceId);
  // Merida - Formidable Archer "Steady Aim": when one of your actions damages an
  // opposing character, deal 2 more to it. (The follow-up isn't itself an action,
  // so it can't re-trigger.)
  if (
    amount > 0 && loc && loc.owner !== ctx.controller &&
    (ctx.source.printed.type === "action" || ctx.source.printed.type === "song") &&
    state.players[ctx.controller].field.some((c) => c.printed.specialAbilities.some((a) => a.slug === "steadyaim"))
  ) {
    t.damage += 2;
  }
  if (loc && t.damage >= effectiveWillpower(state, t)) {
    banishCard(state.players[loc.owner], t, logs, state.turnNumber);
    ctx.banished?.push({ card: t, owner: loc.owner });
  }
}

function applyStep(state: GameState, step: Step, ctx: EffectContext, logs: LogEntry[]): void {
  switch (step.do) {
    case "dealDamage": {
      const t = resolveTarget(state, ctx, step.to);
      if (!t) return;
      hit(state, ctx, t, dynAmount(state, ctx, step.amount, step.amountPer), logs);
      break;
    }
    case "dealDamageAll": {
      const amount = step.amount;
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) {
        if (step.excludeSelf && t.instanceId === ctx.source.instanceId) continue;
        hit(state, ctx, t, amount, logs);
      }
      break;
    }
    case "buffByOwnStat": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) {
        const amt = step.stat === "willpower" ? effectiveWillpower(state, t) : effectiveStrength(state, t);
        if (amt !== 0) t.appliedEffects.push({ source: ctx.source.instanceId, strength: amt, duration: "end_of_turn", castBy: ctx.controller });
      }
      break;
    }
    case "removeDamage": {
      const t = resolveTarget(state, ctx, step.to);
      if (t && t.damage > 0) {
        const removed = Math.min(step.amount, t.damage);
        t.damage -= removed;
        state.players[ctx.controller].removedDamageThisTurn = true;
        ctx.events?.onRemoveDamage?.(ctx.controller, removed);
      }
      break;
    }
    case "removeDamageDraw": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) {
        const removed = Math.min(step.amount, t.damage);
        t.damage -= removed;
        if (removed > 0) { drawCards(state.players[ctx.controller], removed); state.players[ctx.controller].removedDamageThisTurn = true; ctx.events?.onRemoveDamage?.(ctx.controller, removed); }
      }
      break;
    }
    case "gainLoreByStrength": {
      const amt = Math.min(effectiveStrength(state, ctx.source), step.max ?? Infinity);
      if (amt > 0) state.players[ctx.controller].lore += amt;
      break;
    }
    case "gainLoreEqual": {
      const t = resolveTarget(state, ctx, step.from);
      if (!t) return;
      const amt = step.stat === "damage" ? t.damage : step.stat === "strength" ? effectiveStrength(state, t) : effectiveLore(state, t);
      if (amt > 0) {
        state.players[ctx.controller].lore += amt;
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "LORE_GAINED", message: `Gain ${amt} lore`, data: { lore: state.players[ctx.controller].lore } }));
      }
      break;
    }
    case "banish": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        banishCard(state.players[loc.owner], t, logs, state.turnNumber);
        ctx.banished?.push({ card: t, owner: loc.owner });
      }
      break;
    }
    case "returnToHand": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = false; t.justPlayed = false; t.appliedEffects = [];
        state.players[loc.owner].hand.push(t);
      }
      break;
    }
    case "buff":
    case "debuff": {
      const t = resolveTarget(state, ctx, step.to);
      if (!t) return;
      const s = step.do === "debuff" ? -1 : 1;
      const mag = step.amountPer ? dynAmount(state, ctx, undefined, step.amountPer) : null;
      t.appliedEffects.push({
        source: ctx.source.instanceId,
        strength: mag != null ? s * mag : step.strength != null ? s * step.strength : undefined,
        willpower: step.willpower != null ? s * step.willpower : undefined,
        lore: step.lore != null ? s * step.lore : undefined,
        duration: step.duration ?? "end_of_turn",
        castBy: ctx.controller,
      });
      break;
    }
    case "buffAll":
    case "debuffAll": {
      const s = step.do === "debuffAll" ? -1 : 1;
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) {
        if (step.excludeSelf && t.instanceId === ctx.source.instanceId) continue;
        if (step.subtype && !t.printed.subtypes.some((st) => st.toLowerCase() === step.subtype!.toLowerCase())) continue;
        if (step.keywordFilter && !(t.printed.abilities.some((a) => a.ability.toLowerCase().startsWith(step.keywordFilter!.toLowerCase())) || t.appliedEffects.some((e) => e.keyword?.toLowerCase() === step.keywordFilter!.toLowerCase()))) continue;
        t.appliedEffects.push({
          source: ctx.source.instanceId,
          strength: step.strength != null ? s * step.strength : undefined,
          willpower: step.willpower != null ? s * step.willpower : undefined,
          lore: step.lore != null ? s * step.lore : undefined,
          keyword: step.keyword,
          keywordValue: step.keywordValue,
          duration: step.duration ?? "end_of_turn",
          castBy: ctx.controller,
        });
      }
      break;
    }
    case "buffBySourceStat": {
      const t = resolveTarget(state, ctx, step.to);
      if (!t) return;
      const amt = step.stat === "willpower" ? effectiveWillpower(state, ctx.source) : effectiveStrength(state, ctx.source);
      if (amt !== 0) t.appliedEffects.push({ source: ctx.source.instanceId, strength: amt, duration: "end_of_turn", castBy: ctx.controller });
      break;
    }
    case "ready": { const t = resolveTarget(state, ctx, step.to); if (t) t.exerted = false; break; }
    case "lockQuest": { const t = resolveTarget(state, ctx, step.to); if (t) t.questLockedThisTurn = true; break; }
    case "grantChallengeReady": { const t = resolveTarget(state, ctx, step.to); if (t) t.challengeReadyThisTurn = true; break; }
    case "applyStatus": { const t = resolveTarget(state, ctx, step.to); if (t) t[step.status] = true; break; }
    case "exert": { const t = resolveTarget(state, ctx, step.to); if (t) t.exerted = true; break; }
    case "exertAll": {
      for (const c of charsInScope(state, ctx.controller, step.scope ?? "any")) c.exerted = true;
      break;
    }
    case "grantKeyword": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) t.appliedEffects.push({ source: ctx.source.instanceId, keyword: step.keyword, keywordValue: step.value, duration: step.duration ?? "end_of_turn", castBy: ctx.controller });
      break;
    }
    case "moveDamage": {
      const from = resolveTarget(state, ctx, step.from);
      const to = resolveTarget(state, ctx, step.to);
      if (from && to) {
        const moved = Math.min(step.amount, from.damage);
        from.damage -= moved;
        to.damage += moved;
        // Moving damage off one of your characters counts as removing damage.
        if (moved > 0) { const fl = findInstance(state, from.instanceId); if (fl && fl.owner === ctx.controller) { state.players[ctx.controller].removedDamageThisTurn = true; ctx.events?.onRemoveDamage?.(ctx.controller, moved); } }
        const loc = findInstance(state, to.instanceId);
        if (loc && to.damage >= effectiveWillpower(state, to)) {
          banishCard(state.players[loc.owner], to, logs, state.turnNumber);
          ctx.banished?.push({ card: to, owner: loc.owner });
        }
      }
      break;
    }
    case "moveDamageAll": {
      const to = resolveTarget(state, ctx, step.to);
      if (to) {
        for (const c of charsInScope(state, ctx.controller, step.scope ?? "any")) {
          if (c.instanceId === to.instanceId) continue;
          const moved = Math.min(step.amount, c.damage);
          c.damage -= moved; to.damage += moved;
        }
        const loc = findInstance(state, to.instanceId);
        if (loc && to.damage >= effectiveWillpower(state, to)) { banishCard(state.players[loc.owner], to, logs, state.turnNumber); ctx.banished?.push({ card: to, owner: loc.owner }); }
      }
      break;
    }
    case "protectFromChallenge": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) t.cantBeChallengedUntil = ctx.controller;
      break;
    }
    case "markBanishEndOfTurn": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) t.banishAtEndOfTurn = true;
      break;
    }
    case "putToInkwell": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.justPlayed = true; t.exerted = step.exerted ?? false; t.appliedEffects = [];
        state.players[loc.owner].inkwell.push(t);
      }
      break;
    }
    case "toBottom": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = false; t.justPlayed = false; t.appliedEffects = [];
        state.players[loc.owner].deck.push(t);
      }
      break;
    }
    case "discardHandDraw": {
      const pid = player(ctx, step.player);
      const p = state.players[pid];
      const n = p.hand.length;
      p.discard.push(...p.hand.splice(0, n));
      p.discardedThisTurn = (p.discardedThisTurn ?? 0) + n;
      for (let k = 0; k < n; k++) ctx.events?.onDiscard?.(pid);
      drawCards(p, step.draw);
      for (let k = 0; k < step.draw; k++) ctx.events?.onDraw?.(pid);
      break;
    }
    case "randomDiscard": {
      // Defaults to the opponent; pass player:"self" for own-hand random discard.
      const pid = step.player === "self" ? ctx.controller : otherPlayer(ctx.controller);
      const opp = state.players[pid];
      const rng = new Rng(state.rngSeed, state.rngCursor);
      for (let k = 0; k < step.amount && opp.hand.length > 0; k++) {
        const i = rng.int(opp.hand.length);
        opp.discard.push(opp.hand.splice(i, 1)[0]!);
        opp.discardedThisTurn = (opp.discardedThisTurn ?? 0) + 1;
        ctx.events?.onDiscard?.(pid);
      }
      state.rngCursor = rng.cursor;
      break;
    }
    case "lockout": {
      state.lockout = { caster: ctx.controller, items: step.items ?? false };
      break;
    }
    case "grantExtraInk": {
      state.players[ctx.controller].extraInk = (state.players[ctx.controller].extraInk ?? 0) + (step.amount ?? 1);
      break;
    }
    case "toBottomAll": {
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) {
        if (step.maxStrength != null && effectiveStrength(state, t) > step.maxStrength) continue;
        const loc = findInstance(state, t.instanceId);
        if (!loc) continue;
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = false; t.justPlayed = false; t.appliedEffects = [];
        state.players[loc.owner].deck.push(t);
      }
      break;
    }
    case "putToInkwellAll": {
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) {
        if (step.maxCost != null && t.printed.cost > step.maxCost) continue;
        const loc = findInstance(state, t.instanceId);
        if (!loc) continue;
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = true; t.justPlayed = true; t.appliedEffects = [];
        state.players[loc.owner].inkwell.push(t);
      }
      break;
    }
    case "toInkwell": {
      const t = resolveTarget(state, ctx, step.from);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc && loc.zone === "hand") {
        const arr = state.players[loc.owner].hand;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.exerted = step.exerted ?? false;
        t.justPlayed = true; // face-up until end of the turn it was added
        state.players[loc.owner].inkwell.push(t);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: loc.owner, type: "CARD_PUT_INTO_INKWELL", message: `Put ${t.printed.fullName} into inkwell`, cardRefs: [{ id: t.printed.id, name: t.printed.fullName }] }));
      }
      break;
    }
    case "discardCard": {
      const t = resolveTarget(state, ctx, step.from);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc && loc.zone === "hand") {
        const arr = state.players[loc.owner].hand;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        state.players[loc.owner].discard.push(t);
        state.players[loc.owner].discardedThisTurn = (state.players[loc.owner].discardedThisTurn ?? 0) + 1;
        ctx.events?.onDiscard?.(loc.owner);
      }
      break;
    }
    case "opponentDiscard": {
      // Push a prompt for the opponent to choose their own cards to discard.
      const opp = otherPlayer(ctx.controller);
      const n = Math.min(step.amount, state.players[opp].hand.length);
      if (n <= 0) break;
      const sub: Step[] = [];
      for (let k = 0; k < n; k++) sub.push({ do: "chooseFromHand", as: `d${k}`, from: "self", optional: true, cardType: step.cardType, excludeCardType: step.excludeCardType }, { do: "discardCard", from: `d${k}` });
      state.pendingPrompts.push({
        id: uid(),
        player: opp,
        controller: opp,
        sourceInstanceId: ctx.source.instanceId,
        kind: "discard",
        text: `Choose ${n} card${n > 1 ? "s" : ""} to discard`,
        auto: false,
        pick: "hand",
        handOwner: opp,
        resume: { steps: sub, vars: {} },
      });
      break;
    }
    case "opponentTopByType": {
      const opp = state.players[otherPlayer(ctx.controller)];
      const top = opp.deck.shift();
      if (top) {
        if (top.printed.type === step.cardType) opp.hand.push(top);
        else opp.deck.push(top); // to the bottom
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_DRAWN", message: `Opponent revealed ${top.printed.fullName}`, cardRefs: [{ id: top.printed.id, name: top.printed.fullName }] }));
      }
      break;
    }
    case "opponentBanishChoose": {
      const opp = otherPlayer(ctx.controller);
      if (state.players[opp].field.filter((c) => c.printed.type === "character").length === 0) break;
      state.pendingPrompts.push({
        id: uid(),
        player: opp,
        controller: opp,
        sourceInstanceId: ctx.source.instanceId,
        kind: "banish",
        text: "Choose a character to banish",
        auto: false,
        pick: "character",
        scope: "ally",
        resume: { steps: [{ do: "chooseCharacter", as: "b", scope: "ally", text: "banish one of your characters" }, { do: "banish", to: "b" }], vars: {} },
      });
      break;
    }
    case "grantDiscount": {
      (state.players[ctx.controller].discounts ??= []).push({
        amount: step.amount,
        cardType: step.cardType,
        subtypes: step.subtypes,
        uses: step.uses ?? 1,
      });
      logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "ABILITY_TRIGGERED", message: `Pay ${step.amount} less for the next ${step.cardType ?? "card"}` }));
      break;
    }
    case "banishAll": {
      const scope = step.scope ?? "any";
      for (const owner of [1, 2] as PlayerId[]) {
        if (scope === "ally" && owner !== ctx.controller) continue;
        if (scope === "enemy" && owner === ctx.controller) continue;
        const chars = state.players[owner].field.filter((c) => {
          if (c.printed.type !== "character") return false;
          if (step.damaged && c.damage <= 0) return false;
          if (step.maxStrength != null && effectiveStrength(state, c) > step.maxStrength) return false;
          return true;
        });
        for (const c of chars) {
          banishCard(state.players[owner], c, logs, state.turnNumber);
          ctx.banished?.push({ card: c, owner });
        }
      }
      break;
    }
    case "draw": {
      const n = step.amountPer ? dynAmount(state, ctx, step.amount, step.amountPer) : (step.amount ?? 1);
      if (n <= 0) break;
      const targets: PlayerId[] = step.player === "each" ? [ctx.controller, otherPlayer(ctx.controller)] : [player(ctx, step.player)];
      for (const pid of targets) {
        drawCards(state.players[pid], n);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: pid, type: "CARD_DRAWN", message: `Draw ${n}` }));
        for (let k = 0; k < n; k++) ctx.events?.onDraw?.(pid);
      }
      break;
    }
    case "putTopToInkwell": {
      const p = state.players[ctx.controller];
      const card = p.deck.shift();
      if (card) {
        card.exerted = step.exerted ?? true; card.justPlayed = true; card.appliedEffects = []; card.damage = 0;
        p.inkwell.push(card);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_PUT_INTO_INKWELL", message: `Put the top card into inkwell`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
      }
      break;
    }
    case "drawByStat": {
      const t = resolveTarget(state, ctx, step.from);
      if (t) {
        const n = step.stat === "willpower" ? effectiveWillpower(state, t) : step.stat === "lore" ? effectiveLore(state, t) : effectiveStrength(state, t);
        if (n > 0) { drawCards(state.players[ctx.controller], n); for (let k = 0; k < n; k++) ctx.events?.onDraw?.(ctx.controller); }
      }
      break;
    }
    case "moveBoundToLocation": {
      const ch = resolveTarget(state, ctx, step.char);
      const loc = resolveTarget(state, ctx, step.location);
      if (ch && loc && loc.printed.type === "location") ch.atLocation = loc.instanceId;
      break;
    }
    case "protectAllFromChallenge": {
      for (const c of charsInScope(state, ctx.controller, step.scope ?? "ally")) c.cantBeChallengedUntil = ctx.controller;
      break;
    }
    case "discardToHandSize": {
      // The ending player (state.currentPlayer at end of turn) discards down to size.
      const tp = state.currentPlayer;
      const excess = state.players[tp].hand.length - step.size;
      if (excess > 0) {
        state.pendingPrompts.push({
          id: uid(), player: tp, controller: tp, sourceInstanceId: ctx.source.instanceId,
          kind: "discard", text: `Discard down to ${step.size}`, auto: false, pick: "hand", handOwner: tp,
          resume: { steps: [{ do: "discardChoose", amount: excess }], vars: {} },
        });
      }
      break;
    }
    case "shuffleDiscardIntoDeck": {
      const targets: PlayerId[] = step.player === "each" ? [1, 2] : [player(ctx, step.player)];
      const rng = new Rng(state.rngSeed, state.rngCursor);
      for (const pid of targets) {
        const pl = state.players[pid];
        const move = pl.discard.filter((c) => !step.cardType || c.printed.type === step.cardType);
        pl.discard = pl.discard.filter((c) => step.cardType && c.printed.type !== step.cardType);
        for (const c of move) { c.damage = 0; c.exerted = false; c.justPlayed = false; c.appliedEffects = []; }
        pl.deck = rng.shuffle([...pl.deck, ...move]);
      }
      state.rngCursor = rng.cursor;
      break;
    }
    case "putTopUnder": {
      const t = resolveTarget(state, ctx, step.to);
      const top = state.players[ctx.controller].deck.shift();
      if (t && top) t.cardsUnder.push(top);
      break;
    }
    case "putSelfUnder": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = findInstance(state, ctx.source.instanceId);
      if (t && loc && t.instanceId !== ctx.source.instanceId) {
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(ctx.source);
        if (i >= 0) arr.splice(i, 1);
        ctx.source.damage = 0; ctx.source.exerted = false; ctx.source.justPlayed = false; ctx.source.appliedEffects = [];
        t.cardsUnder.push(ctx.source);
      }
      break;
    }
    case "loseLoreByDamage": {
      const t = resolveTarget(state, ctx, step.from);
      if (t) {
        const amt = Math.min(t.damage, step.max ?? Infinity);
        if (amt > 0) { const opp = state.players[otherPlayer(ctx.controller)]; opp.lore = Math.max(0, opp.lore - amt); }
      }
      break;
    }
    case "putTopUnderEachOther": {
      const p = state.players[ctx.controller];
      for (const c of p.field) {
        if (c.printed.type !== "character" || c.instanceId === ctx.source.instanceId) continue;
        const top = p.deck.shift();
        if (!top) break;
        c.cardsUnder.push(top);
      }
      break;
    }
    case "discardToBottom": {
      const pid = step.player === "self" ? ctx.controller : otherPlayer(ctx.controller);
      const pl = state.players[pid];
      for (let k = 0; k < step.amount && pl.discard.length > 0; k++) {
        const c = pl.discard.shift()!;
        c.damage = 0; c.exerted = false; c.justPlayed = false; c.appliedEffects = [];
        pl.deck.push(c);
      }
      break;
    }
    case "banishLocations": {
      for (const pid of [1, 2] as PlayerId[]) {
        const locs = state.players[pid].field.filter((c) => c.printed.type === "location");
        for (const loc of locs) { banishCard(state.players[pid], loc, logs, state.turnNumber); ctx.banished?.push({ card: loc, owner: pid }); }
      }
      break;
    }
    case "cardsUnderToHand": {
      const t = resolveTarget(state, ctx, step.from);
      if (t && t.cardsUnder.length > 0) {
        for (const c of t.cardsUnder) { c.damage = 0; c.exerted = false; c.justPlayed = false; c.appliedEffects = []; }
        state.players[ctx.controller].hand.push(...t.cardsUnder);
        t.cardsUnder = [];
      }
      break;
    }
    case "cardsUnderTo": {
      const t = resolveTarget(state, ctx, step.from);
      if (t && t.cardsUnder.length > 0) {
        moveUnderCards(state, ctx.controller, t.cardsUnder, step.to);
        t.cardsUnder = [];
      }
      break;
    }
    case "harvestUnder": {
      const p = state.players[ctx.controller];
      for (const src of [...p.field]) {
        if (src.cardsUnder.length > 0) { moveUnderCards(state, ctx.controller, src.cardsUnder, step.to); src.cardsUnder = []; }
      }
      break;
    }
    case "opponentDiscardPerUnder": {
      const n = ctx.source.banishedUnderCount ?? ctx.source.cardsUnder.length;
      if (n > 0) applyStep(state, { do: "opponentDiscard", amount: n }, ctx, logs);
      break;
    }
    case "removeDamageAll": {
      let removedAny = false;
      for (const c of charsInScope(state, ctx.controller, step.scope ?? "ally")) {
        if (c.damage > 0) { c.damage = Math.max(0, c.damage - step.amount); removedAny = true; }
      }
      if (removedAny) { state.players[ctx.controller].removedDamageThisTurn = true; ctx.events?.onRemoveDamage?.(ctx.controller, step.amount); }
      break;
    }
    case "mill": {
      const p = state.players[player(ctx, step.player)];
      for (let k = 0; k < step.amount; k++) {
        const c = p.deck.shift();
        if (!c) break;
        p.discard.push(c);
        p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1;
        ctx.events?.onDiscard?.(player(ctx, step.player));
      }
      break;
    }
    case "drawToMatchOpponentHand": {
      const p = state.players[ctx.controller];
      const need = state.players[otherPlayer(ctx.controller)].hand.length - p.hand.length;
      if (need > 0) drawCards(p, need);
      break;
    }
    case "playFromDiscard": {
      const src = ctx.source;
      const p = state.players[ctx.controller];
      const i = p.discard.indexOf(src);
      if (i >= 0) {
        p.discard.splice(i, 1);
        src.damage = 0; src.exerted = step.exerted ?? false; src.justPlayed = true; src.appliedEffects = [];
        p.field.push(src);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_PLAYED", message: `Played ${src.printed.fullName} from discard`, cardRefs: [{ id: src.printed.id, name: src.printed.fullName }] }));
      }
      break;
    }
    case "returnSelfToHand": {
      const src = ctx.source;
      const p = state.players[ctx.controller];
      const i = p.discard.indexOf(src);
      if (i >= 0) {
        p.discard.splice(i, 1);
        src.damage = 0; src.exerted = false; src.justPlayed = false; src.appliedEffects = [];
        p.hand.push(src);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_PUT_INTO_INKWELL", message: `Returned ${src.printed.fullName} to hand`, cardRefs: [{ id: src.printed.id, name: src.printed.fullName }] }));
      }
      break;
    }
    case "drawTo": {
      const p = state.players[player(ctx, step.player)];
      if (p.hand.length < step.count) drawCards(p, step.count - p.hand.length);
      break;
    }
    case "discard": {
      const pid = player(ctx, step.player);
      const p = state.players[pid];
      for (let i = 0; i < (step.amount ?? 1); i++) { const c = p.hand.pop(); if (c) { p.discard.push(c); p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1; ctx.events?.onDiscard?.(pid); } }
      break;
    }
    case "revealHand": {
      const pid = player(ctx, step.player);
      logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "ABILITY_TRIGGERED", message: `${state.players[pid].name} reveals their hand` }));
      break;
    }
    case "eachPlayer": {
      const targets: PlayerId[] = step.who === "opponents" ? [otherPlayer(ctx.controller)] : [ctx.controller, otherPlayer(ctx.controller)];
      for (const pid of targets) {
        const subCtx: EffectContext = { controller: pid, source: ctx.source, vars: {}, banished: ctx.banished, events: ctx.events };
        const susp = runSteps(state, step.steps, subCtx, logs);
        if (susp) {
          state.pendingPrompts.push({
            id: uid(), player: pid, controller: pid, sourceInstanceId: ctx.source.instanceId,
            kind: "eachplayer", text: susp.text ?? "Resolve", auto: false,
            scope: susp.scope, pick: susp.pick, reveal: susp.reveal, handOwner: susp.handOwner, modes: susp.modes,
            resume: { steps: susp.steps, vars: subCtx.vars },
          });
        }
      }
      break;
    }
    case "gainLore": {
      const p = state.players[player(ctx, step.player)];
      p.lore += step.amount ?? 1;
      logs.push(makeLog({ turnNumber: state.turnNumber, player: player(ctx, step.player), type: "LORE_GAINED", message: `Gain ${step.amount ?? 1} lore`, data: { lore: p.lore } }));
      break;
    }
    case "loseLore": {
      const p = state.players[player(ctx, step.player)];
      p.lore = Math.max(0, p.lore - (step.amount ?? 1));
      break;
    }
  }
}

/**
 * Run steps in order. If a `chooseCharacter` step is reached with no target to
 * bind, return a Suspension (the caller pushes a prompt). `injected` binds the
 * leading choose step when resuming.
 */
export function runSteps(
  state: GameState,
  steps: Step[],
  ctx: EffectContext,
  logs: LogEntry[],
  injected?: string,
): Suspension | null {
  let pending = injected;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.do === "chooseCharacter") {
      if (pending != null) {
        ctx.vars[step.as] = pending;
        pending = undefined;
        continue;
      }
      return { steps: steps.slice(i), scope: step.scope ?? "any", text: step.text, optional: step.optional ?? false, filter: step.filter, pick: "character" };
    }
    if (step.do === "chooseFromHand") {
      if (pending != null) {
        ctx.vars[step.as] = pending;
        pending = undefined;
        continue;
      }
      const handOwner = step.from === "opponent" ? otherPlayer(ctx.controller) : ctx.controller;
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? false, pick: "hand", handOwner };
    }
    if (step.do === "modal") {
      if (pending != null) {
        const branch = step.options[parseInt(pending, 10)]?.steps ?? [];
        pending = undefined;
        const susp = runSteps(state, branch, ctx, logs);
        if (susp) return susp; // the chosen branch needs its own choice
        continue;
      }
      return { steps: steps.slice(i), scope: "any", optional: false, pick: "mode", modes: step.options.map((o) => o.label) };
    }
    if (step.do === "branchOnMill") {
      const p = state.players[ctx.controller];
      const top = p.deck.shift();
      if (!top) continue;
      p.discard.push(top);
      p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1;
      ctx.events?.onDiscard?.(ctx.controller);
      logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_DRAWN", message: `Put ${top.printed.fullName} into discard`, cardRefs: [{ id: top.printed.id, name: top.printed.fullName }] }));
      const branch = top.printed.type === "character" ? step.onCharacter
        : top.printed.type === "action" || top.printed.type === "item" || top.printed.type === "song" ? step.onActionItem
        : top.printed.type === "location" ? step.onLocation
        : undefined;
      const susp = runSteps(state, branch ?? [], ctx, logs);
      if (susp) return susp; // the chosen branch needs its own choice
      continue;
    }
    if (step.do === "chooseItem") {
      if (pending != null) { ctx.vars[step.as] = pending; pending = undefined; continue; }
      return { steps: steps.slice(i), scope: step.scope ?? "any", text: step.text, optional: step.optional ?? false, pick: "item" };
    }
    if (step.do === "discardChoose") {
      const p = state.players[ctx.controller];
      const ns = "__dcRemain";
      if (pending != null) {
        let remain = parseInt(ctx.vars[ns] ?? "0", 10);
        const idx = p.hand.findIndex((c) => c.instanceId === pending);
        if (idx >= 0) {
          const card = p.hand.splice(idx, 1)[0]!;
          p.discard.push(card);
          p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1;
          ctx.events?.onDiscard?.(ctx.controller);
          remain -= 1;
          ctx.vars[ns] = String(remain);
        }
        if (remain > 0 && p.hand.length > 0) {
          pending = undefined;
          return { steps: steps.slice(i), scope: "any", text: `discard ${remain} more`, optional: false, pick: "hand", handOwner: ctx.controller };
        }
        delete ctx.vars[ns];
        continue;
      }
      const need = Math.min(step.amount ?? dynAmount(state, ctx, 0, step.amountPer), p.hand.length);
      if (need <= 0) continue;
      ctx.vars[ns] = String(need);
      return { steps: steps.slice(i), scope: "any", text: step.text ?? `discard ${need}`, optional: false, pick: "hand", handOwner: ctx.controller };
    }
    if (step.do === "mayConfirm") {
      // A confirmed "Yes" injects a sentinel; consume it and run on. A fresh
      // arrival suspends for the Yes/No choice.
      if (pending != null) { pending = undefined; continue; }
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "confirm" };
    }
    if (step.do === "returnFromDiscard") {
      const p = state.players[ctx.controller];
      const matches = (c: CardInstance) => (!step.cardType || c.printed.type === step.cardType) && (step.maxCost == null || c.printed.cost <= step.maxCost) && (step.minWillpower == null || (c.printed.willpower ?? 0) >= step.minWillpower) && (!step.cardName || c.printed.name.toLowerCase() === step.cardName.toLowerCase() || c.printed.fullName.toLowerCase() === step.cardName.toLowerCase()) && (!step.subtype || c.printed.subtypes.some((s) => s.toLowerCase() === step.subtype!.toLowerCase()));
      const keepUpTo = step.keepUpTo ?? 1;
      const nsK = "__rfdKept";
      if (pending != null) {
        let kept = parseInt(ctx.vars[nsK] ?? "0", 10);
        if (pending !== "__rfdstop__") {
          const idx = p.discard.findIndex((c) => c.instanceId === pending && matches(c));
          if (idx >= 0) {
            const card = p.discard.splice(idx, 1)[0]!;
            card.damage = 0; card.exerted = false; card.justPlayed = false; card.appliedEffects = [];
            if (step.to === "bottom") p.deck.push(card);
            else if (step.to === "top") p.deck.unshift(card);
            else if (step.to === "inkwellExerted") { card.exerted = true; card.justPlayed = true; p.inkwell.push(card); }
            else p.hand.push(card);
            kept += 1;
            ctx.vars[nsK] = String(kept);
          }
        }
        const remain = p.discard.some(matches);
        if (pending !== "__rfdstop__" && kept < keepUpTo && remain) {
          pending = undefined;
          return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "discard", reveal: p.discard.filter(matches).map((c) => c.instanceId) };
        }
        delete ctx.vars[nsK];
        continue;
      }
      const pool = p.discard.filter(matches);
      if (pool.length === 0) continue;
      ctx.vars[nsK] = "0";
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? false, pick: "discard", reveal: pool.map((c) => c.instanceId) };
    }
    if (step.do === "playFree") {
      const from = step.from ?? "hand";
      const p = state.players[ctx.controller];
      const zone = from === "discard" ? p.discard : p.hand;
      const matches = (c: CardInstance) =>
        (c.printed.type === "character" || c.printed.type === "item" || c.printed.type === "location") &&
        (!step.cardType || c.printed.type === step.cardType) &&
        (step.maxCost == null || c.printed.cost <= step.maxCost) &&
        (!step.subtype || c.printed.subtypes.some((s) => s.toLowerCase() === step.subtype!.toLowerCase()));
      if (pending != null) {
        if (pending !== "__pfstop__") {
          const idx = zone.findIndex((c) => c.instanceId === pending && matches(c));
          if (idx >= 0) {
            const card = zone.splice(idx, 1)[0]!;
            card.damage = 0; card.appliedEffects = [];
            if (card.printed.type === "item") { card.justPlayed = false; card.exerted = false; p.items.push(card); }
            else { card.justPlayed = true; card.exerted = false; p.field.push(card); }
            if (step.as) ctx.vars[step.as] = card.instanceId;
            logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_PLAYED", message: `Played ${card.printed.fullName} for free`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
          }
        }
        pending = undefined;
        continue;
      }
      const pool = zone.filter(matches);
      if (pool.length === 0) continue;
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? true, pick: from === "discard" ? "discard" : "hand", handOwner: ctx.controller, reveal: from === "discard" ? pool.map((c) => c.instanceId) : undefined };
    }
    if (step.do === "scryToInkwell") {
      const p = state.players[ctx.controller];
      if (pending != null) {
        const idx = p.deck.findIndex((c) => c.instanceId === pending);
        if (idx >= 0 && idx < step.count) {
          const card = p.deck.splice(idx, 1)[0]!;
          card.exerted = true; card.justPlayed = true; card.appliedEffects = []; card.damage = 0;
          p.inkwell.push(card);
          logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_PUT_INTO_INKWELL", message: `Put ${card.printed.fullName} into inkwell`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
        }
        pending = undefined;
        continue;
      }
      const top = p.deck.slice(0, step.count);
      if (top.length === 0) continue;
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: false, pick: "deck", reveal: top.map((c) => c.instanceId) };
    }
    if (step.do === "searchDeck") {
      const p = state.players[ctx.controller];
      const matches = (c: CardInstance) => (!step.cardType || c.printed.type === step.cardType) && (!step.subtype || c.printed.subtypes.some((s) => s.toLowerCase() === step.subtype!.toLowerCase()));
      const shuffle = () => { const rng = new Rng(state.rngSeed, state.rngCursor); p.deck = rng.shuffle(p.deck); state.rngCursor = rng.cursor; };
      if (pending != null) {
        if (pending !== "__searchstop__") {
          const idx = p.deck.findIndex((c) => c.instanceId === pending && matches(c));
          if (idx >= 0) { const card = p.deck.splice(idx, 1)[0]!; p.hand.push(card); }
        }
        shuffle();
        pending = undefined;
        continue;
      }
      const pool = p.deck.filter(matches);
      if (pool.length === 0) { shuffle(); continue; }
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: false, pick: "deck", reveal: pool.map((c) => c.instanceId) };
    }
    if (step.do === "scryTopOrBottom") {
      const p = state.players[ctx.controller];
      if (pending != null) {
        const window = p.deck.slice(0, step.count);
        const after = p.deck.slice(step.count);
        if (pending === "__sobstop__") {
          p.deck = [...after, ...window]; // all to the bottom
        } else {
          const keep = window.filter((c) => c.instanceId === pending);
          const rest = window.filter((c) => c.instanceId !== pending);
          p.deck = [...keep, ...after, ...rest]; // chosen on top, rest to the bottom
        }
        pending = undefined;
        continue;
      }
      const top = p.deck.slice(0, step.count);
      if (top.length === 0) continue;
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "deck", reveal: top.map((c) => c.instanceId) };
    }
    if (step.do === "lookAtTop") {
      const p = state.players[ctx.controller];
      const keepUpTo = step.keepUpTo ?? 1;
      const nsK = "__scryKept", nsN = "__scryN";
      const moveRest = (windowLen: number) => {
        const rest = p.deck.splice(0, Math.max(0, windowLen));
        if ((step.rest ?? "bottom") === "inkwellExerted") {
          for (const c of rest) { c.exerted = true; c.justPlayed = true; p.inkwell.push(c); }
        } else if (step.rest === "discard") {
          for (const c of rest) { p.discard.push(c); p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1; }
        } else {
          p.deck.push(...rest); // to the bottom, in revealed order
        }
      };
      if (pending != null) {
        let kept = parseInt(ctx.vars[nsK] ?? "0", 10);
        const n = parseInt(ctx.vars[nsN] ?? "0", 10); // originally revealed count
        if (pending !== "__scrystop__") {
          const windowLen = n - kept;
          const idx = p.deck.findIndex((c) => c.instanceId === pending);
          if (idx >= 0 && idx < windowLen && scryMatch(p.deck[idx]!.printed, step.filter)) {
            const card = p.deck.splice(idx, 1)[0]!;
            card.justPlayed = false; card.exerted = false; p.hand.push(card);
            kept += 1;
            ctx.vars[nsK] = String(kept);
          }
        }
        const windowLen = n - kept;
        const moreLegal = p.deck.slice(0, windowLen).some((c) => scryMatch(c.printed, step.filter));
        if (pending !== "__scrystop__" && kept < keepUpTo && windowLen > 0 && moreLegal) {
          pending = undefined;
          return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "deck", reveal: p.deck.slice(0, windowLen).map((c) => c.instanceId) };
        }
        moveRest(windowLen);
        delete ctx.vars[nsK]; delete ctx.vars[nsN];
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_DRAWN", message: `Scry: kept ${kept} of top ${n}` }));
        continue;
      }
      const count = step.countFromUnder ? ctx.source.cardsUnder.length : step.count;
      const top = p.deck.slice(0, count);
      if (top.length === 0) continue; // empty deck (or nothing under) — nothing to look at
      ctx.vars[nsN] = String(top.length);
      ctx.vars[nsK] = "0";
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? false, pick: "deck", reveal: top.map((c) => c.instanceId) };
    }
    applyStep(state, step, ctx, logs);
  }
  return null;
}
