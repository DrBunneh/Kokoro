import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { deriveDeckStats, parseDecklist } from "@/data/decklist";
import { STARTER_DECK_NAME, STARTER_DECK_TEXT } from "@/data/starter-deck";
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
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  async function onNew() {
    const deck = await create();
    navigate(`/decks/${deck.id}/build`);
  }

  /** Create a deck directly from decklist text (paste/upload), skipping the builder. */
  async function createFromText(text: string, name?: string) {
    const r = parseDecklist(text);
    if (r.cards.length === 0) return;
    const deck = await create({ name: name ?? "Imported deck", cards: r.cards });
    navigate(`/decks/${deck.id}/list`);
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

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setShowImport((s) => !s)}
          className="min-h-tap flex-1 rounded-xl bg-white/10 text-sm font-medium text-slate-100"
        >
          {showImport ? "Close import" : "Import decklist"}
        </button>
        {!decks.some((d) => d.name === STARTER_DECK_NAME) && (
          <button
            type="button"
            onClick={() => createFromText(STARTER_DECK_TEXT, STARTER_DECK_NAME)}
            className="min-h-tap flex-1 rounded-xl bg-ink-emerald/70 text-sm font-medium text-white"
          >
            + Starter deck
          </button>
        )}
      </div>

      {showImport && (
        <div className="space-y-2 rounded-xl border border-white/10 p-2">
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            placeholder={"4 Be Prepared (1-128)\n3 Kida - Crystal Scion (12-160)"}
            className="w-full rounded-lg bg-white/5 p-2 font-mono text-xs text-slate-100 ring-1 ring-white/10"
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} className="min-h-tap rounded-lg bg-white/10 px-3 text-sm">Upload .txt</button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImportText(await f.text()); e.target.value = ""; }}
            />
            <button
              type="button"
              disabled={!importText.trim()}
              onClick={() => createFromText(importText)}
              className="min-h-tap flex-1 rounded-lg bg-ink-sapphire font-semibold text-white disabled:opacity-40"
            >
              Create deck
            </button>
          </div>
        </div>
      )}

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
