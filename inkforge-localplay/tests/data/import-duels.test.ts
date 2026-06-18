import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseDuelsFile } from "@/data/import-duels";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(here, "../fixtures", name)));

describe("duels.ink importer", () => {
  it("imports a single .gz game with its metadata", () => {
    const games = parseDuelsFile(fixture("sample.replay.gz"), "sample.replay.gz");
    expect(games).toHaveLength(1);
    const g = games[0]!;
    expect(g.winner).toBe(2);
    expect(g.turnCount).toBe(2);
    expect(g.replay.frames.length).toBe(10);
    expect(g.imported).toBe(true);
    expect(g.playerNames[1]).toBeTruthy();
    expect(g.playerNames[2]).toBeTruthy();
  });

  it("imports all games from a bo3 .zip match", () => {
    const games = parseDuelsFile(fixture("sample.match.zip"), "sample.match.zip");
    expect(games.length).toBe(3);
    for (const g of games) {
      expect(g.imported).toBe(true);
      expect(Array.isArray(g.replay.frames)).toBe(true);
      expect(g.playerNames[1]).toBeTruthy();
    }
  });
});
