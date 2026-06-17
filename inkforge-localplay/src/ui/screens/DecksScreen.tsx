import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { deriveDeckStats } from "@/data/decklist";
import { INK_HEX, inkLabel } from "@/ui/components/ink";
import type { InkColor } from "@/data/card-types";

function ColorDot({ color }: { color: InkColor }) {
  return (
    <span
      title={inkLabel(color)}
      className="inline-block h-3 w-3 rounded-full ring-1 ring-white/30"
      style={{ background: INK_HEX[color] }}
    />
  );
}

/** Decks page (spec §11.2): pinned New deck + scrollable deck tiles. */
export function DecksScreen() {
  const navigate = useNavigate();
  const { decks, loaded, load, create } = useDecks();
  const index = useCardDb();

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  async function onNew() {
    const deck = await create();
    navigate(`/decks/${deck.id}/build`);
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onNew}
        className="min-h-tap w-full rounded-xl bg-ink-sapphire/90 px-4 font-semibold text-white active:bg-ink-sapphire"
      >
        + New deck
      </button>

      {loaded && decks.length === 0 && (
        <p className="pt-8 text-center text-sm text-slate-400">
          No decks yet. Create one to get started.
        </p>
      )}

      <ul className="space-y-2">
        {decks.map((deck) => {
          const stats = index ? deriveDeckStats(deck.cards, index) : null;
          return (
            <li key={deck.id}>
              <button
                type="button"
                onClick={() => navigate(`/decks/${deck.id}/list`)}
                className="min-h-tap w-full rounded-xl border border-white/10 bg-white/5 p-3 text-left active:bg-white/10"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-slate-100">
                    {deck.name}
                    {deck.isDefault && <span className="ml-2 text-xs text-ink-amber">★ default</span>}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{deck.format}</span>
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-slate-300">
                  <span className="flex items-center gap-1">
                    {stats?.colors.length
                      ? stats.colors.map((c) => <ColorDot key={c} color={c} />)
                      : <span className="text-slate-500">—</span>}
                  </span>
                  <span>{stats?.totalCount ?? 0} cards</span>
                  <span className="text-emerald-300">{stats?.inkableCount ?? 0} inkable</span>
                  <span className="text-rose-300">{stats?.uninkableCount ?? 0} un</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
