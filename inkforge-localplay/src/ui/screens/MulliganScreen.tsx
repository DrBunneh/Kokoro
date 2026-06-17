import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { db } from "@/state/db";
import { shuffle } from "@/lib/shuffle";
import { CardThumb } from "@/ui/components/CardThumb";
import { cn } from "@/lib/cn";

const HAND_SIZE = 7;
const OUT_MS = 320;
const IN_MS = 340;

type Phase = "ready" | "choosing" | "animating" | "done";
type Anim = "in" | "idle" | "out";

interface Slot {
  key: number;
  id: string;
  anim: Anim;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Mulligan trainer (spec §6.6, §11.6): draw 7, bottom a subset, redraw equal, once. */
export function MulliganScreen() {
  const navigate = useNavigate();
  const { decks, loaded, load } = useDecks();
  const index = useCardDb();

  const [deckId, setDeckId] = useState<string | null>(null);
  const [onThePlay, setOnThePlay] = useState(true);
  const [phase, setPhase] = useState<Phase>("ready");
  const [order, setOrder] = useState<string[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const keyCounter = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nextKey = () => keyCounter.current++;
  const after = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, prefersReducedMotion() ? 0 : ms));
  };

  // Clear pending timers on unmount.
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

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

  /** Promote all freshly-added "in" slots to "idle" so they transition into place. */
  function flushEntering() {
    after(20, () => setSlots((prev) => prev.map((s) => (s.anim === "in" ? { ...s, anim: "idle" } : s))));
  }

  function newHand() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const shuffled = shuffle(flatDeck);
    setOrder(shuffled);
    setSlots(shuffled.slice(0, HAND_SIZE).map((id) => ({ key: nextKey(), id, anim: "in" as Anim })));
    setSelected(new Set());
    setPhase("choosing");
    flushEntering();
  }

  function toggle(key: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function recordResult(redrew: number) {
    if (!deckId) return;
    await db.mulliganResults.add({
      deckId,
      onThePlay,
      kept: HAND_SIZE - redrew,
      redrew,
      timestamp: Date.now(),
    });
  }

  function submitMulligan() {
    const selectedKeys = selected;
    const k = selectedKeys.size;

    if (k === 0) {
      setPhase("done");
      void recordResult(0);
      return;
    }

    setPhase("animating");
    // 1) Animate the bottomed cards out.
    setSlots((prev) => prev.map((s) => (selectedKeys.has(s.key) ? { ...s, anim: "out" } : s)));

    // 2) After they leave, drop them and deal the redraws (entering from the top).
    after(OUT_MS, () => {
      const rest = order.slice(HAND_SIZE);
      const redrawn = rest.slice(0, k).map((id) => ({ key: nextKey(), id, anim: "in" as Anim }));
      setSlots((prev) => [...prev.filter((s) => !selectedKeys.has(s.key)), ...redrawn]);
      setSelected(new Set());
      flushEntering();
      // 3) Settle to "done" once the entrance finishes.
      after(IN_MS, () => setPhase("done"));
    });
    void recordResult(k);
  }

  if (loaded && decks.length === 0) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-slate-400">You need a deck to practise mulligans.</p>
        <button
          type="button"
          onClick={() => navigate("/decks")}
          className="min-h-tap rounded-xl bg-ink-sapphire px-4 font-semibold text-white"
        >
          Go to Decks
        </button>
      </div>
    );
  }

  const animClass: Record<Anim, string> = {
    in: "opacity-0 -translate-y-8 scale-95",
    idle: "opacity-100 translate-y-0 scale-100",
    out: "opacity-0 translate-y-12 scale-90 pointer-events-none",
  };

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
          {phase === "animating" && <p className="mb-2 text-sm text-slate-400">Redrawing…</p>}
          {phase === "done" && <p className="mb-2 text-sm text-emerald-300">Final hand:</p>}

          <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto">
            {slots.map((slot) => {
              const card = index.get(slot.id);
              if (!card) return null;
              const isSel = selected.has(slot.key);
              return (
                <button
                  key={slot.key}
                  type="button"
                  disabled={phase !== "choosing"}
                  onClick={() => toggle(slot.key)}
                  className={cn(
                    "relative rounded-lg transition-all duration-300 ease-out",
                    animClass[slot.anim],
                    isSel && "ring-2 ring-rose-400 brightness-50",
                  )}
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
