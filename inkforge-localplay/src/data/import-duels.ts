/**
 * duels.ink replay importer (spec §11.3, optional). Maps a duels.ink
 * `duels-replay-v1` `.gz` (single game) or `duels-match-replay-v1` `.zip`
 * (bo3: match.json + per-game `.gz`) into our StoredReplay so it lists and
 * plays back. Tolerant of fields our model doesn't use (Finding §1).
 */
import { gunzipSync, unzipSync, strFromU8 } from "fflate";
import type { StoredReplay } from "@/state/db";
import type { CardIndex } from "@/data/cards";
import type { PlayerId } from "@/engine/state";
import { uid } from "@/lib/id";

interface DuelsGame {
  gameId?: string;
  createdAt?: number;
  playerNames?: Record<string, string>;
  winner?: number | null;
  victoryReason?: string;
  turnCount?: number;
  decklist?: string[];
  baseSnapshot?: { firstPlayer?: number | null } & Record<string, unknown>;
  frames?: unknown[];
  logs?: unknown[];
}

function colorsFromDecklist(ids: string[] | undefined, index?: CardIndex): string[] {
  if (!ids || !index) return [];
  const set = new Set<string>();
  for (const id of ids) index.get(id)?.colors.forEach((c) => set.add(c));
  return [...set].sort();
}

function mapGame(g: DuelsGame, index?: CardIndex): StoredReplay {
  const names = g.playerNames ?? {};
  return {
    id: g.gameId ?? uid(),
    createdAt: g.createdAt ?? Date.now(),
    playerNames: { 1: names["1"] ?? "Player 1", 2: names["2"] ?? "Player 2" },
    deck1Id: "imported",
    deck2Id: "imported",
    deck1Colors: colorsFromDecklist(g.decklist, index),
    deck2Colors: [],
    firstPlayer: (g.baseSnapshot?.firstPlayer ?? null) as PlayerId | null,
    winner: (g.winner ?? null) as PlayerId | null,
    victoryReason: g.victoryReason,
    turnCount: g.turnCount ?? 0,
    imported: true,
    replay: {
      format: "inkforge-replay-v1",
      // Foreign baseSnapshot shape; playback folds leniently and shows the log.
      baseSnapshot: (g.baseSnapshot ?? {}) as never,
      frames: (g.frames ?? []) as never,
      logs: (g.logs ?? []) as never,
    },
  };
}

/** Parse an uploaded duels.ink file into one or more StoredReplays. */
export function parseDuelsFile(buf: Uint8Array, filename: string, index?: CardIndex): StoredReplay[] {
  const name = filename.toLowerCase();
  if (name.endsWith(".zip")) {
    const files = unzipSync(buf);
    const games: StoredReplay[] = [];
    for (const [path, bytes] of Object.entries(files)) {
      if (path.endsWith(".gz")) {
        const json = JSON.parse(strFromU8(gunzipSync(bytes))) as DuelsGame;
        games.push(mapGame(json, index));
      }
    }
    return games;
  }
  if (name.endsWith(".gz")) {
    return [mapGame(JSON.parse(strFromU8(gunzipSync(buf))) as DuelsGame, index)];
  }
  // Plain JSON
  return [mapGame(JSON.parse(strFromU8(buf)) as DuelsGame, index)];
}
