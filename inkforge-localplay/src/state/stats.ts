/**
 * Stats derivation (spec §10.2) — pure functions over stored replays. In local
 * hot-seat both decks are local, so stats are deck-centric: a deck's record is
 * computed from every game it appears in, split by on-the-play / on-the-draw.
 */
import type { StoredReplay } from "./db";
import type { PlayerId } from "@/engine/state";

export interface DeckRecord {
  deckId: string;
  played: number;
  wins: number;
  winPct: number;
  otpPlayed: number;
  otpWins: number;
  otdPlayed: number;
  otdWins: number;
}

function pct(w: number, n: number): number {
  return n > 0 ? Math.round((w / n) * 100) : 0;
}

export function deckRecord(replays: StoredReplay[], deckId: string): DeckRecord {
  let played = 0, wins = 0, otpPlayed = 0, otpWins = 0, otdPlayed = 0, otdWins = 0;
  for (const r of replays) {
    const sides: PlayerId[] = [];
    if (r.deck1Id === deckId) sides.push(1);
    if (r.deck2Id === deckId) sides.push(2);
    for (const pid of sides) {
      played += 1;
      const won = r.winner === pid;
      const onPlay = r.firstPlayer === pid;
      if (won) wins += 1;
      if (onPlay) {
        otpPlayed += 1;
        if (won) otpWins += 1;
      } else {
        otdPlayed += 1;
        if (won) otdWins += 1;
      }
    }
  }
  return { deckId, played, wins, winPct: pct(wins, played), otpPlayed, otpWins, otdPlayed, otdWins };
}

export function winPct(w: number, n: number): number {
  return pct(w, n);
}
