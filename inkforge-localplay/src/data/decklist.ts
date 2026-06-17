/**
 * Decklist text format (spec §5.3). Canonical form, one line per card:
 *
 *   {count} {fullName} ({set}-{number})
 *   e.g.  4 Be Prepared (1-128)
 *
 * The `(set-number)` token is authoritative for identity; `fullName` is for
 * humans. The parser is tolerant of curly quotes and extra whitespace; the
 * exporter produces exactly this format.
 */
import type { CardIndex } from "./cards";
import type { DeckCard, DeckStats } from "./deck-types";
import type { PrintedCard } from "./card-types";

export interface ParseResult {
  cards: DeckCard[];
  /** Human-readable names captured from the text, keyed by id (best-effort). */
  names: Record<string, string>;
  warnings: string[];
}

/** Normalise curly quotes/apostrophes and dashes so names compare cleanly. */
function normalize(text: string): string {
  return text
    .replace(/﻿/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-");
}

const LINE_RE = /^(\d+)\s*x?\s+(.*?)\s*\(\s*(\d+)\s*-\s*(\d+)\s*\)\s*$/i;

export function parseDecklist(input: string): ParseResult {
  const cards = new Map<string, number>();
  const names: Record<string, string> = {};
  const warnings: string[] = [];

  for (const rawLine of normalize(input).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const m = line.match(LINE_RE);
    if (!m) {
      warnings.push(`Could not parse line: "${line}"`);
      continue;
    }
    const count = Number(m[1]);
    const fullName = m[2]!.trim();
    const id = `${m[3]}-${m[4]}`;
    if (count <= 0) {
      warnings.push(`Ignoring non-positive count on line: "${line}"`);
      continue;
    }
    cards.set(id, (cards.get(id) ?? 0) + count);
    if (fullName) names[id] = fullName;
  }

  return {
    cards: [...cards.entries()].map(([id, count]) => ({ id, count })),
    names,
    warnings,
  };
}

/** Produce the exact canonical text (spec §5.3 exporter; used by "Copy as text"). */
export function exportDecklist(cards: DeckCard[], index: CardIndex): string {
  const sorted = [...cards].sort((a, b) => {
    const ca = index.get(a.id);
    const cb = index.get(b.id);
    const sa = ca?.setNum ?? 0;
    const sb = cb?.setNum ?? 0;
    if (sa !== sb) return sa - sb;
    return (ca?.cardNum ?? 0) - (cb?.cardNum ?? 0);
  });
  return sorted
    .map(({ id, count }) => {
      const card = index.get(id);
      const name = card?.fullName ?? id;
      return `${count} ${name} (${id})`;
    })
    .join("\n");
}

export function deckCardCount(cards: DeckCard[]): number {
  return cards.reduce((n, c) => n + c.count, 0);
}

/** Derived tile stats (spec §5.3, §11.2). */
export function deriveDeckStats(cards: DeckCard[], index: CardIndex): DeckStats {
  const colors = new Set<PrintedCard["colors"][number]>();
  let inkable = 0;
  let uninkable = 0;
  for (const { id, count } of cards) {
    const card = index.get(id);
    if (!card) continue;
    card.colors.forEach((c) => colors.add(c));
    if (card.inkable) inkable += count;
    else uninkable += count;
  }
  return {
    colors: [...colors].sort(),
    totalCount: deckCardCount(cards),
    inkableCount: inkable,
    uninkableCount: uninkable,
  };
}

export interface DeckValidationOptions {
  /** Expected deck size (default 60). */
  deckSize?: number;
  /** Max copies of any one card (default 4). */
  maxCopies?: number;
  /** Max distinct ink colours (default 2). */
  maxColors?: number;
}

/**
 * Format legality (spec §5.3). Returns warnings only — illegal decks are
 * allowed to save for casual testing; we warn, never block.
 */
export function validateDeck(
  cards: DeckCard[],
  index: CardIndex,
  opts: DeckValidationOptions = {},
): string[] {
  const { deckSize = 60, maxCopies = 4, maxColors = 2 } = opts;
  const warnings: string[] = [];
  const total = deckCardCount(cards);
  if (total !== deckSize) warnings.push(`Deck has ${total} cards (expected ${deckSize}).`);

  for (const { id, count } of cards) {
    if (count > maxCopies) {
      const name = index.get(id)?.fullName ?? id;
      warnings.push(`${name}: ${count} copies (max ${maxCopies}).`);
    }
    if (!index.get(id)) warnings.push(`Unknown card id: ${id}.`);
  }

  const { colors } = deriveDeckStats(cards, index);
  if (colors.length > maxColors)
    warnings.push(`Deck uses ${colors.length} ink colours (max ${maxColors}): ${colors.join(", ")}.`);

  return warnings;
}
