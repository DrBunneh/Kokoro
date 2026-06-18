import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db, type StoredReplay } from "@/state/db";
import { INK_HEX } from "@/ui/components/ink";
import type { InkColor } from "@/data/card-types";

/** Replays page (spec §10.1): up to 20 recent games, watch or delete. */
export function ReplaysScreen() {
  const navigate = useNavigate();
  const [replays, setReplays] = useState<StoredReplay[]>([]);

  async function refresh() {
    setReplays(await db.replays.orderBy("createdAt").reverse().limit(20).toArray());
  }
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold text-slate-100">Replays</h1>
      {replays.length === 0 && <p className="pt-6 text-center text-sm text-slate-400">No games recorded yet. Finish a hot-seat game to see it here.</p>}
      <ul className="space-y-2">
        {replays.map((r) => {
          const result = r.winner ? `${r.playerNames[r.winner]} won` : "Draw";
          return (
            <li key={r.id} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-3">
              <button onClick={() => navigate(`/replays/${r.id}`)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-1 truncate font-semibold text-slate-100">
                  <Colors colors={r.deck1Colors as InkColor[]} /> {r.playerNames[1]}
                  <span className="text-slate-500">vs</span>
                  {r.playerNames[2]} <Colors colors={r.deck2Colors as InkColor[]} />
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {result} · {r.victoryReason ?? "—"} · {r.turnCount} turns
                </div>
              </button>
              <button
                onClick={async () => { await db.replays.delete(r.id); void refresh(); }}
                className="min-h-tap rounded-lg bg-rose-500/20 px-3 text-xs text-rose-200"
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Colors({ colors }: { colors: InkColor[] }) {
  return (
    <span className="inline-flex gap-0.5">
      {colors.map((c) => <span key={c} className="inline-block h-3 w-3 rounded-full ring-1 ring-white/30" style={{ background: INK_HEX[c] }} />)}
    </span>
  );
}
