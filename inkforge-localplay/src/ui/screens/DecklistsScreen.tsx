import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import {
  deriveDeckStats,
  exportDecklist,
  parseDecklist,
  validateDeck,
} from "@/data/decklist";
import { INK_HEX } from "@/ui/components/ink";
import type { DeckCard } from "@/data/deck-types";

/** Decklists page (spec §11.4): stats header, actions, tinted card lines, copy/import. */
export function DecklistsScreen() {
  const { deckId } = useParams();
  const navigate = useNavigate();
  const { loaded, load, get, save, remove, setDefault, duplicate } = useDecks();
  const index = useCardDb();

  const [name, setName] = useState("");
  const [cards, setCards] = useState<DeckCard[]>([]);
  const [dirty, setDirty] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const deck = deckId ? get(deckId) : undefined;
  useEffect(() => {
    if (deck) {
      setName(deck.name);
      setCards(deck.cards.map((c) => ({ ...c })));
    }
  }, [deck?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => (index ? deriveDeckStats(cards, index) : null), [index, cards]);
  const warnings = useMemo(() => (index ? validateDeck(cards, index) : []), [index, cards]);
  const sorted = useMemo(() => {
    if (!index) return cards;
    return [...cards].sort((a, b) => {
      const ca = index.get(a.id);
      const cb = index.get(b.id);
      if ((ca?.setNum ?? 0) !== (cb?.setNum ?? 0)) return (ca?.setNum ?? 0) - (cb?.setNum ?? 0);
      return (ca?.cardNum ?? 0) - (cb?.cardNum ?? 0);
    });
  }, [cards, index]);

  if (loaded && !deck) return <p className="text-sm text-slate-400">Deck not found.</p>;

  async function onSave() {
    if (!deck) return;
    await save({ ...deck, name: name.trim() || deck.name, cards });
    setDirty(false);
  }

  async function onCopy() {
    if (!index) return;
    await navigator.clipboard?.writeText(exportDecklist(cards, index));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function onImport() {
    const r = parseDecklist(importText);
    setCards(r.cards);
    setImportWarnings(r.warnings);
    setDirty(true);
    setShowImport(false);
  }

  return (
    <div className="space-y-3">
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setDirty(true);
        }}
        placeholder="Deck name"
        className="w-full rounded-lg bg-white/5 px-3 py-2 text-lg font-semibold text-slate-100 outline-none ring-1 ring-white/10 focus:ring-ink-sapphire"
      />

      <div className="flex gap-3 text-xs text-slate-300">
        <span>{stats?.totalCount ?? 0} cards</span>
        <span className="text-emerald-300">{stats?.inkableCount ?? 0} inkable</span>
        <span className="text-rose-300">{stats?.uninkableCount ?? 0} uninkable</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <button type="button" onClick={() => deck && setDefault(deck.id)} className="min-h-tap rounded-lg bg-white/5">
          {deck?.isDefault ? "★ Default" : "Set Default"}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!deck) return;
            const copy = await duplicate(deck.id);
            if (copy) navigate(`/decks/${copy.id}/list`);
          }}
          className="min-h-tap rounded-lg bg-white/5"
        >
          Duplicate
        </button>
        <button type="button" onClick={onCopy} className="min-h-tap rounded-lg bg-white/5">
          {copied ? "Copied!" : "Copy (text)"}
        </button>
        <button type="button" onClick={() => navigate(`/decks/${deck!.id}/build`)} className="min-h-tap rounded-lg bg-white/5">
          Edit cards
        </button>
      </div>

      <button
        type="button"
        onClick={() => setShowImport((s) => !s)}
        className="text-xs text-ink-sapphire underline"
      >
        {showImport ? "Cancel import" : "Import from text…"}
      </button>
      {showImport && (
        <div className="space-y-2">
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            placeholder={"4 Be Prepared (1-128)\n3 Kida - Crystal Scion (12-160)"}
            className="w-full rounded-lg bg-white/5 p-2 font-mono text-xs text-slate-100 ring-1 ring-white/10"
          />
          <button type="button" onClick={onImport} className="min-h-tap w-full rounded-lg bg-ink-sapphire font-semibold text-white">
            Load decklist
          </button>
        </div>
      )}

      {(warnings.length > 0 || importWarnings.length > 0) && (
        <ul className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200">
          {[...importWarnings, ...warnings].map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      <ul className="space-y-1">
        {sorted.map(({ id, count }) => {
          const card = index?.get(id);
          const color = card?.colors[0];
          return (
            <li
              key={id}
              className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5 text-sm"
              style={color ? { borderLeft: `4px solid ${INK_HEX[color]}` } : undefined}
            >
              <span className="w-5 text-center text-slate-400">{card?.cost ?? "?"}</span>
              <span className="flex-1 truncate text-slate-100">{card?.fullName ?? id}</span>
              <span className="text-slate-300">×{count}</span>
            </li>
          );
        })}
      </ul>

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty}
          className="min-h-tap flex-1 rounded-xl bg-ink-sapphire font-semibold text-white disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={async () => {
            if (deck && confirm("Delete this deck?")) {
              await remove(deck.id);
              navigate("/decks");
            }
          }}
          className="min-h-tap rounded-xl bg-rose-500/20 px-4 text-rose-200"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
