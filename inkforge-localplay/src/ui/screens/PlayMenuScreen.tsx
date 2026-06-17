import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDecks } from "@/state/useDecks";

/** Play menu (spec §11.5): deck dropdown + Mulligan | Local Play | Bot (disabled). */
export function PlayMenuScreen() {
  const navigate = useNavigate();
  const { decks, loaded, load } = useDecks();
  const [deckId, setDeckId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  useEffect(() => {
    if (!deckId && decks.length) setDeckId(decks.find((d) => d.isDefault)?.id ?? decks[0]!.id);
  }, [decks, deckId]);

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-xs text-slate-400">Deck</label>
        <select
          value={deckId ?? ""}
          onChange={(e) => setDeckId(e.target.value)}
          className="min-h-tap w-full rounded-lg bg-white/5 px-3 text-slate-100 ring-1 ring-white/10"
        >
          {decks.length === 0 && <option value="">No decks — create one first</option>}
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        onClick={() => navigate("/play/mulligan")}
        className="min-h-tap w-full rounded-xl bg-ink-sapphire font-semibold text-white"
      >
        Mulligan
      </button>
      <button
        type="button"
        onClick={() => navigate("/play/local")}
        className="min-h-tap w-full rounded-xl bg-white/10 font-semibold text-slate-100"
      >
        Local Play
      </button>
      <button
        type="button"
        disabled
        title="Out of scope"
        className="min-h-tap w-full cursor-not-allowed rounded-xl bg-white/5 font-semibold text-slate-500"
      >
        Bot opponent (coming later)
      </button>
    </div>
  );
}
