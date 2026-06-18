/**
 * Continuous (static/passive) effects layer. Unlike one-shot triggered effects
 * (which push to the bag), these are ongoing modifiers contributed by permanents
 * in play — e.g. Snow Fort "+1 {S} to your characters", Namaari "+1 {S} per card
 * in your discard", Pete - Space Pirate "your Pirates gain Resist +1 while exerted".
 *
 * Stats are recomputed live: `statMods(state, card)` aggregates every applicable
 * modifier so `effectiveStrength`/`Willpower`/keyword lookups can fold them in.
 * Data-driven via `card-statics.json` keyed by the source ability's slug.
 */
import statdata from "./effects/card-statics.json";
import { findInstance } from "./zones";
import type { CardInstance, GameState, PlayerId } from "./state";

export interface StaticDef {
  /** Who the modifier applies to, relative to the source's controller. */
  scope: "self" | "yours" | "yoursSubtype" | "yoursColor" | "opponents";
  /** Subtype filter for scope "yoursSubtype" (e.g. "Pirate"). */
  subtype?: string;
  /** Color filter for scope "yoursColor" (e.g. "amber"). */
  color?: string;
  strength?: number;
  willpower?: number;
  lore?: number;
  /** Grant a keyword (with optional stacking value, e.g. Resist +1). */
  keyword?: string;
  keywordValue?: number;
  /** Don't apply the modifier to the source itself (for team scopes — "your other …"). */
  excludeSelf?: boolean;
  /** The value scales with the source controller's discard size (Namaari). */
  perDiscard?: boolean;
  /** Scale with the number of the controller's *other* characters (Mr. Incredible). */
  perOther?: boolean;
  /** Scale with the controller's other characters of this subtype (Alien — Toy). */
  perOtherSubtype?: string;
  /** Scale with the number of items the controller has in play (Tamatoa — glam). */
  perItem?: boolean;
  /** Scale with the number of cards under the source (Shift stack — Genie, Scrooge). */
  perCardUnder?: boolean;
  /** Only while there's at least one card under the source (Hercules-Spectral, Flynn). */
  whileHasCardUnder?: boolean;
  /** Only applies to targets that already have this keyword (Peter Pan — Evasive → Rush). */
  targetHasKeyword?: string;
  /** Only while the source is exerted (Pete - Space Pirate). */
  whileExerted?: boolean;
  /** Only during the opponents' turns (Snow Fort "Barricade"). */
  onlyOpponentTurn?: boolean;
  /** Only while the source's (raw) strength is at least this (Lady "Take the Lead"). */
  whileSelfStrengthAtLeast?: number;
  /** Only while the controller holds no cards (Angel - Experiment 624). */
  whileNoHand?: boolean;
  /** Only while the source has no damage (Rhino - Power Hamster). */
  whileSelfUndamaged?: boolean;
  /** Only while the controller has at least N other characters (optionally of `otherSubtype`). */
  whileOtherCharsAtLeast?: number;
  otherSubtype?: string;
  /** Only while the controller has a character of this subtype in play (Diablo - Stone Servant — Villain). */
  whileControllerHasSubtype?: string;
}

/**
 * Would damage be prevented for `target` right now? `kind` distinguishes the
 * source of the damage so "can't be dealt damage unless challenged" works.
 * Note: the `extralayers` shield is one-shot per turn, so this mutates the flag
 * when it consumes the shield — call it only when damage would actually land.
 */
export function damagePrevented(state: GameState, target: CardInstance, kind: "effect" | "defender" | "attacker"): boolean {
  const loc = findInstance(state, target.instanceId);
  if (!loc || target.printed.type !== "character") return false;
  const owner = loc.owner;
  const isDefender = kind === "defender";
  const has = (slug: string) => target.printed.specialAbilities.some((a) => a.slug === slug);
  // Hercules - Mighty Leader: can't be dealt damage unless being challenged.
  if (!isDefender && has("evervigilant")) return true;
  // Ever Valiant: while exerted, your *other* Hero characters can't be dealt damage unless challenged.
  if (!isDefender && target.printed.subtypes.some((s) => s.toLowerCase() === "hero")) {
    if (state.players[owner].field.some((c) => c.instanceId !== target.instanceId && c.exerted && c.printed.specialAbilities.some((a) => a.slug === "evervaliant"))) return true;
  }
  // Lilo - Bundled Up: the first damage during an opponent's turn is prevented.
  if (has("extralayers") && state.currentPlayer !== owner && !target.damageShieldedThisTurn) {
    target.damageShieldedThisTurn = true;
    return true;
  }
  return false;
}

/** A controller's "{S} can't be reduced below printed" floor (Elisa "Forever Strong"). */
export function hasStrengthFloor(state: GameState, card: CardInstance): boolean {
  const loc = findInstance(state, card.instanceId);
  if (!loc || card.printed.type !== "character") return false;
  return state.players[loc.owner].field.some((c) => c.printed.specialAbilities.some((a) => a.slug === "foreverstrong"));
}

/** Strength excluding continuous mods — used by self-referential static conditions. */
function rawStrength(card: CardInstance): number {
  return (card.printed.strength ?? 0) + card.appliedEffects.reduce((n, e) => n + (e.strength ?? 0), 0);
}

const STATICS: Record<string, StaticDef[]> = (() => {
  const { $schema: _s, ...rest } = statdata as Record<string, unknown>;
  return rest as Record<string, StaticDef[]>;
})();

export interface StatMods {
  strength: number;
  willpower: number;
  lore: number;
  keywords: { name: string; value: number }[];
}

const ZERO: StatMods = { strength: 0, willpower: 0, lore: 0, keywords: [] };

/** All permanents that can be a continuous source (characters/items/locations in play). */
function sources(state: GameState): { card: CardInstance; owner: PlayerId }[] {
  const out: { card: CardInstance; owner: PlayerId }[] = [];
  for (const owner of [1, 2] as PlayerId[]) {
    for (const c of state.players[owner].field) out.push({ card: c, owner });
    for (const c of state.players[owner].items) out.push({ card: c, owner });
  }
  return out;
}

/** Does `def` (from `source` owned by `srcOwner`) apply to `target` owned by `tgtOwner`? */
function applies(def: StaticDef, source: CardInstance, srcOwner: PlayerId, target: CardInstance, tgtOwner: PlayerId): boolean {
  switch (def.scope) {
    case "self":
      return source.instanceId === target.instanceId;
    case "yours":
      if (def.excludeSelf && source.instanceId === target.instanceId) return false;
      return tgtOwner === srcOwner && target.printed.type === "character";
    case "yoursSubtype":
      if (def.excludeSelf && source.instanceId === target.instanceId) return false;
      return tgtOwner === srcOwner && target.printed.type === "character" && !!def.subtype && target.printed.subtypes.some((s) => s.toLowerCase() === def.subtype!.toLowerCase());
    case "yoursColor":
      if (def.excludeSelf && source.instanceId === target.instanceId) return false;
      return tgtOwner === srcOwner && target.printed.type === "character" && !!def.color && target.printed.colors.some((c) => c.toLowerCase() === def.color!.toLowerCase());
    case "opponents":
      return tgtOwner !== srcOwner && target.printed.type === "character";
    default:
      return false;
  }
}

/** Does a card have a keyword from its printed abilities or a one-shot grant?
 * (Continuous-granted keywords are excluded to avoid recursion into statMods.) */
function targetHasPrintedKeyword(card: CardInstance, keyword: string): boolean {
  const want = keyword.toLowerCase();
  return (
    card.printed.abilities.some((a) => a.ability.toLowerCase().startsWith(want)) ||
    card.appliedEffects.some((e) => e.keyword?.toLowerCase() === want)
  );
}

/** Count the controller's other characters in play (optionally of a subtype). */
function otherChars(state: GameState, owner: PlayerId, source: CardInstance, subtype?: string): number {
  return state.players[owner].field.filter(
    (c) => c.printed.type === "character" && c.instanceId !== source.instanceId &&
      (!subtype || c.printed.subtypes.some((s) => s.toLowerCase() === subtype.toLowerCase())),
  ).length;
}

/** Aggregate every continuous modifier affecting `card` right now. */
export function statMods(state: GameState, card: CardInstance): StatMods {
  const loc = findInstance(state, card.instanceId);
  if (!loc) return ZERO;
  const tgtOwner = loc.owner;
  let strength = 0, willpower = 0, lore = 0;
  const keywords: { name: string; value: number }[] = [];

  for (const { card: src, owner: srcOwner } of sources(state)) {
    for (const sa of src.printed.specialAbilities) {
      for (const def of STATICS[sa.slug] ?? []) {
        if (def.whileExerted && !src.exerted) continue;
        if (def.onlyOpponentTurn && state.currentPlayer === srcOwner) continue;
        if (def.whileSelfStrengthAtLeast != null && rawStrength(src) < def.whileSelfStrengthAtLeast) continue;
        if (def.whileNoHand && state.players[srcOwner].hand.length > 0) continue;
        if (def.whileSelfUndamaged && src.damage > 0) continue;
        if (def.whileOtherCharsAtLeast != null && otherChars(state, srcOwner, src, def.otherSubtype) < def.whileOtherCharsAtLeast) continue;
        if (def.whileControllerHasSubtype && !state.players[srcOwner].field.some((c) => c.printed.type === "character" && c.printed.subtypes.some((s) => s.toLowerCase() === def.whileControllerHasSubtype!.toLowerCase()))) continue;
        if (def.whileHasCardUnder && src.cardsUnder.length === 0) continue;
        if (def.targetHasKeyword && !targetHasPrintedKeyword(card, def.targetHasKeyword)) continue;
        if (!applies(def, src, srcOwner, card, tgtOwner)) continue;
        const scale = def.perDiscard
          ? state.players[srcOwner].discard.length
          : def.perItem
            ? state.players[srcOwner].items.length
            : def.perOther
              ? otherChars(state, srcOwner, src)
              : def.perOtherSubtype
                ? otherChars(state, srcOwner, src, def.perOtherSubtype)
                : def.perCardUnder
                  ? src.cardsUnder.length
                  : 1;
        if (def.strength) strength += def.strength * scale;
        if (def.willpower) willpower += def.willpower * scale;
        if (def.lore) lore += def.lore * scale;
        if (def.keyword) keywords.push({ name: def.keyword, value: (def.keywordValue ?? 0) * scale });
      }
    }
  }
  return { strength, willpower, lore, keywords };
}
