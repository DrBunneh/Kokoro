import type { InkColor } from "./card-types";

export interface DeckCard {
  /** "{set}-{number}" identity (authoritative). */
  id: string;
  count: number;
}

export interface Deck {
  id: string;
  name: string;
  /** e.g. "Core Constructed". */
  format: string;
  cards: DeckCard[];
  isDefault: boolean;
  /** PvP-ready flag — true once all images are cached (spec §5.2). */
  imagesCached: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DeckStats {
  colors: InkColor[];
  totalCount: number;
  inkableCount: number;
  uninkableCount: number;
}
