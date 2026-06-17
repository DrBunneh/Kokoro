/**
 * Runtime card DB access by id (spec §5.1). The bundled, build-time JSON
 * (`cards.generated.json`, produced by `scripts/build-card-db.ts`) is loaded
 * lazily as its own chunk so the ~1.5MB catalog stays out of the initial bundle.
 * No network is touched at runtime.
 */
import type { CardType, InkColor, PrintedCard } from "./card-types";

export interface CardIndex {
  all: PrintedCard[];
  byId: Map<string, PrintedCard>;
  get(id: string): PrintedCard | undefined;
}

/** Pure index builder — kept separate so it can be unit-tested without dynamic import. */
export function buildIndex(cards: PrintedCard[]): CardIndex {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return { all: cards, byId, get: (id) => byId.get(id) };
}

let cached: CardIndex | null = null;

/** Memoised async load of the bundled catalog. */
export async function loadCardDb(): Promise<CardIndex> {
  if (cached) return cached;
  const mod = await import("./cards.generated.json");
  const db = (mod.default ?? mod) as { cards: PrintedCard[] };
  cached = buildIndex(db.cards);
  return cached;
}

export interface CardFilter {
  text?: string;
  colors?: InkColor[];
  types?: CardType[];
  cost?: { min?: number; max?: number };
  keyword?: string;
}

/** Pure filter used by the deck builder Search tab (spec §11.3). */
export function filterCards(cards: PrintedCard[], f: CardFilter): PrintedCard[] {
  const text = f.text?.trim().toLowerCase();
  const keyword = f.keyword?.toLowerCase();
  return cards.filter((c) => {
    if (text && !c.fullName.toLowerCase().includes(text) && !c.rulesText.toLowerCase().includes(text))
      return false;
    if (f.colors?.length && !c.colors.some((col) => f.colors!.includes(col))) return false;
    if (f.types?.length && !f.types.includes(c.type)) return false;
    if (f.cost?.min != null && c.cost < f.cost.min) return false;
    if (f.cost?.max != null && c.cost > f.cost.max) return false;
    if (keyword && !c.abilities.some((a) => a.ability.toLowerCase().includes(keyword))) return false;
    return true;
  });
}
