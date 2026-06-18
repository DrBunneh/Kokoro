/**
 * Keyword parsing + combat-relevant stat helpers (spec §6.3, rules §10).
 * Keywords arrive as printed strings on `CardInstance.printed.abilities`,
 * e.g. "Evasive", "Resist +1", "Challenger +2", "Shift 5", "Sing Together 7".
 * `+N` variants stack; plain keywords don't (rules §10.1.1).
 *
 * Effective stats fold in three layers: printed base, `appliedEffects` (one-shot
 * buffs/debuffs/granted keywords), and `continuous` modifiers from permanents in
 * play (Snow Fort, Namaari, …). The latter needs the whole game state.
 */
import type { CardInstance, GameState } from "./state";
import { statMods } from "./continuous";

/** Leading keyword name of an ability string, e.g. "Resist +1" → "resist". */
function keywordName(ability: string): string {
  return ability.replace(/[+0-9].*$/, "").trim().toLowerCase();
}

/** Trailing numeric value of an ability string ("Resist +1" → 1, "Shift 5" → 5). */
function keywordNumber(ability: string): number {
  const m = ability.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

export function hasKeyword(state: GameState, card: CardInstance, name: string): boolean {
  const want = name.toLowerCase();
  return (
    card.printed.abilities.some((a) => keywordName(a.ability) === want) ||
    card.appliedEffects.some((e) => e.keyword?.toLowerCase() === want) ||
    statMods(state, card).keywords.some((k) => k.name.toLowerCase() === want)
  );
}

/** Summed value of a stacking keyword (Resist/Challenger), incl. granted + continuous. */
export function keywordValue(state: GameState, card: CardInstance, name: string): number {
  const want = name.toLowerCase();
  const printed = card.printed.abilities
    .filter((a) => keywordName(a.ability) === want)
    .reduce((n, a) => n + keywordNumber(a.ability), 0);
  const granted = card.appliedEffects
    .filter((e) => e.keyword?.toLowerCase() === want)
    .reduce((n, e) => n + (e.keywordValue ?? 0), 0);
  const continuous = statMods(state, card).keywords
    .filter((k) => k.name.toLowerCase() === want)
    .reduce((n, k) => n + k.value, 0);
  return printed + granted + continuous;
}

export function effectiveStrength(state: GameState, card: CardInstance): number {
  const base = card.printed.strength ?? 0;
  const applied = card.appliedEffects.reduce((n, e) => n + (e.strength ?? 0), 0);
  return base + applied + statMods(state, card).strength;
}

export function effectiveWillpower(state: GameState, card: CardInstance): number {
  const base = card.printed.willpower ?? 0;
  const applied = card.appliedEffects.reduce((n, e) => n + (e.willpower ?? 0), 0);
  return base + applied + statMods(state, card).willpower;
}

export function effectiveLore(state: GameState, card: CardInstance): number {
  const base = card.printed.lore ?? 0;
  const applied = card.appliedEffects.reduce((n, e) => n + (e.lore ?? 0), 0);
  return base + applied + statMods(state, card).lore;
}

/** A character is banished once its damage meets or exceeds its willpower. */
export function isBanished(state: GameState, card: CardInstance): boolean {
  return card.damage >= effectiveWillpower(state, card);
}
