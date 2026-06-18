import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";
import { useCardDb } from "@/ui/hooks/useCardDb";
import { CardThumb } from "@/ui/components/CardThumb";
import {
  HostTransport,
  WsClientTransport,
  LocalNet,
  localPlaySupported,
  subscribeNativeLog,
  type DiscoveredPeer,
} from "@/net/localnet";
import { netLog, nlog, formatNetLog, type NetLogEntry } from "@/net/netlog";
import { NetGame } from "@/net/netgame";
import { createGame } from "@/engine/actions";
import { hasKeyword, keywordValue } from "@/engine/keywords";
import { InkPool, ItemRow, activatedAbility } from "@/ui/components/BoardZones";
import { cn } from "@/lib/cn";
import type { Deck } from "@/data/deck-types";
import type { CardInstance, GameState, PlayerId } from "@/engine/state";
import type { PluginListenerHandle } from "@capacitor/core";

type Phase = "menu" | "hosting" | "joining" | "connecting" | "connected" | "error";

const flatten = (d: Deck): string[] => d.cards.flatMap((c) => Array<string>(c.count).fill(c.id));

/**
 * Local PvP over the shared network (spec §8, revised): host advertises, join
 * discovers and connects — no codes. Requires the native build (LocalNet).
 */
export function LocalPlayScreen() {
  const navigate = useNavigate();
  const index = useCardDb();
  const { decks, loaded, load } = useDecks();
  const [phase, setPhase] = useState<Phase>("menu");
  const [deckId, setDeckId] = useState("");
  const [status, setStatus] = useState("");
  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const [, setTick] = useState(0);
  const [hostInfo, setHostInfo] = useState<{ port: number; addresses?: string[] } | null>(null);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("");

  const transportRef = useRef<HostTransport | WsClientTransport | null>(null);
  const gameRef = useRef<NetGame | null>(null);
  const discHandles = useRef<PluginListenerHandle[]>([]);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => { if (decks.length && !deckId) setDeckId((decks.find((d) => d.isDefault) ?? decks[0]!).id); }, [decks, deckId]);
  useEffect(() => {
    let unsub = () => {};
    void subscribeNativeLog().then((fn) => { unsub = fn; });
    return () => { unsub(); cleanup(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const myDeck = (): Deck | undefined => decks.find((d) => d.id === deckId);
  const rerender = () => setTick((t) => t + 1);

  function cleanup() {
    discHandles.current.forEach((h) => void h.remove());
    discHandles.current = [];
    void LocalNet.stopDiscovery().catch(() => {});
    transportRef.current?.close();
    transportRef.current = null;
    gameRef.current = null;
  }

  /** Host: build the shared base on HELLO, start the NetGame, send INIT. */
  function wireHost(t: HostTransport) {
    t.onReceive((msg) => {
      if (msg.t !== "HELLO") return;
      if (gameRef.current) { nlog("host", "ignoring duplicate HELLO (game already started)", "warn"); return; }
      if (!index) { nlog("host", "received HELLO but card DB not ready yet", "error"); return; }
      const mine = myDeck();
      if (!mine) { nlog("host", "received HELLO but no host deck selected", "error"); return; }
      nlog("host", `received HELLO from "${msg.name}" (${msg.deck.length}-card deck) — building game, sending INIT`);
      const base = createGame({
        id: crypto.randomUUID(),
        seed: `${Date.now()}-${Math.random()}`,
        lookup: (id) => index.get(id),
        players: {
          1: { name: mine.name, deck: flatten(mine) },
          2: { name: msg.name, deck: msg.deck },
        },
      });
      gameRef.current = new NetGame(t, "host", base, rerender);
      t.send({ t: "INIT", baseSnapshot: base });
      nlog("host", "game started — both players connected");
      setPhase("connected");
      rerender();
    });
  }

  function wireFollower(t: WsClientTransport) {
    t.onReceive((msg) => {
      if (msg.t === "INIT" && !gameRef.current) {
        nlog("follower", "received INIT — game starting");
        gameRef.current = new NetGame(t, "follower", msg.baseSnapshot, rerender);
        setPhase("connected");
        rerender();
      }
    });
    t.onOpen(() => {
      const mine = myDeck();
      if (mine) { nlog("follower", `socket open — sending HELLO ("${mine.name}", ${flatten(mine).length} cards)`); t.send({ t: "HELLO", name: mine.name, deck: flatten(mine) }); }
      else nlog("follower", "socket open but no deck selected — cannot send HELLO", "error");
      setStatus("Connected — syncing…");
    });
  }

  async function host() {
    const mine = myDeck();
    if (!mine) return;
    try {
      setPhase("hosting");
      setStatus("Starting host…");
      const t = new HostTransport();
      transportRef.current = t;
      wireHost(t);
      t.onOpen(() => setStatus("Opponent connected — syncing…"));
      const info = await t.start(mine.name);
      setHostInfo(info);
      setStatus(`Hosting as "${mine.name}" — waiting for a player to join…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Host failed");
      setPhase("error");
    }
  }

  async function join() {
    try {
      setPhase("joining");
      setStatus("Searching for games on this network…");
      setPeers([]);
      discHandles.current.push(
        await LocalNet.addListener("peerFound", (p) => setPeers((prev) => (prev.some((x) => x.name === p.name) ? prev : [...prev, p]))),
        await LocalNet.addListener("peerLost", (p) => setPeers((prev) => prev.filter((x) => x.name !== p.name))),
      );
      await LocalNet.startDiscovery();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Discovery failed");
      setPhase("error");
    }
  }

  function connectTo(peer: DiscoveredPeer) {
    setPhase("connecting");
    setStatus(`Connecting to ${peer.name} (${peer.host}:${peer.port})…`);
    nlog("follower", `connecting to "${peer.name}" at ${peer.host}:${peer.port}`);
    void LocalNet.stopDiscovery().catch(() => {});
    const t = new WsClientTransport(peer);
    transportRef.current = t;
    wireFollower(t);
    // Allow ~4s per candidate address (multi-homed hosts) before giving up.
    const cap = Math.max(10000, ([peer.host, ...(peer.addresses ?? [])].length) * 4500 + 2000);
    setTimeout(() => {
      if (!gameRef.current) {
        nlog("follower", `timed out after ${Math.round(cap / 1000)}s (socket state: ${t.status}). If no address ever opened, the devices can't reach each other — likely hotspot "client isolation". Try a normal WiFi router.`, "error");
        t.close();
        transportRef.current = null;
        setStatus(`Couldn't reach ${peer.name}. If this keeps happening on a phone hotspot, it's likely "client isolation" — try a normal WiFi router, or Connect by IP.`);
        setPhase("joining");
      }
    }, cap);
  }

  if (loaded && decks.length === 0) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm text-slate-400">Create a deck first to play.</p>
        <button onClick={() => navigate("/decks")} className="min-h-tap rounded-xl bg-ink-sapphire px-4 font-semibold text-white">Go to Decks</button>
      </div>
    );
  }

  if (!localPlaySupported()) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <h1 className="text-lg font-semibold text-slate-100">Local Play</h1>
        <p className="text-sm text-amber-200">Network play needs the installed Android app (it uses on-device discovery). Open this in the APK build.</p>
        <button onClick={() => navigate("/play")} className="text-xs text-slate-500 underline">Back</button>
      </div>
    );
  }

  if (phase === "connected" && gameRef.current && index) {
    return <NetBoard game={gameRef.current} viewer={gameRef.current.role === "host" ? 1 : 2} onLeave={() => { cleanup(); navigate("/play"); }} />;
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-lg font-semibold text-slate-100">Local Play</h1>
      <p className="text-xs text-slate-400">Both devices on the same WiFi or hotspot. One hosts, the other joins — no codes.</p>

      <label className="block">
        <span className="mb-1 block text-xs text-slate-400">Your deck</span>
        <select value={deckId} onChange={(e) => setDeckId(e.target.value)} className="min-h-tap w-full rounded-lg bg-white/5 px-3 text-slate-100 ring-1 ring-white/10">
          {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>

      {status && <p className="text-xs text-emerald-300">{status}</p>}

      {phase === "menu" && (
        <div className="flex gap-2">
          <button onClick={host} className="min-h-tap flex-1 rounded-xl bg-ink-sapphire font-semibold text-white">Host game</button>
          <button onClick={join} className="min-h-tap flex-1 rounded-xl bg-white/10 font-semibold text-white">Join game</button>
        </div>
      )}

      {phase === "hosting" && (
        <div className="space-y-2 text-sm text-slate-300">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 animate-pulse rounded-full bg-emerald-400" /> Waiting for a player…
          </div>
          {hostInfo && (hostInfo.addresses?.length ?? 0) > 0 && (
            <p className="text-xs text-slate-400">
              If they can't see it (e.g. Bluetooth), have them use <strong>Connect by IP</strong>:
              <br />
              {hostInfo.addresses!.map((a) => (
                <span key={a} className="font-mono text-slate-200">{a}:{hostInfo.port} </span>
              ))}
            </p>
          )}
        </div>
      )}

      {(phase === "joining" || phase === "connecting") && (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">Hosting games found:</p>
          {peers.length === 0 && <p className="text-xs text-slate-500">Searching… make sure the other device tapped “Host”.</p>}
          <ul className="space-y-1">
            {peers.map((p) => (
              <li key={p.name}>
                <button onClick={() => connectTo(p)} className="min-h-tap w-full rounded-lg border border-white/10 bg-white/5 p-3 text-left font-semibold text-slate-100 active:bg-white/10">
                  {p.name} <span className="text-xs text-slate-500">({p.host})</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="space-y-1 rounded-lg border border-white/10 p-2">
            <p className="text-xs text-slate-400">Connect by IP (for Bluetooth, or if it isn't listed):</p>
            <div className="flex gap-1">
              <input value={manualHost} onChange={(e) => setManualHost(e.target.value)} placeholder="192.168.x.x" className="min-w-0 flex-1 rounded bg-white/5 px-2 py-1 text-sm text-slate-100 ring-1 ring-white/10" />
              <input value={manualPort} onChange={(e) => setManualPort(e.target.value)} placeholder="port" inputMode="numeric" className="w-20 rounded bg-white/5 px-2 py-1 text-sm text-slate-100 ring-1 ring-white/10" />
              <button
                disabled={!manualHost.trim() || !manualPort.trim()}
                onClick={() => connectTo({ name: `${manualHost}:${manualPort}`, host: manualHost.trim(), port: Number(manualPort) })}
                className="min-h-tap rounded bg-ink-sapphire px-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === "error" && <p className="text-sm text-rose-300">{status}</p>}

      <ConnLog startOpen={phase !== "menu"} />

      {phase !== "menu" && phase !== "connected" && (
        <button onClick={() => { cleanup(); setPhase("menu"); setStatus(""); }} className="text-xs text-slate-500 underline">Cancel</button>
      )}
      <button onClick={() => navigate("/play")} className="block text-xs text-slate-500 underline">Back</button>
    </div>
  );
}

/* --------------------- minimal networked board --------------------- */

function NetBoard({ game, viewer, onLeave }: { game: NetGame; viewer: PlayerId; onLeave: () => void }) {
  const index = useCardDb();
  const [sel, setSel] = useState<string | null>(null);
  const [selField, setSelField] = useState<string | null>(null);
  const [selItem, setSelItem] = useState<string | null>(null);
  const [attacker, setAttacker] = useState<string | null>(null);
  const [manualSel, setManualSel] = useState<string | null>(null);
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

  const readyInk = me.inkwell.filter((c) => !c.exerted).length;
  const selChar = me.field.find((c) => c.instanceId === selField);
  const charAbility = selChar ? activatedAbility(selChar) : undefined;
  const selectedItem = me.items.find((c) => c.instanceId === selItem);
  const itemAbility = selectedItem ? activatedAbility(selectedItem) : undefined;
  const prompt = s.pendingPrompts[0] ?? null;
  const myPrompt = !!prompt && prompt.player === viewer;

  // Route a board tap to my pending prompt (target choice or manual selection).
  function promptTap(id: string): boolean {
    if (!myPrompt || !prompt) return false;
    if (prompt.resume) act({ type: "RESPOND_TO_PROMPT", promptId: prompt.id, targetInstanceId: id });
    else setManualSel(id);
    return true;
  }

  const greedySingers = (cost: number): string[] => {
    const ids: string[] = []; let value = 0;
    for (const c of me.field) {
      if (c.printed.type !== "character" || c.exerted) continue;
      value += Math.max(c.printed.cost, keywordValue(c, "Singer"));
      ids.push(c.instanceId);
      if (value >= cost) return ids;
    }
    return value >= cost ? ids : [];
  };

  return (
    <div className="flex h-full flex-col gap-2 text-sm">
      <div className="rounded bg-white/5 px-2 py-1 text-xs">{them.name} — ◊{them.lore} ✋{them.hand.length} 🂠{them.deck.length}</div>
      {/* Opponent: board → items → inkwell (nearest the centre). */}
      <NetField cards={them.field} enemy targeting={!!attacker || myPrompt} onTap={(c) => { if (promptTap(c.instanceId)) return; if (attacker) { act({ type: "ATTACK", attackerId: attacker, defenderId: c.instanceId }); setAttacker(null); } }} />
      <ItemRow items={them.items} enemy onItemTap={(c) => promptTap(c.instanceId)} />
      <InkPool player={them} />

      <div className="flex-1" />

      {/* Me: board → items → inkwell. */}
      <NetField
        cards={me.field}
        selectedId={attacker ?? selField}
        onTap={(c) => {
          if (promptTap(c.instanceId)) return;
          if (attacker) { setAttacker(null); return; }
          if (!myTurn) return;
          setSel(null); setSelItem(null);
          setSelField((x) => (x === c.instanceId ? null : c.instanceId));
        }}
      />
      <ItemRow
        items={me.items}
        selectedId={selItem}
        onItemTap={(c) => { if (promptTap(c.instanceId)) return; if (!myTurn) return; setSelField(null); setSelItem((x) => (x === c.instanceId ? null : c.instanceId)); }}
      />
      <InkPool player={me} mine />

      {prompt && <NetPrompt state={s} prompt={prompt} mine={myPrompt} manualSel={manualSel} dispatch={act} onClearManualSel={() => setManualSel(null)} />}

      {!prompt && selChar && myTurn && (
        <div className="flex gap-1">
          <button disabled={selChar.exerted || selChar.justPlayed} onClick={() => { act({ type: "QUEST", cardInstanceId: selChar.instanceId }); setSelField(null); }} className="min-h-tap flex-1 rounded bg-white/10 text-xs disabled:opacity-30">Quest</button>
          <button disabled={selChar.exerted || (selChar.justPlayed && !hasKeyword(selChar, "Rush"))} onClick={() => { setAttacker(selChar.instanceId); setSelField(null); }} className="min-h-tap flex-1 rounded bg-amber-500/30 text-xs text-amber-100 disabled:opacity-30">Challenge</button>
          {charAbility && <button onClick={() => { act({ type: "ACTIVATE_ABILITY", cardInstanceId: selChar.instanceId, slug: charAbility.slug }); setSelField(null); }} className="min-h-tap flex-1 rounded bg-ink-amethyst/40 text-xs text-violet-100" title={charAbility.effect}>⚡ {charAbility.name}</button>}
        </div>
      )}
      {!prompt && selectedItem && itemAbility && myTurn && (
        <button onClick={() => { act({ type: "ACTIVATE_ABILITY", cardInstanceId: selectedItem.instanceId, slug: itemAbility.slug }); setSelItem(null); }} className="min-h-tap w-full rounded bg-ink-amethyst/40 text-xs text-violet-100" title={itemAbility.effect}>⚡ {itemAbility.name} — {itemAbility.effect}</button>
      )}

      <div className="rounded bg-white/5 px-2 py-1 text-xs text-ink-sapphire">{me.name} (you) — ◊{me.lore} 💧{readyInk}/{me.inkwell.length} 🂠{me.deck.length}</div>
      {attacker && <p className="text-center text-xs text-amber-200">Tap an enemy character to challenge, or tap your attacker again to cancel.</p>}

      <div className="flex items-end gap-1 overflow-x-auto rounded bg-white/5 p-1">
        {me.hand.map((c) => {
          const shiftCost = keywordValue(c, "Shift");
          const shiftBase = shiftCost > 0 ? me.field.find((f) => f.printed.type === "character" && f.printed.name === c.printed.name) : undefined;
          const singers = c.printed.type === "song" ? greedySingers(c.printed.cost) : [];
          return (
            <div key={c.instanceId} className="shrink-0">
              <button
                onClick={() => { setSelField(null); setSelItem(null); setSel((x) => (x === c.instanceId ? null : c.instanceId)); }}
                className={cn("block w-14 rounded", sel === c.instanceId && "ring-2 ring-ink-sapphire")}
              ><CardThumb card={c.printed} /></button>
              {sel === c.instanceId && myTurn && !prompt && (
                <div className="mt-0.5 flex flex-wrap gap-0.5">
                  <button disabled={s.hasInkedThisTurn || !c.printed.inkable} onClick={() => { act({ type: "ADD_TO_INK", cardInstanceId: c.instanceId }); setSel(null); }} className="flex-1 rounded bg-white/10 text-[10px] disabled:opacity-30">Ink</button>
                  <button disabled={readyInk < c.printed.cost} onClick={() => { act({ type: "PLAY_CARD", cardInstanceId: c.instanceId }); setSel(null); }} className="flex-1 rounded bg-ink-sapphire text-[10px] text-white disabled:opacity-30">Play {c.printed.cost}</button>
                  {shiftBase && readyInk >= shiftCost && <button onClick={() => { act({ type: "PLAY_CARD", cardInstanceId: c.instanceId, shiftOnto: shiftBase.instanceId }); setSel(null); }} className="flex-1 rounded bg-ink-amethyst/70 text-[10px] text-white">Shift {shiftCost}</button>}
                  {singers.length > 0 && <button onClick={() => { act({ type: "PLAY_CARD", cardInstanceId: c.instanceId, singers }); setSel(null); }} className="flex-1 rounded bg-ink-emerald/70 text-[10px] text-white">Sing</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ConnLog />
      <div className="flex gap-1">
        <button disabled={!myTurn || !!prompt} onClick={() => act({ type: "END_TURN" })} className="min-h-tap flex-[2] rounded bg-ink-sapphire text-xs font-semibold text-white disabled:opacity-40">End turn</button>
        <button onClick={() => act({ type: "GAME_FINISH", winner: opp, reason: "concession" })} className="min-h-tap flex-1 rounded bg-rose-500/20 text-xs text-rose-200">Concede</button>
        <button onClick={onLeave} className="min-h-tap flex-1 rounded bg-white/10 text-xs">Leave</button>
      </div>
    </div>
  );
}

/** Instance-aware field row with damage badge + exert/drying styling. */
function NetField({ cards, enemy, selectedId, targeting, onTap }: { cards: CardInstance[]; enemy?: boolean; selectedId?: string | null; targeting?: boolean; onTap: (c: CardInstance) => void }) {
  return (
    <div className={cn("flex min-h-[60px] items-center gap-1 overflow-x-auto rounded p-1", enemy ? "bg-rose-500/5" : "bg-emerald-500/5")}>
      {cards.length === 0 && <span className="px-2 text-[10px] text-slate-500">{enemy ? "No enemy characters" : "Your field is empty"}</span>}
      {cards.map((c) => (
        <button
          key={c.instanceId}
          onClick={() => onTap(c)}
          className={cn(
            "relative w-14 shrink-0 rounded transition",
            c.exerted && "rotate-6 opacity-80",
            c.justPlayed && "brightness-75",
            selectedId === c.instanceId && "ring-2 ring-amber-300",
            targeting && enemy && "ring-1 ring-rose-300",
          )}
        >
          <CardThumb card={c.printed} />
          {c.damage > 0 && <span className="absolute right-0 top-0 rounded-bl bg-rose-600 px-1 text-[10px] font-bold text-white">{c.damage}</span>}
        </button>
      ))}
    </div>
  );
}

/** Pending-ability resolver for networked play (mirrors the hot-seat PromptBar). */
function NetPrompt({ state, prompt, mine, manualSel, dispatch, onClearManualSel }: {
  state: GameState;
  prompt: NonNullable<GameState["pendingPrompts"][number]>;
  mine: boolean;
  manualSel: string | null;
  dispatch: (a: Parameters<NetGame["localAction"]>[0]) => void;
  onClearManualSel: () => void;
}) {
  const meP = state.players[prompt.player];
  const onBoard = [...state.players[1].field, ...state.players[2].field, ...state.players[1].items, ...state.players[2].items];
  const card = manualSel ? onBoard.find((c) => c.instanceId === manualSel) : null;
  // The card that triggered the prompt (incl. an action now in discard), so
  // both players can see what was played.
  const sourceCard = prompt.sourceInstanceId
    ? [...onBoard, ...state.players[1].discard, ...state.players[2].discard].find((c) => c.instanceId === prompt.sourceInstanceId)
    : undefined;
  const head = (
    <div className="flex items-start gap-2">
      {sourceCard && <div className="w-12 shrink-0"><CardThumb card={sourceCard.printed} /></div>}
      <p className="text-amber-50">{prompt.text}</p>
    </div>
  );
  if (!mine) {
    return <div className="space-y-1 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-100"><p className="font-semibold">{state.players[prompt.player].name} is resolving:</p>{head}</div>;
  }
  const setLore = (value: number) => dispatch({ type: "MANUAL_ADJUST", ops: [{ kind: "setLore", player: prompt.player, value }] });
  const setDamage = (id: string, value: number) => dispatch({ type: "MANUAL_ADJUST", ops: [{ kind: "setDamage", instanceId: id, value }] });
  return (
    <div className="space-y-2 rounded-lg bg-amber-500/15 p-2 text-xs">
      <p className="font-semibold text-amber-100">Resolve ability:</p>
      {head}
      {prompt.pick === "deck" ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-amber-200">Tap a card to keep it in your hand:</p>
            <button onClick={() => dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id })} className="rounded bg-white/10 px-2 py-1">Done</button>
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {(prompt.reveal ?? []).map((id) => {
              const c = state.players[prompt.player].deck.find((x) => x.instanceId === id);
              return c ? (
                <button key={id} onClick={() => dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id, targetInstanceId: id })} className="w-14 shrink-0 rounded ring-1 ring-white/10 active:ring-2 active:ring-ink-sapphire">
                  <CardThumb card={c.printed} />
                </button>
              ) : null;
            })}
          </div>
        </div>
      ) : prompt.pick === "hand" ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-amber-200">{(prompt.handOwner ?? prompt.player) === prompt.player ? "Tap a card from your hand:" : "Tap a card from their hand:"}</p>
            <button onClick={() => dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id })} className="rounded bg-white/10 px-2 py-1">Skip</button>
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {state.players[prompt.handOwner ?? prompt.player].hand.map((c) => (
              <button key={c.instanceId} onClick={() => dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id, targetInstanceId: c.instanceId })} className="w-14 shrink-0 rounded ring-1 ring-white/10 active:ring-2 active:ring-ink-sapphire">
                <CardThumb card={c.printed} />
              </button>
            ))}
          </div>
        </div>
      ) : prompt.pick === "confirm" ? (
        <div className="flex items-center gap-2">
          <button onClick={() => dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id, targetInstanceId: "__confirm__" })} className="flex-1 rounded bg-ink-sapphire px-2 py-1 font-semibold text-white">Yes</button>
          <button onClick={() => dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id })} className="flex-1 rounded bg-white/10 px-2 py-1">No</button>
        </div>
      ) : prompt.resume ? (
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
            </div>
          )}
          <p className="text-[10px] text-amber-200">Tap a card to adjust it.</p>
          <button onClick={() => { dispatch({ type: "RESPOND_TO_PROMPT", promptId: prompt.id }); onClearManualSel(); }} className="w-full rounded bg-ink-sapphire px-2 py-1 font-semibold text-white">Done</button>
        </div>
      )}
    </div>
  );
}

/** Live connection diagnostics, readable on each device and copyable to report. */
function ConnLog({ startOpen = false }: { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [entries, setEntries] = useState<readonly NetLogEntry[]>(netLog.list());
  const [copied, setCopied] = useState(false);
  useEffect(() => netLog.subscribe(() => setEntries([...netLog.list()])), []);

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(formatNetLog()); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/30">
      <div className="flex items-center justify-between px-2 py-1">
        <button onClick={() => setOpen((o) => !o)} className="text-xs font-semibold text-slate-300">
          {open ? "▾" : "▸"} Connection log ({entries.length})
        </button>
        <div className="flex gap-2">
          <button onClick={copy} className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-slate-200">{copied ? "Copied!" : "Copy"}</button>
          <button onClick={() => netLog.clear()} className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-slate-200">Clear</button>
        </div>
      </div>
      {open && (
        <div className="max-h-48 overflow-y-auto px-2 pb-2 font-mono text-[10px] leading-snug">
          {entries.length === 0 && <p className="text-slate-500">No events yet. Tap Host or Join.</p>}
          {entries.map((e) => (
            <div key={e.id} className={cn("whitespace-pre-wrap", e.level === "error" ? "text-rose-300" : e.level === "warn" ? "text-amber-300" : "text-slate-300")}>
              <span className="text-slate-500">{fmtTime(e.ts)}</span> <span className="text-slate-500">[{e.side}]</span> {e.msg}
            </div>
          ))}
        </div>
      )}
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
