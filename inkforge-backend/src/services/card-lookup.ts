import { drizzle } from "drizzle-orm/d1";
import { eq, and, gt } from "drizzle-orm";
import { cardDataCache } from "../db/schema";
import { uuid, now } from "../lib/utils";
import type { CardDataCache, NewCardDataCache } from "../db/schema";

// ─── Set name mapping (Cardmarket names → API set codes) ─────────────────────

export const SET_MAP: Record<string, string> = {
  "The First Chapter": "1",
  "Rise of the Floodborn": "2",
  "Into the Inklands": "3",
  "Ursula's Return": "4",
  "Shimmering Skies": "5",
  "Azurite Sea": "6",
  "Archazia's Island": "7",
  "Winterspell": "8",
  "Whispers in the Well": "9",
  "Fabled": "F1",
  "Promos Year 1": "P1",
  "Promos Year 2": "P2",
  "Promos Year 3": "P3",
};

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RATE_LIMIT_MS = 1000; // 1 request per second

// Module-level timestamp — persists within a single Worker invocation,
// preventing burst API calls during a bulk import in one request.
let lastApiCallAt = 0;

async function enforceRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastApiCallAt;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastApiCallAt = Date.now();
}

// ─── Lorcast API ──────────────────────────────────────────────────────────────

interface LorcastCard {
  id?: string | number;
  name?: string;
  collector_number?: string;
  number?: string;
  set?: { id?: string; name?: string };
  set_id?: string;
  rarity?: string;
  cost?: number;
  ink_cost?: number;
  ink?: string;
  ink_color?: string;
  type?: string;
  classifications?: string[];
  image?: { thumbnail_url?: string; full_url?: string };
  image_url?: string;
}

interface LorcastResponse {
  results?: LorcastCard[];
}

async function fetchFromLorcast(
  cardName: string,
  setName: string
): Promise<Partial<NewCardDataCache> | null> {
  await enforceRateLimit();

  const q = encodeURIComponent(`name:"${cardName}"`);
  const resp = await fetch(`https://lorcast.com/cards/search?q=${q}`, {
    headers: { Accept: "application/json" },
  });

  if (!resp.ok) return null;

  const data = (await resp.json()) as LorcastResponse | LorcastCard[];
  const results: LorcastCard[] = Array.isArray(data)
    ? data
    : (data.results ?? []);

  if (results.length === 0) return null;

  const setCode = SET_MAP[setName];

  // Prefer exact name + set match, fall back to first exact name match
  const exactMatch =
    results.find(
      (r) =>
        r.name?.toLowerCase() === cardName.toLowerCase() &&
        setCode &&
        (r.set?.id === setCode || r.set_id === setCode)
    ) ??
    results.find((r) => r.name?.toLowerCase() === cardName.toLowerCase()) ??
    results[0];

  if (!exactMatch) return null;

  return {
    collectorNumber: exactMatch.collector_number ?? exactMatch.number ?? null,
    setCode: exactMatch.set?.id ?? exactMatch.set_id ?? setCode ?? null,
    rarity: exactMatch.rarity ?? null,
    inkCost: exactMatch.cost ?? exactMatch.ink_cost ?? null,
    inkColor: exactMatch.ink ?? exactMatch.ink_color ?? null,
    cardType: exactMatch.type ?? null,
    imageUrl:
      exactMatch.image?.thumbnail_url ??
      exactMatch.image?.full_url ??
      exactMatch.image_url ??
      null,
    lorcastId: exactMatch.id?.toString() ?? null,
    lorcanaApiId: null,
  };
}

// ─── Lorcana API (fallback) ───────────────────────────────────────────────────

interface LorcanaApiCard {
  Culture_Invariant_Id?: number;
  Name?: string;
  Number?: string;
  Set_Num?: string;
  Rarity?: string;
  Cost?: number;
  Color?: string;
  Type?: string;
  Image?: string;
}

async function fetchFromLorcanaApi(
  cardName: string
): Promise<Partial<NewCardDataCache> | null> {
  await enforceRateLimit();

  const search = encodeURIComponent(`name==${cardName}`);
  const resp = await fetch(
    `https://api.lorcana-api.com/cards/fetch?search=${search}`,
    { headers: { Accept: "application/json" } }
  );

  if (!resp.ok) return null;

  const data = (await resp.json()) as LorcanaApiCard[] | { cards?: LorcanaApiCard[] };
  const results: LorcanaApiCard[] = Array.isArray(data)
    ? data
    : (data.cards ?? []);

  if (results.length === 0) return null;

  const card =
    results.find((r) => r.Name?.toLowerCase() === cardName.toLowerCase()) ??
    results[0];

  if (!card) return null;

  return {
    collectorNumber: card.Number ?? null,
    setCode: card.Set_Num ?? null,
    rarity: card.Rarity ?? null,
    inkCost: card.Cost ?? null,
    inkColor: card.Color ?? null,
    cardType: card.Type ?? null,
    imageUrl: card.Image ?? null,
    lorcastId: null,
    lorcanaApiId: card.Culture_Invariant_Id?.toString() ?? null,
  };
}

// ─── Main lookup function ─────────────────────────────────────────────────────

/**
 * Looks up a card by name + set, returning cached data if fresh (< 30 days).
 * Falls back to lorcast then lorcana-api. Always writes a cache entry,
 * even if both APIs return nothing (collector_number will be null — flagged for review).
 */
export async function lookupCard(
  d1: D1Database,
  cardName: string,
  setName: string,
  game = "lorcana"
): Promise<CardDataCache> {
  const db = drizzle(d1);
  const thirtyDaysAgo = new Date(Date.now() - CACHE_TTL_MS).toISOString();

  // 1. Check cache
  const cached = await db
    .select()
    .from(cardDataCache)
    .where(
      and(
        eq(cardDataCache.cardName, cardName),
        eq(cardDataCache.setName, setName),
        eq(cardDataCache.game, game),
        gt(cardDataCache.lastRefreshed, thirtyDaysAgo)
      )
    )
    .get();

  if (cached) return cached;

  // 2. Try lorcast
  let apiData = await fetchFromLorcast(cardName, setName).catch(() => null);

  // 3. Fall back to lorcana-api
  if (!apiData) {
    apiData = await fetchFromLorcanaApi(cardName).catch(() => null);
  }

  const timestamp = now();
  const entry: NewCardDataCache = {
    id: uuid(),
    cardName,
    setName,
    game,
    setCode: apiData?.setCode ?? SET_MAP[setName] ?? null,
    collectorNumber: apiData?.collectorNumber ?? null,
    rarity: apiData?.rarity ?? null,
    inkCost: apiData?.inkCost ?? null,
    inkColor: apiData?.inkColor ?? null,
    cardType: apiData?.cardType ?? null,
    imageUrl: apiData?.imageUrl ?? null,
    cardmarketProductId: null,
    lorcanaApiId: apiData?.lorcanaApiId ?? null,
    lorcastId: apiData?.lorcastId ?? null,
    lastRefreshed: timestamp,
    createdAt: timestamp,
  };

  // Upsert: update if already exists (e.g. stale entry), insert if new
  await db
    .insert(cardDataCache)
    .values(entry)
    .onConflictDoUpdate({
      target: [cardDataCache.cardName, cardDataCache.setName, cardDataCache.game],
      set: {
        setCode: entry.setCode,
        collectorNumber: entry.collectorNumber,
        rarity: entry.rarity,
        inkCost: entry.inkCost,
        inkColor: entry.inkColor,
        cardType: entry.cardType,
        imageUrl: entry.imageUrl,
        lorcanaApiId: entry.lorcanaApiId,
        lorcastId: entry.lorcastId,
        lastRefreshed: entry.lastRefreshed,
      },
    });

  return entry as CardDataCache;
}

/**
 * Bulk lookup with enforced rate limiting between each API call.
 * Already-cached cards skip the rate limiter — only API calls are throttled.
 */
export async function lookupCards(
  d1: D1Database,
  cards: Array<{ cardName: string; setName: string; game?: string }>
): Promise<CardDataCache[]> {
  const results: CardDataCache[] = [];
  for (const card of cards) {
    results.push(
      await lookupCard(d1, card.cardName, card.setName, card.game ?? "lorcana")
    );
  }
  return results;
}

/**
 * Update the Cardmarket product ID on a cached card entry.
 * Called during Cardmarket import (WP4) when a product_id is available.
 */
export async function updateCardmarketProductId(
  d1: D1Database,
  cardName: string,
  setName: string,
  game: string,
  productId: string
): Promise<void> {
  const db = drizzle(d1);
  await db
    .update(cardDataCache)
    .set({ cardmarketProductId: productId })
    .where(
      and(
        eq(cardDataCache.cardName, cardName),
        eq(cardDataCache.setName, setName),
        eq(cardDataCache.game, game)
      )
    );
}
