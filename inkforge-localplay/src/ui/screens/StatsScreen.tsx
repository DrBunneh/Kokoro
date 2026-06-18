import { useEffect, useMemo, useState } from "react";
import { useDecks } from "@/state/useDecks";
import { db, type MulliganResult, type StoredReplay } from "@/state/db";
import { deckRecord, winPct } from "@/state/stats";

/** Stats page (spec §10.2): per-deck record (OTP/OTD) + mulligan keep summary. */
export function StatsScreen() {
  const { decks, loaded, load } = useDecks();
  const [replays, setReplays] = useState<StoredReplay[]>([]);
  const [mulls, setMulls] = useState<MulliganResult[]>([]);
  const [deckId, setDeckId] = useState<string>("");

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  useEffect(() => {
    void db.replays.toArray().then(setReplays);
    void db.mulliganResults.toArray().then(setMulls);
  }, []);
  useEffect(() => { if (!deckId && decks.length) setDeckId(decks.find((d) => d.isDefault)?.id ?? decks[0]!.id); }, [decks, deckId]);

  const rec = useMemo(() => (deckId ? deckRecord(replays, deckId) : null), [replays, deckId]);
  const mull = useMemo(() => {
    const mine = mulls.filter((m) => m.deckId === deckId);
    const otp = mine.filter((m) => m.onThePlay);
    const otd = mine.filter((m) => !m.onThePlay);
    const avg = (xs: MulliganResult[]) => (xs.length ? Math.round((xs.reduce((n, m) => n + m.kept, 0) / xs.length) * 10) / 10 : 0);
    return { otpCount: otp.length, otpAvgKept: avg(otp), otdCount: otd.length, otdAvgKept: avg(otd) };
  }, [mulls, deckId]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Stats</h1>
      <p className="text-xs text-slate-400">Games played: {replays.length}</p>

      <select value={deckId} onChange={(e) => setDeckId(e.target.value)} className="min-h-tap w-full rounded-lg bg-white/5 px-3 text-slate-100 ring-1 ring-white/10">
        {decks.length === 0 && <option value="">No decks</option>}
        {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>

      {rec && (
        <div className="space-y-3">
          <Row label="Games" value={`${rec.played}`} />
          <Row label="Win %" value={`${rec.winPct}% (${rec.wins}/${rec.played})`} />
          <Row label="Win % OTP (on the play)" value={`${winPct(rec.otpWins, rec.otpPlayed)}% (${rec.otpWins}/${rec.otpPlayed})`} />
          <Row label="Win % OTD (on the draw)" value={`${winPct(rec.otdWins, rec.otdPlayed)}% (${rec.otdWins}/${rec.otdPlayed})`} />
          <h2 className="pt-2 text-sm font-semibold text-slate-200">Mulligan</h2>
          <Row label="Kept OTP (samples · avg kept)" value={`${mull.otpCount} · ${mull.otpAvgKept}`} />
          <Row label="Kept OTD (samples · avg kept)" value={`${mull.otdCount} · ${mull.otdAvgKept}`} />
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
      <span className="text-slate-300">{label}</span>
      <span className="font-semibold text-slate-100">{value}</span>
    </div>
  );
}
