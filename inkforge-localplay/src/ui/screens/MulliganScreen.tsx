import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { db } from "@/state/db";
import { shuffle } from "@/lib/shuffle";
import { CardThumb } from "@/ui/components/CardThumb";
import { cn } from "@/lib/cn";

const HAND_SIZE = 7;

type Phase = "ready" | "choosing" | "done";

/** Mulligan trainer (spec §6.6, §11.6): draw 7, bottom a subset, redraw equal, once. */
export function MulliganScreen() {
  const navigate = useNavigate();
  const { decks, loaded, load } = useDecks();
  const index = useCardDb();

  const [deckId, setDeckId] = useState<string | null>(null);
  const [onThePlay, setOnThePlay] = useState(true);
  const [phase, setPhase] = useState<Phase>("ready");
  const [order, setOrder] = useState<string[]>([]); // shuffled deck (instance positions)
  const [hand, setHand] = useState<string[]>([]); // ids of opening 7 (or current)
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!deckId && decks.length) setDeckId(decks.find((d) => d.isDefault)?.id ?? decks[0]!.id);
  }, [decks, deckId]);

  const deck = decks.find((d) => d.id === deckId);
  const flatDeck = useMemo(
    () => (deck ? deck.cards.flatMap(({ id, count }) => Array<string>(count).fill(id)) : []),
    [deck],
  );

  function newHand() {
    const shuffled = shuffle(flatDeck);
    setOrder(shuffled);
    setHand(shuffled.slice(0, HAND_SIZE));
    setSelected(new Set());
    setPhase("choosing");
  }

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function submitMulligan() {
    const k = selected.size;
    // Bottom selected, draw k replacements from the rest of the deck.
    const rest = order.slice(HAND_SIZE);
    const kept = hand.filter((_, i) => !selected.has(i));
    const redrawn = rest.slice(0, k);
    setHand([...kept, ...redrawn]);
    setPhase("done");
    if (deckId) {
      await db.mulliganResults.add({
        deckId,
        onThePlay,
        kept: HAND_SIZE - k,
        redrew: k,
        timestamp: Date.now(),
      });
    }
  }

  if (loaded && decks.length === 0) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-slate-400">You need a deck to practise mulligans.</p>
        <button type="button" onClick={() => navigate("/decks")} className="min-h-tap rounded-xl bg-ink-sapphire px-4 font-semibold text-white">
          Go to Decks
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2">
        <select
          value={deckId ?? ""}
          onChange={(e) => {
            setDeckId(e.target.value);
            setPhase("ready");
          }}
          className="min-h-tap flex-1 rounded-lg bg-white/5 px-2 text-sm text-slate-100 ring-1 ring-white/10"
        >
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => navigate("/play")} className="min-h-tap rounded-lg bg-white/5 px-3 text-sm">
          Leave
        </button>
      </div>

      <div className="mb-3 flex gap-1 rounded-lg bg-white/5 p-1 text-sm">
        {(
          [
            ["play", true],
            ["draw", false],
          ] as const
        ).map(([label, val]) => (
          <button
            key={label}
            type="button"
            onClick={() => setOnThePlay(val)}
            className={cn(
              "min-h-tap flex-1 rounded-md capitalize",
              onThePlay === val ? "bg-ink-sapphire text-white" : "text-slate-300",
            )}
          >
            On the {label}
          </button>
        ))}
      </div>
      <p className="mb-2 text-xs text-slate-400">
        {onThePlay ? "First player — you skip your first draw." : "Second player — you draw on turn 1."}
      </p>

      {phase === "ready" && (
        <button type="button" onClick={newHand} className="min-h-tap w-full rounded-xl bg-ink-sapphire font-semibold text-white">
          Draw opening hand
        </button>
      )}

      {phase !== "ready" && index && (
        <>
          {phase === "choosing" && (
            <p className="mb-2 text-sm text-slate-300">
              Tap cards to bottom them, then confirm. ({selected.size} selected)
            </p>
          )}
          {phase === "done" && <p className="mb-2 text-sm text-emerald-300">Final hand:</p>}
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto">
            {hand.map((id, i) => {
              const card = index.get(id);
              if (!card) return null;
              const isSel = selected.has(i);
              return (
                <button
                  key={`${id}-${i}`}
                  type="button"
                  disabled={phase === "done"}
                  onClick={() => toggle(i)}
                  className={cn("relative rounded-lg", isSel && "opacity-40 ring-2 ring-rose-400")}
                >
                  <CardThumb card={card} />
                  {isSel && (
                    <span className="absolute inset-x-0 top-1 text-center text-xs font-bold text-rose-200">
                      ↓ bottom
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {phase === "choosing" && (
            <button type="button" onClick={submitMulligan} className="mt-2 min-h-tap w-full rounded-xl bg-ink-sapphire font-semibold text-white">
              {selected.size === 0 ? "Keep all 7" : `Bottom ${selected.size} & redraw`}
            </button>
          )}
          {phase === "done" && (
            <button type="button" onClick={() => setPhase("ready")} className="mt-2 min-h-tap w-full rounded-xl bg-white/10 font-semibold text-white">
              New hand
            </button>
          )}
        </>
      )}
    </div>
  );
}
