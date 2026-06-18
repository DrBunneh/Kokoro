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
  scope: "self" | "yours" | "yoursSubtype" | "opponents";
  /** Subtype filter for scope "yoursSubtype" (e.g. "Pirate"). */
  subtype?: string;
  strength?: number;
  willpower?: number;
  lore?: number;
  /** Grant a keyword (with optional stacking value, e.g. Resist +1). */
  keyword?: string;
  keywordValue?: number;
  /** The value scales with the source controller's discard size (Namaari). */
  perDiscard?: boolean;
  /** Only while the source is exerted (Pete - Space Pirate). */
  whileExerted?: boolean;
  /** Only during the opponents' turns (Snow Fort "Barricade"). */
  onlyOpponentTurn?: boolean;
  /** Only while the source's (raw) strength is at least this (Lady "Take the Lead"). */
  whileSelfStrengthAtLeast?: number;
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
      return tgtOwner === srcOwner && target.printed.type === "character";
    case "yoursSubtype":
      return tgtOwner === srcOwner && target.printed.type === "character" && !!def.subtype && target.printed.subtypes.some((s) => s.toLowerCase() === def.subtype!.toLowerCase());
    case "opponents":
      return tgtOwner !== srcOwner && target.printed.type === "character";
    default:
      return false;
  }
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
        if (!applies(def, src, srcOwner, card, tgtOwner)) continue;
        const scale = def.perDiscard ? state.players[srcOwner].discard.length : 1;
        if (def.strength) strength += def.strength * scale;
        if (def.willpower) willpower += def.willpower * scale;
        if (def.lore) lore += def.lore * scale;
        if (def.keyword) keywords.push({ name: def.keyword, value: (def.keywordValue ?? 0) * scale });
      }
    }
  }
  return { strength, willpower, lore, keywords };
}
