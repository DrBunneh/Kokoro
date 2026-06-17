/**
 * Local persistence (spec §3). Dexie/IndexedDB stores decks now; replays, stats,
 * and per-game results are added in P3. Works in the browser and the Capacitor
 * WebView; critical values are mirrored to Preferences/Filesystem at P2.
 */
import Dexie, { type EntityTable } from "dexie";
import type { Deck } from "@/data/deck-types";

/** One recorded Mulligan decision (feeds Stats §10.2: keep rates OTP/OTD). */
export interface MulliganResult {
  id?: number;
  deckId: string;
  onThePlay: boolean;
  /** Cards kept from the opening 7. */
  kept: number;
  /** Cards bottomed and redrawn. */
  redrew: number;
  timestamp: number;
}

export class LocalPlayDB extends Dexie {
  decks!: EntityTable<Deck, "id">;
  mulliganResults!: EntityTable<MulliganResult, "id">;

  constructor() {
    super("inkforge-localplay");
    this.version(1).stores({
      // Indexed fields only; the full Deck object is stored per row.
      decks: "id, name, isDefault, updatedAt",
    });
    this.version(2).stores({
      decks: "id, name, isDefault, updatedAt",
      mulliganResults: "++id, deckId, onThePlay, timestamp",
    });
  }
}

export const db = new LocalPlayDB();
