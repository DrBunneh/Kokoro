/** Deck list state (Zustand) backed by Dexie. UI state only — engine stays pure. */
import { create } from "zustand";
import { db } from "./db";
import { uid } from "@/lib/id";
import type { Deck } from "@/data/deck-types";

interface DecksState {
  decks: Deck[];
  loaded: boolean;
  load: () => Promise<void>;
  create: (partial?: Partial<Deck>) => Promise<Deck>;
  save: (deck: Deck) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<Deck | undefined>;
  get: (id: string) => Deck | undefined;
}

function newDeck(partial?: Partial<Deck>): Deck {
  const now = Date.now();
  return {
    id: uid(),
    name: "New deck",
    format: "Core Constructed",
    cards: [],
    isDefault: false,
    imagesCached: false,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export const useDecks = create<DecksState>((set, get) => ({
  decks: [],
  loaded: false,

  async load() {
    const decks = await db.decks.orderBy("updatedAt").reverse().toArray();
    set({ decks, loaded: true });
  },

  async create(partial) {
    const deck = newDeck(partial);
    await db.decks.put(deck);
    set((s) => ({ decks: [deck, ...s.decks] }));
    return deck;
  },

  async save(deck) {
    const updated = { ...deck, updatedAt: Date.now() };
    await db.decks.put(updated);
    set((s) => ({
      decks: [updated, ...s.decks.filter((d) => d.id !== updated.id)],
    }));
  },

  async remove(id) {
    await db.decks.delete(id);
    set((s) => ({ decks: s.decks.filter((d) => d.id !== id) }));
  },

  async setDefault(id) {
    const decks = get().decks.map((d) => ({ ...d, isDefault: d.id === id }));
    await db.transaction("rw", db.decks, async () => {
      await Promise.all(decks.map((d) => db.decks.put(d)));
    });
    set({ decks });
  },

  async duplicate(id) {
    const src = get().get(id);
    if (!src) return undefined;
    const copy = newDeck({
      name: `${src.name} (copy)`,
      format: src.format,
      cards: src.cards.map((c) => ({ ...c })),
    });
    await db.decks.put(copy);
    set((s) => ({ decks: [copy, ...s.decks] }));
    return copy;
  },

  get(id) {
    return get().decks.find((d) => d.id === id);
  },
}));
