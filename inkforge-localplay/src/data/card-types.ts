/**
 * Printed card data — the denormalised, immutable fields copied from the card
 * DB into each CardInstance at game start (spec §4.2, §5.1). This is the subset
 * the engine and UI need; the engine never reads the external catalog mid-game.
 *
 * Identity: `id = "{set}-{number}"` (e.g. "6-124"), matching the replay `id`,
 * the duels.ink image URL, and the decklist `(set-number)` token.
 */
export type CardType = "character" | "action" | "item" | "location" | "song";

export type InkColor = "amber" | "amethyst" | "emerald" | "ruby" | "sapphire" | "steel";

export interface KeywordAbility {
  /** Keyword as printed, e.g. "Evasive", "Resist +1", "Shift 5". */
  ability: string;
}

export interface SpecialAbility {
  /** Display name as printed, e.g. "CHEEEEHOOOO!". */
  name: string;
  /** Stable key for DSL / card-effects.json lookup, e.g. "cheeeehoooo". */
  slug: string;
  /** Reminder/effect text. */
  effect: string;
}

export interface PrintedCard {
  id: string;
  fullName: string;
  name: string;
  title?: string;
  type: CardType;
  colors: InkColor[];
  cost: number;
  inkable: boolean;
  strength?: number;
  willpower?: number;
  lore?: number;
  moveCost?: number;
  abilities: KeywordAbility[];
  specialAbilities: SpecialAbility[];
  subtypes: string[];
  rulesText: string;
  rarity: string;
  /** Set number parsed from the identifier, for filtering/sorting. */
  setNum: number;
  /** Collector number within the set. */
  cardNum: number;
}

export interface CardDatabase {
  generatedAt: string;
  source: string;
  /** Hash of the upstream catalog, for change detection. */
  catalogHash?: string;
  count: number;
  cards: PrintedCard[];
}
