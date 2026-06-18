import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { db, type StoredReplay } from "@/state/db";
import { foldFrames } from "@/engine/replay";
import type { GameState, PlayerId } from "@/engine/state";

/** Replay playback (spec §10.1): scrub through frames; render the log stream. */
export function PlaybackScreen() {
  const { replayId } = useParams();
  const navigate = useNavigate();
  const [stored, setStored] = useState<StoredReplay | null>(null);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (replayId) void db.replays.get(replayId).then((r) => { setStored(r ?? null); setFrame(r?.replay.frames.length ?? 0); });
  }, [replayId]);

  const view = useMemo(() => {
    if (!stored) return null;
    const state = foldFrames<GameState>(stored.replay.baseSnapshot, stored.replay.frames, { upTo: frame });
    const logCount = frame > 0 ? stored.replay.frames[frame - 1]!.logCountAfter : 0;
    return { state, logs: stored.replay.logs.slice(0, logCount) };
  }, [stored, frame]);

  if (!stored || !view) return <p className="text-slate-400">Loading replay…</p>;
  const { state, logs } = view;
  const total = stored.replay.frames.length;

  return (
    <div className="flex h-full flex-col gap-2 text-sm">
      <button onClick={() => navigate("/replays")} className="self-start text-xs text-ink-sapphire underline">← Replays</button>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {([1, 2] as PlayerId[]).map((pid) => (
          <div key={pid} className="rounded-lg bg-white/5 p-2">
            <div className="font-semibold text-slate-100">{state.players[pid].name}</div>
            <div className="text-slate-400">◊ {state.players[pid].lore} · field {state.players[pid].field.length} · hand {state.players[pid].hand.length}</div>
          </div>
        ))}
      </div>
      <div className="text-center text-xs text-slate-400">
        Turn {state.turnNumber} · {state.status}{state.winner ? ` · winner: ${state.players[state.winner].name}` : ""}
      </div>

      {/* Scrubber */}
      <div className="flex items-center gap-2">
        <button onClick={() => setFrame((f) => Math.max(0, f - 1))} className="min-h-tap rounded bg-white/10 px-3">◀</button>
        <input type="range" min={0} max={total} value={frame} onChange={(e) => setFrame(Number(e.target.value))} className="flex-1" />
        <button onClick={() => setFrame((f) => Math.min(total, f + 1))} className="min-h-tap rounded bg-white/10 px-3">▶</button>
      </div>
      <div className="text-center text-[10px] text-slate-500">frame {frame} / {total}</div>

      {/* Log stream */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto rounded-lg bg-black/20 p-2 text-[11px] text-slate-300">
        {logs.map((l) => <div key={l.id}>{l.message}</div>)}
      </div>
    </div>
  );
}
