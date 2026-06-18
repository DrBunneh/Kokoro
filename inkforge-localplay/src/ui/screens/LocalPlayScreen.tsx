import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { QrCode } from "@/ui/components/QrCode";
import { CardThumb } from "@/ui/components/CardThumb";
import { WebRtcTransport } from "@/net/webrtc";
import { NetGame } from "@/net/netgame";
import { createGame } from "@/engine/actions";
import { hasKeyword } from "@/engine/keywords";
import { cn } from "@/lib/cn";
import type { Deck } from "@/data/deck-types";
import type { PrintedCard } from "@/data/card-types";
import type { PlayerId } from "@/engine/state";

type Phase = "menu" | "host" | "join" | "connected" | "error";

/**
 * Local PvP pairing wizard (spec §8). WebRTC with manual QR/paste signalling.
 * NOTE: requires two devices on a local link; unverifiable in the sandbox.
 */
export function LocalPlayScreen() {
  const navigate = useNavigate();
  const index = useCardDb();
  const { decks, loaded, load } = useDecks();
  const [phase, setPhase] = useState<Phase>("menu");
  const [deckId, setDeckId] = useState("");
  const [myCode, setMyCode] = useState("");
  const [peerCode, setPeerCode] = useState("");
  const [status, setStatus] = useState("");
  const [, setTick] = useState(0);

  const transportRef = useRef<WebRtcTransport | null>(null);
  const gameRef = useRef<NetGame | null>(null);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => { if (decks.length && !deckId) setDeckId((decks.find((d) => d.isDefault) ?? decks[0]!).id); }, [decks, deckId]);
  useEffect(() => () => transportRef.current?.close(), []);

  const myDeck = (): Deck | undefined => decks.find((d) => d.id === deckId);
  const rerender = () => setTick((t) => t + 1);

  function startGameHandshake(t: WebRtcTransport, role: "host" | "follower") {
    // Handshake: follower announces its deck; host builds the shared base and
    // sends it; both then run the host-authoritative NetGame.
    t.onReceive((msg) => {
      if (role === "host" && msg.t === "HELLO" && index && !gameRef.current) {
        const mine = myDeck();
        if (!mine) return;
        const base = createGame({
          id: crypto.randomUUID(),
          seed: `${Date.now()}-${Math.random()}`,
          lookup: (id) => index.get(id),
          players: {
            1: { name: mine.name, deck: mine.cards.flatMap((c) => Array<string>(c.count).fill(c.id)) },
            2: { name: msg.name, deck: msg.deck },
          },
        });
        gameRef.current = new NetGame(t, "host", base, rerender);
        t.send({ t: "INIT", baseSnapshot: base });
        setPhase("connected");
        rerender();
      } else if (role === "follower" && msg.t === "INIT" && !gameRef.current) {
        gameRef.current = new NetGame(t, "follower", msg.baseSnapshot, rerender);
        setPhase("connected");
        rerender();
      }
    });
    t.onOpen(() => {
      setStatus("Connected!");
      if (role === "follower") {
        const mine = myDeck();
        if (mine) t.send({ t: "HELLO", name: mine.name, deck: mine.cards.flatMap((c) => Array<string>(c.count).fill(c.id)) });
      }
    });
  }

  async function hostCreate() {
    try {
      const t = new WebRtcTransport("host");
      transportRef.current = t;
      startGameHandshake(t, "host");
      setPhase("host");
      setStatus("Generating invite…");
      setMyCode(await t.createOffer());
      setStatus("Share the code, then paste their reply.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "WebRTC unavailable");
      setPhase("error");
    }
  }

  async function hostAcceptAnswer() {
    await transportRef.current?.acceptAnswer(peerCode.trim());
    setStatus("Connecting…");
  }

  async function joinAcceptOffer() {
    try {
      const t = new WebRtcTransport("follower");
      transportRef.current = t;
      startGameHandshake(t, "follower");
      setMyCode(await t.acceptOffer(peerCode.trim()));
      setStatus("Share your reply with the host.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "WebRTC unavailable");
      setPhase("error");
    }
  }

  if (loaded && decks.length === 0) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-slate-400">Create a deck first to play online.</p>
        <button onClick={() => navigate("/decks")} className="min-h-tap rounded-xl bg-ink-sapphire px-4 font-semibold text-white">Go to Decks</button>
      </div>
    );
  }

  if (phase === "connected" && gameRef.current && index) {
    return <NetBoard game={gameRef.current} viewer={gameRef.current.role === "host" ? 1 : 2} onLeave={() => { transportRef.current?.close(); navigate("/play"); }} />;
  }

  const DeckPicker = (
    <select value={deckId} onChange={(e) => setDeckId(e.target.value)} className="min-h-tap w-full rounded-lg bg-white/5 px-3 text-slate-100 ring-1 ring-white/10">
      {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Local Play (WebRTC)</h1>
      <p className="text-xs text-slate-400">Pair two devices on the same Wi-Fi/hotspot. Share codes by QR or copy/paste.</p>
      {DeckPicker}
      {status && <p className="text-xs text-emerald-300">{status}</p>}

      {phase === "menu" && (
        <div className="flex gap-2">
          <button onClick={hostCreate} className="min-h-tap flex-1 rounded-xl bg-ink-sapphire font-semibold text-white">Host game</button>
          <button onClick={() => { setPhase("join"); setStatus("Paste the host's invite code."); }} className="min-h-tap flex-1 rounded-xl bg-white/10 font-semibold text-white">Join game</button>
        </div>
      )}

      {phase === "host" && (
        <div className="space-y-3">
          <CodeBlock label="1. Your invite (show/scan or copy)" code={myCode} />
          <PasteBlock label="2. Paste their reply" value={peerCode} onChange={setPeerCode} onSubmit={hostAcceptAnswer} cta="Connect" />
        </div>
      )}

      {phase === "join" && (
        <div className="space-y-3">
          <PasteBlock label="1. Paste host's invite" value={peerCode} onChange={setPeerCode} onSubmit={joinAcceptOffer} cta="Generate reply" />
          {myCode && <CodeBlock label="2. Send this reply back to the host" code={myCode} />}
        </div>
      )}

      {phase === "error" && <p className="text-sm text-rose-300">{status}</p>}

      <button onClick={() => navigate("/play")} className="text-xs text-slate-500 underline">Back</button>
    </div>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-300">{label}</p>
      {code && <div className="flex justify-center"><QrCode value={code} /></div>}
      <div className="flex gap-2">
        <input readOnly value={code} className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-[10px] text-slate-400 ring-1 ring-white/10" />
        <button onClick={() => navigator.clipboard?.writeText(code)} className="rounded bg-white/10 px-2 text-xs">Copy</button>
      </div>
    </div>
  );
}

function PasteBlock({ label, value, onChange, onSubmit, cta }: { label: string; value: string; onChange: (v: string) => void; onSubmit: () => void; cta: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-300">{label}</p>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} className="w-full rounded bg-white/5 p-2 font-mono text-[10px] text-slate-100 ring-1 ring-white/10" />
      <button onClick={onSubmit} disabled={!value.trim()} className="min-h-tap w-full rounded-lg bg-ink-sapphire font-semibold text-white disabled:opacity-40">{cta}</button>
    </div>
  );
}

/* --------------------- minimal networked board --------------------- */

function NetBoard({ game, viewer, onLeave }: { game: NetGame; viewer: PlayerId; onLeave: () => void }) {
  const index = useCardDb();
  const [sel, setSel] = useState<string | null>(null);
  const [attacker, setAttacker] = useState<string | null>(null);
  const s = game.state;
  const opp: PlayerId = viewer === 1 ? 2 : 1;
  const me = s.players[viewer];
  const them = s.players[opp];
  const myTurn = s.currentPlayer === viewer && s.status === "playing";
  if (!index) return <p className="text-slate-400">Loading…</p>;

  const act = (a: Parameters<NetGame["localAction"]>[0]) => game.localAction(a);

  if (s.status === "coin_toss") {
    return (
      <div className="mx-auto max-w-md space-y-3 text-center">
        <p className="text-slate-200">{s.players[s.coinToss!.winner].name} won the toss.</p>
        {s.coinToss!.winner === viewer ? (
          <div className="flex gap-2">{([1, 2] as PlayerId[]).map((p) => <button key={p} onClick={() => act({ type: "CHOOSE_STARTING_PLAYER", player: p })} className="min-h-tap flex-1 rounded-xl bg-white/10 font-semibold text-white">{s.players[p].name} first</button>)}</div>
        ) : <p className="text-sm text-slate-400">Waiting for them to choose…</p>}
      </div>
    );
  }

  if (s.status === "mulligan") {
    const done = s.mulliganState!.done[viewer];
    return (
      <div className="space-y-2">
        {done ? <p className="text-sm text-slate-400">Waiting for opponent…</p> : <MulliganPick cards={me.hand.map((c) => c.instanceId)} render={(id) => { const c = me.hand.find((x) => x.instanceId === id)!; return <CardThumb card={c.printed} />; }} onSubmit={(ids) => act({ type: "MULLIGAN", player: viewer, cardInstanceIds: ids })} />}
      </div>
    );
  }

  if (s.status === "finished") {
    return (
      <div className="mx-auto max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-bold text-emerald-300">{s.winner === viewer ? "You win!" : "You lose"}</h1>
        <p className="text-sm text-slate-400">By {s.victoryReason}.</p>
        <button onClick={onLeave} className="min-h-tap w-full rounded-xl bg-ink-sapphire font-semibold text-white">Leave</button>
      </div>
    );
  }

  const selChar = me.field.find((c) => c.instanceId === sel);
  return (
    <div className="flex h-full flex-col gap-2 text-sm">
      <div className="rounded bg-white/5 px-2 py-1 text-xs">{them.name} — ◊{them.lore} ✋{them.hand.length} 🂠{them.deck.length}</div>
      <Row cards={them.field.map((c) => c.printed)} onTap={(i) => { if (attacker) { act({ type: "ATTACK", attackerId: attacker, defenderId: them.field[i]!.instanceId }); setAttacker(null); } }} />
      <div className="mt-auto text-center text-xs text-amber-200">{myTurn ? (attacker ? "Tap an enemy to challenge" : "Your turn") : "Opponent's turn"}</div>
      <Row
        cards={me.field.map((c) => c.printed)}
        highlight={me.field.findIndex((c) => c.instanceId === (attacker ?? sel))}
        onTap={(i) => { if (!myTurn) return; const c = me.field[i]!; setAttacker(null); setSel((x) => (x === c.instanceId ? null : c.instanceId)); }}
      />
      {selChar && myTurn && (
        <div className="flex gap-1">
          <button disabled={selChar.exerted || selChar.justPlayed} onClick={() => { act({ type: "QUEST", cardInstanceId: selChar.instanceId }); setSel(null); }} className="min-h-tap flex-1 rounded bg-white/10 text-xs disabled:opacity-30">Quest</button>
          <button disabled={selChar.exerted || (selChar.justPlayed && !hasKeyword(selChar, "Rush"))} onClick={() => { setAttacker(selChar.instanceId); setSel(null); }} className="min-h-tap flex-1 rounded bg-amber-500/30 text-xs text-amber-100 disabled:opacity-30">Challenge</button>
        </div>
      )}
      <div className="rounded bg-white/5 px-2 py-1 text-xs text-ink-sapphire">{me.name} (you) — ◊{me.lore} 💧{me.inkwell.filter((c) => !c.exerted).length}/{me.inkwell.length} 🂠{me.deck.length}</div>
      <div className="flex items-end gap-1 overflow-x-auto rounded bg-white/5 p-1">
        {me.hand.map((c) => (
          <div key={c.instanceId} className="shrink-0">
            <button onClick={() => setSel((x) => (x === c.instanceId ? null : c.instanceId))} className={cn("block w-14 rounded", sel === c.instanceId && "ring-2 ring-ink-sapphire")}><CardThumb card={c.printed} /></button>
            {sel === c.instanceId && myTurn && (
              <div className="mt-0.5 flex gap-0.5">
                <button disabled={s.hasInkedThisTurn || !c.printed.inkable} onClick={() => { act({ type: "ADD_TO_INK", cardInstanceId: c.instanceId }); setSel(null); }} className="flex-1 rounded bg-white/10 text-[10px] disabled:opacity-30">Ink</button>
                <button disabled={me.inkwell.filter((k) => !k.exerted).length < c.printed.cost} onClick={() => { act({ type: "PLAY_CARD", cardInstanceId: c.instanceId }); setSel(null); }} className="flex-1 rounded bg-ink-sapphire text-[10px] text-white disabled:opacity-30">Play {c.printed.cost}</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        <button disabled={!myTurn} onClick={() => act({ type: "END_TURN" })} className="min-h-tap flex-[2] rounded bg-ink-sapphire text-xs font-semibold text-white disabled:opacity-40">End turn</button>
        <button onClick={() => act({ type: "GAME_FINISH", winner: opp, reason: "concession" })} className="min-h-tap flex-1 rounded bg-rose-500/20 text-xs text-rose-200">Concede</button>
        <button onClick={onLeave} className="min-h-tap flex-1 rounded bg-white/10 text-xs">Leave</button>
      </div>
    </div>
  );
}

function Row({ cards, onTap, highlight }: { cards: PrintedCard[]; onTap: (i: number) => void; highlight?: number }) {
  return (
    <div className="flex min-h-[60px] items-center gap-1 overflow-x-auto rounded bg-white/5 p-1">
      {cards.length === 0 && <span className="px-2 text-[10px] text-slate-500">empty</span>}
      {cards.map((c, i) => (
        <button key={i} onClick={() => onTap(i)} className={cn("w-14 shrink-0 rounded", highlight === i && "ring-2 ring-amber-300")}>
          <CardThumb card={c} />
        </button>
      ))}
    </div>
  );
}

function MulliganPick({ cards, render, onSubmit }: { cards: string[]; render: (id: string) => ReactNode; onSubmit: (ids: string[]) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-300">Tap cards to bottom, then confirm. ({sel.size})</p>
      <div className="grid grid-cols-4 gap-2 landscape:grid-cols-7">
        {cards.map((id) => (
          <button key={id} onClick={() => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })} className={cn("rounded", sel.has(id) && "ring-2 ring-rose-400 brightness-50")}>{render(id)}</button>
        ))}
      </div>
      <button onClick={() => onSubmit([...sel])} className="min-h-tap w-full rounded-xl bg-ink-sapphire font-semibold text-white">{sel.size === 0 ? "Keep all 7" : `Bottom ${sel.size} & redraw`}</button>
    </div>
  );
}
