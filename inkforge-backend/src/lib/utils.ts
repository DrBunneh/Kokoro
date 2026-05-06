// ─── Monetary Helpers (all values stored as integer pence) ───────────────────

/** Convert pounds (£8.48) to integer pence (848) */
export function poundsToInt(pounds: number): number {
  return Math.round(pounds * 100);
}

/** Convert integer pence (848) to pounds string ("8.48") */
export function intToPounds(pence: number): string {
  return (pence / 100).toFixed(2);
}

/** Parse a European decimal string ("67,84" or "1.234,56") or number to integer pence */
export function parseEuroDecimal(val: string | number): number {
  if (typeof val === "number") return Math.round(val * 100);
  // Strip thousand-separator periods first, then convert decimal comma to period
  const normalised = val.replace(/\./g, "").replace(",", ".");
  return Math.round(parseFloat(normalised) * 100);
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

/** Returns the start and end of a UK tax year (6 Apr → 5 Apr) */
export function taxYearRange(year: number): { from: string; to: string } {
  return {
    from: `${year}-04-06T00:00:00.000Z`,
    to: `${year + 1}-04-05T23:59:59.999Z`,
  };
}

/** ISO 8601 timestamp for right now */
export function now(): string {
  return new Date().toISOString();
}

// ─── ID Generation ────────────────────────────────────────────────────────────

export function uuid(): string {
  return crypto.randomUUID();
}

// ─── Proportional Split (for shipping cost allocation) ────────────────────────

/**
 * Splits a total amount proportionally across items by their individual values.
 * Assigns any pence rounding remainder to the largest item to avoid drift.
 *
 * @param totalPence - The total amount to split (in pence)
 * @param itemValuesPence - Array of item values (in pence)
 * @returns Array of allocated amounts (in pence), same order as input
 */
export function splitProportionally(
  totalPence: number,
  itemValuesPence: number[]
): number[] {
  if (itemValuesPence.length === 0) return [];

  const grandTotal = itemValuesPence.reduce((sum, v) => sum + v, 0);
  if (grandTotal === 0) {
    const even = Math.floor(totalPence / itemValuesPence.length);
    const remainder = totalPence - even * itemValuesPence.length;
    return itemValuesPence.map((_, i) => (i === 0 ? even + remainder : even));
  }

  const raw = itemValuesPence.map((v) => (v / grandTotal) * totalPence);
  const floored = raw.map(Math.floor);
  const remainder = totalPence - floored.reduce((s, v) => s + v, 0);

  // Give remainder pence to the item with the largest fractional part
  const fractions = raw.map((v, i) => ({ i, frac: v - Math.floor(v) }));
  fractions.sort((a, b) => b.frac - a.frac);
  for (let r = 0; r < remainder; r++) {
    const idx = fractions[r]?.i;
    if (idx !== undefined) floored[idx] = (floored[idx] ?? 0) + 1;
  }

  return floored;
}

// ─── Enum Validation ─────────────────────────────────────────────────────────

export function isValidEnum<T extends string>(
  value: unknown,
  validValues: readonly T[]
): value is T {
  return typeof value === "string" && (validValues as string[]).includes(value);
}
