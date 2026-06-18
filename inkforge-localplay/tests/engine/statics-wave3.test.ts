import { describe, expect, it } from "vitest";
import { effectiveStrength, effectiveLore, effectiveWillpower, keywordValue } from "@/engine/keywords";
import type { CardInstance, GameState } from "@/engine/state";
import type { PrintedCard } from "@/data/card-types";

function printed(over: Partial<PrintedCard> = {}): PrintedCard {
  return {
    id: "x", name: "x", fullName: "x", type: "character", colors: ["ruby"], cost: 1, inkable: true,
    strength: 2, willpower: 3, lore: 1, abilities: [], specialAbilities: [], subtypes: [],
    rulesText: "", rarity: "common", setNum: 1, cardNum: 1, ...over,
  };
}
function inst(id: string, p: PrintedCard, over: Partial<CardInstance> = {}): CardInstance {
  return { instanceId: id, printed: p, damage: 0, exerted: false, justPlayed: false, appliedEffects: [], cardsUnder: [], ...over };
}
function state(p1: Partial<GameState["players"][1]>, p2: Partial<GameState["players"][2]> = {}): GameState {
  const blank = () => ({ name: "", hand: [], field: [], items: [], inkwell: [], discard: [], deck: [], lore: 0, discounts: [], extraInk: 0, discardedThisTurn: 0, playedThisTurn: [] });
  return { id: "t", status: "playing", currentPlayer: 1, turnNumber: 1, firstPlayer: 1, hasInkedThisTurn: false, players: { 1: { ...blank(), ...p1 }, 2: { ...blank(), ...p2 } }, pendingPrompts: [], winner: null, rngSeed: "s", rngCursor: 0 } as GameState;
}

const SA = (slug: string) => [{ name: slug, slug, effect: slug }];

describe("Wave 3 — scaling & gated statics", () => {
  it("Mr. Incredible 'alwaysunited': +2 {S} per other character", () => {
    const mr = inst("mr", printed({ strength: 4, specialAbilities: SA("alwaysunited") }));
    const a = inst("a", printed());
    const b = inst("b", printed());
    const g = state({ field: [mr, a, b] });
    expect(effectiveStrength(g, mr)).toBe(4 + 2 * 2); // two other characters
  });

  it("Alien 'weareone': +1 {S} per other Toy only", () => {
    const alien = inst("al", printed({ strength: 1, specialAbilities: SA("weareone") }));
    const toy = inst("toy", printed({ subtypes: ["Toy"] }));
    const notToy = inst("nt", printed({ subtypes: ["Hero"] }));
    const g = state({ field: [alien, toy, notToy] });
    expect(effectiveStrength(g, alien)).toBe(1 + 1); // only the one Toy counts
  });

  it("Tamatoa 'glam': +1 {L} per item in play", () => {
    const t = inst("t", printed({ lore: 1, specialAbilities: SA("glam") }));
    const g = state({ field: [t], items: [inst("i1", printed({ type: "item" })), inst("i2", printed({ type: "item" }))] });
    expect(effectiveLore(g, t)).toBe(1 + 2);
  });

  it("Piglet 'andimthecaptain': +2 {L} only while 2+ other characters", () => {
    const pig = inst("pig", printed({ lore: 1, specialAbilities: SA("andimthecaptain") }));
    const a = inst("a", printed());
    const g1 = state({ field: [pig, a] });
    expect(effectiveLore(g1, pig)).toBe(1); // only 1 other → no bonus
    const g2 = state({ field: [pig, a, inst("b", printed())] });
    expect(effectiveLore(g2, pig)).toBe(3); // 2 others → +2
  });

  it("Angel 'untouchable': Resist +2 only while hand is empty", () => {
    const angel = inst("ang", printed({ specialAbilities: SA("untouchable") }));
    const withCard = state({ field: [angel], hand: [inst("h", printed())] });
    expect(keywordValue(withCard, angel, "Resist")).toBe(0);
    const empty = state({ field: [angel], hand: [] });
    expect(keywordValue(empty, angel, "Resist")).toBe(2);
  });

  it("Rhino 'epicballofawesome': Resist +2 only while undamaged", () => {
    const r = inst("r", printed({ specialAbilities: SA("epicballofawesome") }));
    const g = state({ field: [r] });
    expect(keywordValue(g, r, "Resist")).toBe(2);
    r.damage = 1;
    expect(keywordValue(g, r, "Resist")).toBe(0);
  });

  it("Diablo 'cruelintent': +2 {S}/+1 {L} only while a Villain is in play", () => {
    const d = inst("d", printed({ strength: 1, lore: 1, specialAbilities: SA("cruelintent") }));
    const noVillain = state({ field: [d] });
    expect(effectiveStrength(noVillain, d)).toBe(1);
    const withVillain = state({ field: [d, inst("v", printed({ subtypes: ["Villain"] }))] });
    expect(effectiveStrength(withVillain, d)).toBe(3);
    expect(effectiveLore(withVillain, d)).toBe(2);
  });

  it("Scrooge 'countingcoins': +1 {S}/+1 {W} per card under (Shift stack)", () => {
    const under = [inst("u1", printed()), inst("u2", printed())];
    const scrooge = inst("sc", printed({ strength: 3, willpower: 4, specialAbilities: SA("countingcoins") }), { cardsUnder: under });
    const g = state({ field: [scrooge] });
    expect(effectiveStrength(g, scrooge)).toBe(3 + 2);
    expect(effectiveWillpower(g, scrooge)).toBe(4 + 2);
  });

  it("Hercules 'superhumanstrength': +3 {S} only while a card is under him", () => {
    const herc = inst("h", printed({ strength: 4, specialAbilities: SA("superhumanstrength") }));
    const bare = state({ field: [herc] });
    expect(effectiveStrength(bare, herc)).toBe(4);
    herc.cardsUnder = [inst("u", printed())];
    expect(effectiveStrength(bare, herc)).toBe(7);
  });

  it("Mickey 'leadingtheway': other Amber characters get +2 {W} (not self)", () => {
    const mickey = inst("m", printed({ colors: ["amber"], willpower: 5, specialAbilities: SA("leadingtheway") }));
    const amberAlly = inst("a", printed({ colors: ["amber"], willpower: 2 }));
    const rubyAlly = inst("r", printed({ colors: ["ruby"], willpower: 2 }));
    const g = state({ field: [mickey, amberAlly, rubyAlly] });
    expect(effectiveWillpower(g, amberAlly)).toBe(4); // +2
    expect(effectiveWillpower(g, rubyAlly)).toBe(2); // wrong color
    expect(effectiveWillpower(g, mickey)).toBe(5); // excludeSelf
  });
});
