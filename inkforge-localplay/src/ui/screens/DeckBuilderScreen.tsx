import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { filterCards } from "@/data/cards";
import { deckCardCount } from "@/data/decklist";
import { CardThumb } from "@/ui/components/CardThumb";
import { INK_COLORS, INK_HEX, inkLabel } from "@/ui/components/ink";
import { cn } from "@/lib/cn";
import type { CardType, InkColor, PrintedCard } from "@/data/card-types";
import type { DeckCard } from "@/data/deck-types";

const MAX_COPIES = 4;
const RESULT_CAP = 120;
const CARD_TYPES: CardType[] = ["character", "action", "song", "item", "location"];

export function DeckBuilderScreen() {
  const { deckId } = useParams();
  const navigate = useNavigate();
  const { loaded, load, get, save } = useDecks();
  const index = useCardDb();

  const [tab, setTab] = useState<"search" | "list">("search");
  const [cards, setCards] = useState<DeckCard[]>([]);
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);

  // Filters
  const [text, setText] = useState("");
  const [colors, setColors] = useState<InkColor[]>([]);
  const [types, setTypes] = useState<CardType[]>([]);
  const [maxCost, setMaxCost] = useState<number | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const deck = deckId ? get(deckId) : undefined;
  useEffect(() => {
    if (deck) {
      setCards(deck.cards.map((c) => ({ ...c })));
      setName(deck.name);
    }
  }, [deck?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => new Map(cards.map((c) => [c.id, c.count])), [cards]);

  const results = useMemo(() => {
    if (!index) return [];
    return filterCards(index.all, {
      text: text || undefined,
      colors: colors.length ? colors : undefined,
      types: types.length ? types : undefined,
      cost: maxCost != null ? { max: maxCost } : undefined,
    });
  }, [index, text, colors, types, maxCost]);

  function addCard(id: string) {
    setCards((prev) => {
      const cur = prev.find((c) => c.id === id);
      if (cur) {
        if (cur.count >= MAX_COPIES) return prev;
        return prev.map((c) => (c.id === id ? { ...c, count: c.count + 1 } : c));
      }
      return [...prev, { id, count: 1 }];
    });
    setDirty(true);
  }

  function removeCard(id: string) {
    setCards((prev) =>
      prev.flatMap((c) => (c.id === id ? (c.count > 1 ? [{ ...c, count: c.count - 1 }] : []) : [c])),
    );
    setDirty(true);
  }

  async function onSave() {
    if (!deck) return;
    await save({ ...deck, name: name.trim() || deck.name, cards });
    setDirty(false);
    navigate(`/decks/${deck.id}/list`);
  }

  if (loaded && !deck) {
    return <p className="text-sm text-slate-400">Deck not found.</p>;
  }

  const total = deckCardCount(cards);

  return (
    <div className="flex h-full flex-col">
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setDirty(true);
        }}
        placeholder="Deck name"
        className="mb-2 w-full rounded-lg bg-white/5 px-3 py-2 text-slate-100 outline-none ring-1 ring-white/10 focus:ring-ink-sapphire"
      />

      <div className="mb-2 flex gap-1 rounded-lg bg-white/5 p-1 text-sm">
        {(["search", "list"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "min-h-tap flex-1 rounded-md capitalize",
              tab === t ? "bg-ink-sapphire text-white" : "text-slate-300",
            )}
          >
            {t === "list" ? `List (${total})` : "Search"}
          </button>
        ))}
      </div>

      {tab === "search" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search name or text…"
            className="mb-2 w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none ring-1 ring-white/10 focus:ring-ink-sapphire"
          />
          <div className="mb-1 flex flex-wrap gap-1">
            {INK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColors((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))}
                className={cn(
                  "min-h-tap rounded-full px-2 text-xs ring-1",
                  colors.includes(c) ? "text-white ring-white" : "text-slate-300 ring-white/20",
                )}
                style={colors.includes(c) ? { background: INK_HEX[c] } : undefined}
              >
                {inkLabel(c)}
              </button>
            ))}
          </div>
          <div className="mb-1 flex flex-wrap gap-1">
            {CARD_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTypes((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))}
                className={cn(
                  "min-h-tap rounded-full px-2 text-xs capitalize ring-1",
                  types.includes(t) ? "bg-white/20 text-white ring-white" : "text-slate-300 ring-white/20",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {[1, 2, 3, 4, 5, 6, 7].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setMaxCost((m) => (m === c ? null : c))}
                className={cn(
                  "min-h-tap w-9 rounded-md text-xs ring-1",
                  maxCost === c ? "bg-white/20 text-white ring-white" : "text-slate-300 ring-white/20",
                )}
              >
                ≤{c}
              </button>
            ))}
          </div>

          <p className="mb-1 text-xs text-slate-400">
            {results.length} cards{results.length > RESULT_CAP ? ` (showing ${RESULT_CAP})` : ""}
          </p>
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto pb-2">
            {results.slice(0, RESULT_CAP).map((card) => (
              <ResultCell
                key={card.id}
                card={card}
                count={counts.get(card.id) ?? 0}
                onAdd={() => addCard(card.id)}
                onRemove={() => removeCard(card.id)}
              />
            ))}
          </div>
        </div>
      ) : (
        <ListTab cards={cards} index={index} onAdd={addCard} onRemove={removeCard} />
      )}

      <button
        type="button"
        onClick={onSave}
        disabled={!dirty}
        className="mt-2 min-h-tap w-full rounded-xl bg-ink-sapphire px-4 font-semibold text-white disabled:opacity-40"
      >
        Save
      </button>
    </div>
  );
}

function ResultCell({
  card,
  count,
  onAdd,
  onRemove,
}: {
  card: PrintedCard;
  count: number;
  onAdd: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="relative">
      <button type="button" onDoubleClick={onAdd} onClick={onAdd} className="block w-full">
        <CardThumb card={card} />
      </button>
      {count > 0 && (
        <span className="absolute right-1 top-1 rounded-full bg-ink-sapphire px-1.5 text-xs font-bold text-white">
          {count}
        </span>
      )}
      <div className="mt-1 flex items-center justify-between">
        <button
          type="button"
          onClick={onRemove}
          disabled={count === 0}
          className="h-6 w-6 rounded bg-white/10 text-sm disabled:opacity-30"
        >
          −
        </button>
        <span className="truncate px-1 text-[10px] text-slate-400">{card.fullName}</span>
        <button
          type="button"
          onClick={onAdd}
          disabled={count >= MAX_COPIES}
          className="h-6 w-6 rounded bg-white/10 text-sm disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

function ListTab({
  cards,
  index,
  onAdd,
  onRemove,
}: {
  cards: DeckCard[];
  index: ReturnType<typeof useCardDb>;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (cards.length === 0) {
    return <p className="flex-1 pt-8 text-center text-sm text-slate-400">No cards yet — add some from Search.</p>;
  }
  const sorted = [...cards].sort((a, b) => {
    const ca = index?.get(a.id);
    const cb = index?.get(b.id);
    return (ca?.cost ?? 0) - (cb?.cost ?? 0);
  });
  return (
    <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
      {sorted.map(({ id, count }) => {
        const card = index?.get(id);
        const color = card?.colors[0];
        return (
          <li
            key={id}
            className="flex items-center gap-2 rounded-lg bg-white/5 p-2"
            style={color ? { borderLeft: `4px solid ${INK_HEX[color]}` } : undefined}
          >
            <span className="w-6 text-center text-sm text-slate-400">{card?.cost ?? "?"}</span>
            <span className="flex-1 truncate text-sm text-slate-100">{card?.fullName ?? id}</span>
            <button type="button" onClick={() => onRemove(id)} className="h-7 w-7 rounded bg-white/10">
              −
            </button>
            <span className="w-5 text-center text-sm">{count}</span>
            <button
              type="button"
              onClick={() => onAdd(id)}
              disabled={count >= MAX_COPIES}
              className="h-7 w-7 rounded bg-white/10 disabled:opacity-30"
            >
              +
            </button>
          </li>
        );
      })}
    </ul>
  );
}
