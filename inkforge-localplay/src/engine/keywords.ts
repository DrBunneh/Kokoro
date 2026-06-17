/**
 * Keyword parsing + combat-relevant stat helpers (spec §6.3, rules §10).
 * Keywords arrive as printed strings on `CardInstance.printed.abilities`,
 * e.g. "Evasive", "Resist +1", "Challenger +2", "Shift 5", "Sing Together 7".
 * `+N` variants stack; plain keywords don't (rules §10.1.1).
 */
import type { CardInstance } from "./state";

/** Leading keyword name of an ability string, e.g. "Resist +1" → "resist". */
function keywordName(ability: string): string {
  return ability.replace(/[+0-9].*$/, "").trim().toLowerCase();
}

/** Trailing numeric value of an ability string ("Resist +1" → 1, "Shift 5" → 5). */
function keywordNumber(ability: string): number {
  const m = ability.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

export function hasKeyword(card: CardInstance, name: string): boolean {
  const want = name.toLowerCase();
  return card.printed.abilities.some((a) => keywordName(a.ability) === want);
}

/** Summed value of a stacking keyword (Resist/Challenger), 0 if absent. */
export function keywordValue(card: CardInstance, name: string): number {
  const want = name.toLowerCase();
  return card.printed.abilities
    .filter((a) => keywordName(a.ability) === want)
    .reduce((n, a) => n + keywordNumber(a.ability), 0);
}

export function effectiveStrength(card: CardInstance): number {
  const base = card.printed.strength ?? 0;
  return base + card.appliedEffects.reduce((n, e) => n + (e.strength ?? 0), 0);
}

export function effectiveWillpower(card: CardInstance): number {
  const base = card.printed.willpower ?? 0;
  return base + card.appliedEffects.reduce((n, e) => n + (e.willpower ?? 0), 0);
}

/** A character is banished once its damage meets or exceeds its willpower. */
export function isBanished(card: CardInstance): boolean {
  return card.damage >= effectiveWillpower(card);
}
