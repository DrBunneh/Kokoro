import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useGame } from "@/state/useGame";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { CardThumb } from "@/ui/components/CardThumb";
import { hasKeyword, keywordValue } from "@/engine/keywords";
import { cn } from "@/lib/cn";
import type { CardInstance, GameState, PlayerId } from "@/engine/state";

const other = (p: PlayerId): PlayerId => (p === 1 ? 2 : 1);

export function HotSeatScreen() {
  const navigate = useNavigate();
  const index = useCardDb();
  const { decks, loaded, load } = useDecks();
  const session = useGame((s) => s.session);
  const tick = useGame((s) => s.tick);
  const end = useGame((s) => s.end);

  const [deck1, setDeck1] = useState<string>("");
  const [deck2, setDeck2] = useState<string>("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    if (decks.length && !deck1) {
      const def = decks.find((d) => d.isDefault) ?? decks[0]!;
      setDeck1(def.id);
      setDeck2(decks[0]!.id);
    }
  }, [decks, deck1]);

  // Keep `tick` referenced so the component re-renders on each mutation.
  void tick;

  if (!session) {
    if (loaded && decks.length === 0) {
      return (
        <div className="space-y-3 text-center">
          <p className="text-sm text-slate-400">Create a deck first to play hot-seat.</p>
          <button onClick={() => navigate("/decks")} className="min-h-tap rounded-xl bg-ink-sapphire px-4 font-semibold text-white">
            Go to Decks
          </button>
        </div>
      );
    }
    return (
      <SetupPanel
        decks={decks}
        deck1={deck1}
        deck2={deck2}
        ready={!!index}
        setDeck1={setDeck1}
        setDeck2={setDeck2}
        onStart={() => {
          const d1 = decks.find((d) => d.id === deck1);
          const d2 = decks.find((d) => d.id === deck2);
          if (index && d1 && d2) useGame.getState().start(index, d1, d2);
        }}
      />
    );
  }

  if (!index) return <p className="text-slate-400">Loading…</p>;
  return <Board state={session.state} onLeave={() => { end(); navigate("/play"); }} />;
}

function SetupPanel({
  decks, deck1, deck2, ready, setDeck1, setDeck2, onStart,
}: {
  decks: { id: string; name: string }[];
  deck1: string; deck2: string; ready: boolean;
  setDeck1: (v: string) => void; setDeck2: (v: string) => void;
  onStart: () => void;
}) {
  const Picker = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
    <label className="block">
      <span className="mb-1 block text-xs text-slate-400">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-h-tap w-full rounded-lg bg-white/5 px-3 text-slate-100 ring-1 ring-white/10">
        {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
    </label>
  );
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Hot-seat (pass &amp; play)</h1>
      <Picker label="Player 1 deck" value={deck1} onChange={setDeck1} />
      <Picker label="Player 2 deck" value={deck2} onChange={setDeck2} />
      <button onClick={onStart} disabled={!ready} className="min-h-tap w-full rounded-xl bg-ink-sapphire font-semibold text-white disabled:opacity-50">
        {ready ? "Start game" : "Loading cards…"}
      </button>
    </div>
  );
}

/* ----------------------------- Board ----------------------------- */

function ErrorToast() {
  const error = useGame((s) => s.lastError);
  const clear = useGame((s) => s.clearError);
  useEffect(() => {
    if (error) {
      const t = setTimeout(clear, 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [error, clear]);
  if (!error) return null;
  return <div className="fixed inset-x-0 top-2 z-50 mx-auto w-fit rounded-lg bg-rose-600/90 px-3 py-1 text-sm text-white">{error}</div>;
}

function Board({ state, onLeave }: { state: GameState; onLeave: () => void }) {
  const dispatch = useGame((s) => s.dispatch);

  if (state.status === "coin_toss") {
    return (
      <div className="mx-auto max-w-md space-y-4 text-center">
        <ErrorToast />
        <p className="text-slate-200">
          <strong>{state.players[state.coinToss!.winner].name}</strong> won the toss. Who goes first?
        </p>
        <div className="flex gap-2">
          {([1, 2] as PlayerId[]).map((p) => (
            <button key={p} onClick={() => dispatch({ type: "CHOOSE_STARTING_PLAYER", player: p })} className="min-h-tap flex-1 rounded-xl bg-white/10 font-semibold text-white">
              {state.players[p].name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (state.status === "mulligan") {
    return <MulliganPhase state={state} />;
  }

  if (state.status === "finished") {
    return (
      <div className="mx-auto max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-bold text-emerald-300">
          {state.winner ? `${state.players[state.winner].name} wins!` : "Game over"}
        </h1>
        <p className="text-sm text-slate-400">By {state.victoryReason}.</p>
        <button onClick={onLeave} className="min-h-tap w-full rounded-xl bg-ink-sapphire font-semibold text-white">Leave</button>
      </div>
    );
  }

  return <PlayPhase state={state} onLeave={onLeave} />;
}

function MulliganPhase({ state }: { state: GameState }) {
  const dispatch = useGame((s) => s.dispatch);
  const [sel, setSel] = useState<Set<string>>(new Set());
  // First not-done player mulligans.
  const pid: PlayerId = !state.mulliganState!.done[state.firstPlayer ?? 1]
    ? (state.firstPlayer ?? 1)
    : other(state.firstPlayer ?? 1);
  const p = state.players[pid];

  return (
    <div className="space-y-2">
      <ErrorToast />
      <p className="text-sm text-slate-300">
        <strong>{p.name}</strong> — tap cards to bottom, then confirm. ({sel.size})
      </p>
      <div className="grid grid-cols-4 gap-2 landscape:grid-cols-7">
        {p.hand.map((c) => (
          <button key={c.instanceId} onClick={() => setSel((s) => { const n = new Set(s); n.has(c.instanceId) ? n.delete(c.instanceId) : n.add(c.instanceId); return n; })} className={cn("rounded-lg", sel.has(c.instanceId) && "ring-2 ring-rose-400 brightness-50")}>
            <CardThumb card={c.printed} />
          </button>
        ))}
      </div>
      <button
        onClick={() => { dispatch({ type: "MULLIGAN", player: pid, cardInstanceIds: [...sel] }); setSel(new Set()); }}
        className="mx-auto mt-2 block min-h-tap w-full max-w-md rounded-xl bg-ink-sapphire font-semibold text-white"
      >
        {sel.size === 0 ? "Keep all 7" : `Bottom ${sel.size} & redraw`}
      </button>
    </div>
  );
}

function readyInk(p: GameState["players"][PlayerId]): number {
  return p.inkwell.filter((c) => !c.exerted).length;
}

/**
 * Inkwell as a shared card pool. Freshly-inked cards (justPlayed) are face-up
 * to both players until the end of the turn they're played; then card backs.
 */
function InkPool({ player, mine }: { player: GameState["players"][PlayerId]; mine?: boolean }) {
  const ink = player.inkwell;
  return (
    <div className="flex items-center justify-center gap-0.5">
      <span className="mr-1 w-16 shrink-0 text-right text-[10px] text-slate-500">
        {mine ? "your" : "their"} ink {ink.filter((c) => !c.exerted).length}/{ink.length}
      </span>
      <div className="flex flex-wrap items-center gap-0.5">
        {ink.length === 0 && <span className="text-[10px] text-slate-600">—</span>}
        {ink.map((c) => (
          <div key={c.instanceId} className={cn("h-9 w-6 overflow-hidden rounded-sm border border-white/15", c.exerted && "rotate-12 opacity-40")}>
            {c.justPlayed ? (
              <CardThumb card={c.printed} className="h-full w-full rounded-none" />
            ) : (
              <div className="h-full w-full bg-gradient-to-br from-indigo-700 to-slate-900" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayPhase({ state, onLeave }: { state: GameState; onLeave: () => void }) {
  const dispatch = useGame((s) => s.dispatch);
  const undo = useGame((s) => s.undo);
  const redo = useGame((s) => s.redo);
  const me = state.currentPlayer;
  const opp = other(me);
  const meP = state.players[me];
  const oppP = state.players[opp];

  const [selHand, setSelHand] = useState<string | null>(null);
  const [selField, setSelField] = useState<string | null>(null);
  const [attacker, setAttacker] = useState<string | null>(null);
  const [curtain, setCurtain] = useState(false);
  const [manualSel, setManualSel] = useState<string | null>(null);

  const prompt = state.pendingPrompts[0] ?? null;
  const ink = readyInk(meP);

  // Route a board tap to bag-prompt resolution when one is pending.
  function promptTap(id: string): boolean {
    if (!prompt) return false;
    if (prompt.resume) {
      dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id, targetInstanceId: id });
    } else {
      setManualSel(id);
    }
    return true;
  }
  const selectedChar = meP.field.find((c) => c.instanceId === selField);
  const canQuestSel = !!selectedChar && selectedChar.printed.type === "character" && !selectedChar.exerted && !selectedChar.justPlayed && (selectedChar.printed.lore ?? 0) > 0;
  const canAttackSel = !!selectedChar && selectedChar.printed.type === "character" && !selectedChar.exerted && (!selectedChar.justPlayed || hasKeyword(selectedChar, "Rush"));

  function endTurn() {
    setSelHand(null);
    setSelField(null);
    setAttacker(null);
    dispatch({ type: "END_TURN" });
    setCurtain(true);
  }

  if (curtain) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <p className="text-lg text-slate-200">Pass the device to</p>
        <p className="text-2xl font-bold text-ink-sapphire">{state.players[state.currentPlayer].name}</p>
        <button onClick={() => setCurtain(false)} className="min-h-tap rounded-xl bg-ink-sapphire px-6 font-semibold text-white">
          I'm ready
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 text-sm">
      <ErrorToast />
      {/* Opponent */}
      <div className="flex items-center justify-between rounded-lg bg-white/5 px-2 py-1 text-xs text-slate-300">
        <span className="font-semibold">{oppP.name}</span>
        <span>◊ {oppP.lore} lore</span>
        <span>✋ {oppP.hand.length}</span>
        <span>🂠 {oppP.deck.length}</span>
      </div>
      {/* Opponent side: board → inkwell (inkwell nearest the centre line). */}
      <FieldRow cards={oppP.field} enemy mode={attacker || prompt ? "target" : "none"} onCardTap={(c) => { if (promptTap(c.instanceId)) return; if (attacker) { dispatch({ type: "ATTACK", attackerId: attacker, defenderId: c.instanceId }); setAttacker(null); } }} />
      <ItemRow items={oppP.items} enemy onItemTap={(c) => promptTap(c.instanceId)} />
      <InkPool player={oppP} />

      {/* Gap between the two players' sides. */}
      <div className="flex-1" />

      {/* My side: board → inkwell → (status + hand below). */}
      <FieldRow
        cards={meP.field}
        mode={attacker ? "attacking" : "mine"}
        selectedId={attacker ?? selField}
        onCardTap={(c) => {
          if (promptTap(c.instanceId)) return;
          if (attacker) { setAttacker(null); return; }
          setSelHand(null);
          setSelField((id) => (id === c.instanceId ? null : c.instanceId));
        }}
      />
      <ItemRow items={meP.items} onItemTap={(c) => promptTap(c.instanceId)} />
      <InkPool player={meP} mine />
      {prompt && <PromptBar state={state} prompt={prompt} me={me} manualSel={manualSel} onClearManualSel={() => setManualSel(null)} />}
      {!prompt && selectedChar && !attacker && (
        <div className="flex gap-1">
          <button disabled={!canQuestSel} onClick={() => { dispatch({ type: "QUEST", cardInstanceId: selectedChar.instanceId }); setSelField(null); }} className="min-h-tap flex-1 rounded-lg bg-white/10 text-xs disabled:opacity-30">Quest (+{selectedChar.printed.lore ?? 0})</button>
          <button disabled={!canAttackSel} onClick={() => { setAttacker(selectedChar.instanceId); setSelField(null); }} className="min-h-tap flex-1 rounded-lg bg-amber-500/30 text-xs text-amber-100 disabled:opacity-30">Challenge</button>
        </div>
      )}

      {/* My status + hand */}
      <div className="flex items-center justify-between rounded-lg bg-white/5 px-2 py-1 text-xs">
        <span className="font-semibold text-ink-sapphire">{meP.name} (you)</span>
        <span>◊ {meP.lore}</span>
        <span>💧 {ink}/{meP.inkwell.length}{state.hasInkedThisTurn ? "" : " · can ink"}</span>
        <span>🂠 {meP.deck.length}</span>
      </div>

      {attacker && (
        <p className="text-center text-xs text-amber-200">Select an enemy character to challenge, or tap your attacker again to cancel.</p>
      )}

      <HandRow
        cards={meP.hand}
        field={meP.field}
        selectedId={selHand}
        canInk={!state.hasInkedThisTurn}
        ink={ink}
        onCardTap={(c) => setSelHand((id) => (id === c.instanceId ? null : c.instanceId))}
        onInk={(c) => { dispatch({ type: "ADD_TO_INK", cardInstanceId: c.instanceId }); setSelHand(null); }}
        onPlay={(c) => { dispatch({ type: "PLAY_CARD", cardInstanceId: c.instanceId }); setSelHand(null); }}
        onShift={(c, baseId) => { dispatch({ type: "PLAY_CARD", cardInstanceId: c.instanceId, shiftOnto: baseId }); setSelHand(null); }}
        onSing={(c, singerIds) => { dispatch({ type: "PLAY_CARD", cardInstanceId: c.instanceId, singers: singerIds }); setSelHand(null); }}
      />

      {/* Quest hint for selected field character is handled by tap above. */}
      <div className="flex gap-1">
        <button onClick={undo} className="min-h-tap flex-1 rounded-lg bg-white/10 text-xs">↶ Undo</button>
        <button onClick={redo} className="min-h-tap flex-1 rounded-lg bg-white/10 text-xs">↷ Redo</button>
        <button onClick={endTurn} disabled={!!prompt} className="min-h-tap flex-[2] rounded-lg bg-ink-sapphire text-xs font-semibold text-white disabled:opacity-40">End turn</button>
        <button onClick={() => dispatch({ type: "GAME_FINISH", winner: opp, reason: "concession" })} className="min-h-tap flex-1 rounded-lg bg-rose-500/20 text-xs text-rose-200">Concede</button>
      </div>
      <button onClick={onLeave} className="text-center text-[10px] text-slate-500 underline">Leave game</button>
    </div>
  );
}

function PromptBar({
  state, prompt, me, manualSel, onClearManualSel,
}: {
  state: GameState;
  prompt: NonNullable<GameState["pendingPrompts"][number]>;
  me: PlayerId;
  manualSel: string | null;
  onClearManualSel: () => void;
}) {
  const dispatch = useGame((s) => s.dispatch);
  const meP = state.players[me];
  const allOnBoard = [
    ...state.players[1].field, ...state.players[2].field,
    ...state.players[1].items, ...state.players[2].items,
  ];
  const card = manualSel ? allOnBoard.find((c) => c.instanceId === manualSel) : null;
  const setLore = (value: number) => dispatch({ type: "MANUAL_ADJUST", ops: [{ kind: "setLore", player: me, value }] });
  const setDamage = (instanceId: string, value: number) => dispatch({ type: "MANUAL_ADJUST", ops: [{ kind: "setDamage", instanceId, value }] });
  const setExerted = (instanceId: string, value: boolean) => dispatch({ type: "MANUAL_ADJUST", ops: [{ kind: "setExerted", instanceId, value }] });

  return (
    <div className="space-y-2 rounded-lg bg-amber-500/15 p-2 text-xs">
      <p className="font-semibold text-amber-100">Resolve ability ({state.players[prompt.player].name}):</p>
      <p className="text-amber-50">{prompt.text}</p>
      {prompt.resume ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-amber-200">Tap a character to target.</span>
          <button onClick={() => dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id })} className="rounded bg-white/10 px-2 py-1">No target</button>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span>Your lore:</span>
            <button onClick={() => setLore(Math.max(0, meP.lore - 1))} className="h-6 w-6 rounded bg-white/10">−</button>
            <span className="w-5 text-center">{meP.lore}</span>
            <button onClick={() => setLore(meP.lore + 1)} className="h-6 w-6 rounded bg-white/10">+</button>
          </div>
          {card && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate">{card.printed.fullName}</span>
              <span>dmg</span>
              <button onClick={() => setDamage(card.instanceId, Math.max(0, card.damage - 1))} className="h-6 w-6 rounded bg-white/10">−</button>
              <span className="w-5 text-center">{card.damage}</span>
              <button onClick={() => setDamage(card.instanceId, card.damage + 1)} className="h-6 w-6 rounded bg-white/10">+</button>
              <button onClick={() => setExerted(card.instanceId, !card.exerted)} className="rounded bg-white/10 px-2">{card.exerted ? "Ready" : "Exert"}</button>
            </div>
          )}
          <p className="text-[10px] text-amber-200">Tap a card to adjust it; Undo reverts.</p>
          <button onClick={() => { dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id }); onClearManualSel(); }} className="w-full rounded bg-ink-sapphire px-2 py-1 font-semibold text-white">
            Done
          </button>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  cards, enemy, selectedId, mode, onCardTap,
}: {
  cards: CardInstance[];
  enemy?: boolean;
  selectedId?: string | null;
  mode: "none" | "mine" | "attacking" | "target";
  onCardTap: (c: CardInstance) => void;
}) {
  return (
    <div className={cn("flex min-h-[64px] items-center gap-1 overflow-x-auto rounded-lg p-1", enemy ? "bg-rose-500/5" : "bg-emerald-500/5")}>
      {cards.length === 0 && <span className="px-2 text-[10px] text-slate-500">{enemy ? "No enemy characters" : "Your field is empty"}</span>}
      {cards.map((c) => (
        <button
          key={c.instanceId}
          onClick={() => onCardTap(c)}
          className={cn(
            "relative w-16 shrink-0 rounded transition",
            c.exerted && "rotate-6 opacity-80",
            c.justPlayed && "brightness-75",
            selectedId === c.instanceId && "ring-2 ring-amber-300",
            mode === "target" && enemy && "ring-1 ring-rose-300",
          )}
        >
          <CardThumb card={c.printed} />
          {c.damage > 0 && <span className="absolute right-0 top-0 rounded-bl bg-rose-600 px-1 text-[10px] font-bold text-white">{c.damage}</span>}
        </button>
      ))}
    </div>
  );
}

/** Items / locations in play. Shown as a thin strip on the owner's board. */
function ItemRow({ items, enemy, onItemTap }: { items: CardInstance[]; enemy?: boolean; onItemTap: (c: CardInstance) => void }) {
  if (items.length === 0) return null;
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto rounded-lg px-1 py-0.5", enemy ? "bg-rose-500/5" : "bg-amber-500/5")}>
      <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-500">items</span>
      {items.map((c) => (
        <button
          key={c.instanceId}
          onClick={() => onItemTap(c)}
          className={cn("relative w-12 shrink-0 rounded transition", c.exerted && "rotate-6 opacity-80")}
        >
          <CardThumb card={c.printed} />
          {c.damage > 0 && <span className="absolute right-0 top-0 rounded-bl bg-rose-600 px-1 text-[10px] font-bold text-white">{c.damage}</span>}
        </button>
      ))}
    </div>
  );
}

/** Greedily pick ready singers whose combined value covers a song's cost. */
function pickSingers(field: CardInstance[], cost: number): string[] {
  const ids: string[] = [];
  let value = 0;
  for (const c of field) {
    if (c.printed.type !== "character" || c.exerted) continue;
    value += Math.max(c.printed.cost, keywordValue(c, "Singer"));
    ids.push(c.instanceId);
    if (value >= cost) return ids;
  }
  return value >= cost ? ids : [];
}

function HandRow({
  cards, field, selectedId, canInk, ink, onCardTap, onInk, onPlay, onShift, onSing,
}: {
  cards: CardInstance[];
  field: CardInstance[];
  selectedId: string | null;
  canInk: boolean;
  ink: number;
  onCardTap: (c: CardInstance) => void;
  onInk: (c: CardInstance) => void;
  onPlay: (c: CardInstance) => void;
  onShift: (c: CardInstance, baseId: string) => void;
  onSing: (c: CardInstance, singerIds: string[]) => void;
}) {
  return (
    <div className="flex items-end gap-1 overflow-x-auto rounded-lg bg-white/5 p-1">
      {cards.map((c) => {
        const selected = selectedId === c.instanceId;
        const shiftCost = keywordValue(c, "Shift");
        const shiftBase = shiftCost > 0 ? field.find((f) => f.printed.type === "character" && f.printed.name === c.printed.name) : undefined;
        const singers = c.printed.type === "song" ? pickSingers(field, c.printed.cost) : [];
        return (
          <div key={c.instanceId} className="shrink-0">
            <button onClick={() => onCardTap(c)} className={cn("block w-16 rounded", selected && "ring-2 ring-ink-sapphire")}>
              <CardThumb card={c.printed} />
            </button>
            {selected && (
              <div className="mt-1 flex flex-wrap gap-0.5">
                <button disabled={!canInk || !c.printed.inkable} onClick={() => onInk(c)} className="flex-1 rounded bg-white/10 px-1 text-[10px] disabled:opacity-30">Ink</button>
                <button disabled={ink < c.printed.cost} onClick={() => onPlay(c)} className="flex-1 rounded bg-ink-sapphire px-1 text-[10px] text-white disabled:opacity-30">Play {c.printed.cost}</button>
                {shiftBase && ink >= shiftCost && (
                  <button onClick={() => onShift(c, shiftBase.instanceId)} className="flex-1 rounded bg-ink-amethyst/70 px-1 text-[10px] text-white">Shift {shiftCost}</button>
                )}
                {singers.length > 0 && (
                  <button onClick={() => onSing(c, singers)} className="flex-1 rounded bg-ink-emerald/70 px-1 text-[10px] text-white">Sing</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
