import { describe, expect, it } from "vitest";
import { createPaired } from "@/net/paired";
import { NetGame } from "@/net/netgame";
import { createGame } from "@/engine/actions";
import type { CardLookup, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

const lookup: CardLookup = (id) => ({
  id, name: id, fullName: id, type: "character", colors: ["ruby"], cost: 1, inkable: true,
  strength: 1, willpower: 1, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
  rulesText: "", rarity: "common", setNum: 1, cardNum: 1,
}) satisfies PrintedCard;

function base(): GameState {
  return createGame({
    id: "g", seed: "net-seed", lookup,
    players: { 1: { name: "Host", deck: Array.from({ length: 60 }, (_, i) => `1-a${i}`) }, 2: { name: "Away", deck: Array.from({ length: 60 }, (_, i) => `1-b${i}`) } },
  });
}

describe("host-authoritative sync (loopback)", () => {
  it("keeps host and follower states identical across actions from both sides", () => {
    const [ht, ft] = createPaired();
    const start = base();
    const host = new NetGame(ht, "host", structuredClone(start));
    const follower = new NetGame(ft, "follower", structuredClone(start));

    // Host drives setup; follower's own mulligan is forwarded to the host.
    host.localAction({ type: "CHOOSE_STARTING_PLAYER", player: 1 });
    host.localAction({ type: "MULLIGAN", player: 1, cardInstanceIds: [] });
    follower.localAction({ type: "MULLIGAN", player: 2, cardInstanceIds: [] });

    expect(host.state.status).toBe("playing");
    expect(follower.state.status).toBe("playing");
    expect(follower.state).toEqual(host.state);

    // A host action and a follower action both replicate.
    const inkId = host.state.players[1].hand[0]!.instanceId;
    host.localAction({ type: "ADD_TO_INK", cardInstanceId: inkId });
    host.localAction({ type: "END_TURN" });
    // Now P2's turn; follower acts.
    const f2Ink = follower.state.players[2].hand[0]!.instanceId;
    follower.localAction({ type: "ADD_TO_INK", cardInstanceId: f2Ink });

    expect(follower.state).toEqual(host.state);
    expect(host.session.frames.length).toBe(follower.session.frames.length);
  });

  it("the authority drops an illegal follower action without diverging", () => {
    const [ht, ft] = createPaired();
    const start = base();
    const host = new NetGame(ht, "host", structuredClone(start));
    const follower = new NetGame(ft, "follower", structuredClone(start));

    // Illegal before setup — host rejects, nothing replicates.
    follower.localAction({ type: "END_TURN" });
    expect(host.session.frames.length).toBe(0);
    expect(follower.state).toEqual(host.state);
  });
});
