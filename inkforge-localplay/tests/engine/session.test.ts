import { describe, expect, it } from "vitest";
import { GameSession } from "@/engine/session";
import { createGame } from "@/engine/actions";
import { foldFrames } from "@/engine/replay";
import type { CardLookup, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

const lookup: CardLookup = (id) => ({
  id, name: id, fullName: id, type: "character", colors: ["ruby"], cost: 1, inkable: true,
  strength: 1, willpower: 1, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
  rulesText: "", rarity: "common", setNum: 1, cardNum: 1,
}) satisfies PrintedCard;

function game(seed = "s"): GameState {
  return createGame({
    id: "g", seed, lookup,
    players: { 1: { name: "A", deck: Array.from({ length: 60 }, (_, i) => `1-a${i}`) }, 2: { name: "B", deck: Array.from({ length: 60 }, (_, i) => `1-b${i}`) } },
  });
}

describe("GameSession", () => {
  it("records frames + logs as actions are dispatched", () => {
    const s = new GameSession(game());
    s.dispatch({ type: "CHOOSE_STARTING_PLAYER", player: 1 });
    s.dispatch({ type: "MULLIGAN", player: 1, cardInstanceIds: [] });
    s.dispatch({ type: "MULLIGAN", player: 2, cardInstanceIds: [] });
    expect(s.frames).toHaveLength(3);
    expect(s.state.status).toBe("playing");
    expect(s.logs.length).toBeGreaterThan(0);
    // Replay reconstructs the live state.
    expect(foldFrames(s.baseSnapshot, s.frames)).toEqual(s.state);
  });

  it("undo re-folds to the prior state and trims its logs; redo restores", () => {
    const s = new GameSession(game());
    s.dispatch({ type: "CHOOSE_STARTING_PLAYER", player: 1 });
    const afterChooseState = structuredClone(s.state);
    const afterChooseLogs = s.logs.length;

    s.dispatch({ type: "MULLIGAN", player: 1, cardInstanceIds: [] });
    expect(s.frames).toHaveLength(2);

    s.undo();
    expect(s.frames).toHaveLength(1);
    expect(s.logs.length).toBe(afterChooseLogs);
    expect(s.state).toEqual(afterChooseState);
    expect(s.canRedo).toBe(true);

    s.redo();
    expect(s.frames).toHaveLength(2);
    expect(s.state.mulliganState?.done[1]).toBe(true);
  });

  it("a new action after undo invalidates redo", () => {
    const s = new GameSession(game());
    s.dispatch({ type: "CHOOSE_STARTING_PLAYER", player: 1 });
    s.dispatch({ type: "MULLIGAN", player: 1, cardInstanceIds: [] });
    s.undo();
    expect(s.canRedo).toBe(true);
    s.dispatch({ type: "MULLIGAN", player: 1, cardInstanceIds: [] });
    expect(s.canRedo).toBe(false);
  });

  it("illegal actions throw and do not record a frame", () => {
    const s = new GameSession(game());
    expect(() => s.dispatch({ type: "END_TURN" })).toThrow();
    expect(s.frames).toHaveLength(0);
  });
});
