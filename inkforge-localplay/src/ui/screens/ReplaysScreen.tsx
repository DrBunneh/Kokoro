import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db, type StoredReplay } from "@/state/db";
import { parseDuelsFile } from "@/data/import-duels";
import { loadCardDb } from "@/data/cards";
import { INK_HEX } from "@/ui/components/ink";
import type { InkColor } from "@/data/card-types";

/** Replays page (spec §10.1): up to 20 recent games, watch, delete, or import. */
export function ReplaysScreen() {
  const navigate = useNavigate();
  const [replays, setReplays] = useState<StoredReplay[]>([]);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setReplays(await db.replays.orderBy("createdAt").reverse().limit(20).toArray());
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function onFile(file: File) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const index = await loadCardDb().catch(() => undefined);
      const games = parseDuelsFile(buf, file.name, index);
      if (games.length === 0) throw new Error("No games found in file");
      await db.replays.bulkPut(games);
      setImportMsg(`Imported ${games.length} game${games.length > 1 ? "s" : ""}.`);
      void refresh();
    } catch (err) {
      setImportMsg(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Replays</h1>
        <button onClick={() => fileRef.current?.click()} className="min-h-tap rounded-lg bg-white/10 px-3 text-sm">Upload file</button>
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.zip,.json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }}
        />
      </div>
      {importMsg && <p className="text-xs text-emerald-300">{importMsg}</p>}
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
