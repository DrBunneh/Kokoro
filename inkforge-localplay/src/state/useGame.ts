/** Hot-seat game store: holds a GameSession and re-renders on each mutation. */
import { create } from "zustand";
import { GameSession } from "@/engine/session";
import { createGame, type Action } from "@/engine/actions";
import type { CardIndex } from "@/data/cards";
import type { Deck } from "@/data/deck-types";
import { uid } from "@/lib/id";

function flatten(deck: Deck): string[] {
  return deck.cards.flatMap(({ id, count }) => Array<string>(count).fill(id));
}

interface GameStore {
  session: GameSession | null;
  /** Bumped on every mutation so subscribers re-render (session is mutable). */
  tick: number;
  lastError: string | null;
  start: (index: CardIndex, p1: Deck, p2: Deck) => void;
  dispatch: (action: Action) => void;
  undo: () => void;
  redo: () => void;
  clearError: () => void;
  end: () => void;
}

export const useGame = create<GameStore>((set, get) => ({
  session: null,
  tick: 0,
  lastError: null,

  start(index, p1, p2) {
    const session = new GameSession(
      createGame({
        id: uid(),
        seed: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        lookup: (id) => index.get(id),
        players: {
          1: { name: p1.name, deck: flatten(p1) },
          2: { name: p2.name, deck: flatten(p2) },
        },
      }),
    );
    set({ session, tick: 0, lastError: null });
  },

  dispatch(action) {
    const s = get().session;
    if (!s) return;
    try {
      s.dispatch(action);
      set((st) => ({ tick: st.tick + 1, lastError: null }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : "Illegal action" });
    }
  },

  undo() {
    get().session?.undo();
    set((st) => ({ tick: st.tick + 1, lastError: null }));
  },
  redo() {
    get().session?.redo();
    set((st) => ({ tick: st.tick + 1, lastError: null }));
  },
  clearError() {
    set({ lastError: null });
  },
  end() {
    set({ session: null, tick: 0, lastError: null });
  },
}));
