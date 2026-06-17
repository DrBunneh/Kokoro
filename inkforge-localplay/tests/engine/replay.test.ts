import { describe, expect, it } from "vitest";
import rawReplay from "../fixtures/sample.replay.json";
import { foldFrames, makeFrame, dropLastFrame, type Frame } from "@/engine/replay";

// The uploaded duels.ink replay (perspective 2). Used as a golden fixture for
// the JSON-Patch fold — proves reconstruction matches real data.
const replay = rawReplay as unknown as {
  baseSnapshot: Record<string, unknown>;
  frames: Frame[];
  winner: number;
  turnCount: number;
};

describe("replay fold (golden: real duels.ink file)", () => {
  it("reconstructs the coin-toss → mulligan transition (frame 1)", () => {
    const s = foldFrames<Record<string, unknown>>(replay.baseSnapshot, replay.frames, {
      upTo: 1,
      lenient: true,
    });
    expect(s.status).toBe("mulligan");
    expect(s.firstPlayer).toBe(1);
    expect(s.coinToss).toBeUndefined();
  });

  it("reconstructs the full game to the recorded result", () => {
    const final = foldFrames<Record<string, unknown>>(replay.baseSnapshot, replay.frames, {
      lenient: true,
    });
    expect(final.status).toBe("finished");
    expect(final.winner).toBe(replay.winner); // 2
    expect(final.turnNumber).toBe(replay.turnCount); // 2
  });

  it("reconstructs an intermediate point (before GAME_FINISH)", () => {
    const beforeFinish = foldFrames<Record<string, unknown>>(replay.baseSnapshot, replay.frames, {
      upTo: replay.frames.length - 1,
      lenient: true,
    });
    expect(beforeFinish.status).toBe("playing");
    expect(beforeFinish.winner).toBeNull();
  });

  it("take-back: dropping the last frame re-folds to the prior state", () => {
    const { frames, undone } = dropLastFrame(replay.frames);
    expect(undone?.actionType).toBe("GAME_FINISH");
    const rewound = foldFrames<Record<string, unknown>>(replay.baseSnapshot, frames, {
      lenient: true,
    });
    expect(rewound.status).toBe("playing");
  });
});

describe("replay fold (our own strict frames)", () => {
  it("round-trips: makeFrame diff then strict fold reproduces the next state", () => {
    const prev = { x: 1, list: [1, 2], nested: { a: true } };
    const next = { x: 2, list: [1, 2, 3], nested: { a: false } };
    const frame = makeFrame(prev, next, {
      actionType: "TEST",
      player: 1,
      turnNumber: 1,
      logCountAfter: 0,
    }, 1);
    expect(foldFrames(prev, [frame])).toEqual(next);
  });

  it("applies multiple frames in sequence", () => {
    const s0 = { n: 0 };
    const f1 = makeFrame(s0, { n: 1 }, { actionType: "A", player: 1, turnNumber: 1, logCountAfter: 0 }, 1);
    const f2 = makeFrame({ n: 1 }, { n: 2 }, { actionType: "A", player: 1, turnNumber: 1, logCountAfter: 0 }, 2);
    expect(foldFrames(s0, [f1, f2])).toEqual({ n: 2 });
    expect(foldFrames(s0, [f1, f2], { upTo: 1 })).toEqual({ n: 1 });
  });
});
