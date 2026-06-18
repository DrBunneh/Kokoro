/** Hot-seat game store: holds a GameSession and re-renders on each mutation. */
import { create } from "zustand";
import { GameSession } from "@/engine/session";
import { createGame, type Action } from "@/engine/actions";
import { db } from "@/state/db";
import { deriveDeckStats } from "@/data/decklist";
import type { CardIndex } from "@/data/cards";
import type { Deck } from "@/data/deck-types";
import { uid } from "@/lib/id";

function flatten(deck: Deck): string[] {
  return deck.cards.flatMap(({ id, count }) => Array<string>(count).fill(id));
}

interface GameMeta {
  deck1Id: string;
  deck2Id: string;
  deck1Colors: string[];
  deck2Colors: string[];
}

interface GameStore {
  session: GameSession | null;
  /** Bumped on every mutation so subscribers re-render (session is mutable). */
  tick: number;
  lastError: string | null;
  meta: GameMeta | null;
  saved: boolean;
  start: (index: CardIndex, p1: Deck, p2: Deck) => void;
  dispatch: (action: Action) => void;
  undo: () => void;
  redo: () => void;
  clearError: () => void;
  end: () => void;
}

/** Persist a finished game for Replays/Stats (once). */
async function persistIfFinished(get: () => GameStore): Promise<void> {
  const { session, meta, saved } = get();
  if (!session || !meta || saved || session.state.status !== "finished") return;
  const s = session.state;
  await db.replays.put({
    id: s.id,
    createdAt: Date.now(),
    playerNames: { 1: s.players[1].name, 2: s.players[2].name },
    deck1Id: meta.deck1Id,
    deck2Id: meta.deck2Id,
    deck1Colors: meta.deck1Colors,
    deck2Colors: meta.deck2Colors,
    firstPlayer: s.firstPlayer,
    winner: s.winner,
    victoryReason: s.victoryReason,
    turnCount: s.turnNumber,
    replay: session.toReplay(),
  });
}

export const useGame = create<GameStore>((set, get) => ({
  session: null,
  tick: 0,
  lastError: null,
  meta: null,
  saved: false,

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
    const meta: GameMeta = {
      deck1Id: p1.id,
      deck2Id: p2.id,
      deck1Colors: deriveDeckStats(p1.cards, index).colors,
      deck2Colors: deriveDeckStats(p2.cards, index).colors,
    };
    set({ session, meta, saved: false, tick: 0, lastError: null });
  },

  dispatch(action) {
    const s = get().session;
    if (!s) return;
    try {
      s.dispatch(action);
      set((st) => ({ tick: st.tick + 1, lastError: null }));
      if (s.state.status === "finished" && !get().saved) {
        set({ saved: true });
        void persistIfFinished(get);
      }
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
    set({ session: null, meta: null, saved: false, tick: 0, lastError: null });
  },
}));
