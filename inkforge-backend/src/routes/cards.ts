import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { like, eq, and } from "drizzle-orm";
import { cardDataCache } from "../db/schema";
import { lookupCard } from "../services/card-lookup";
import { ok, err } from "../lib/types";
import type { Env } from "../index";

export const cardRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/cards/lookup?name=Gaston - Arrogant Hunter&set=Promos Year 1&game=lorcana
 * Looks up a single card — checks cache first, hits API if stale/missing.
 * Used by WP7 form quick-fill and WP4 import enrichment.
 */
cardRoutes.get("/lookup", async (c) => {
  const cardName = c.req.query("name");
  const setName = c.req.query("set");
  const game = c.req.query("game") ?? "lorcana";

  if (!cardName || !setName) {
    return c.json(err("name and set query parameters are required"), 400);
  }

  try {
    const result = await lookupCard(c.env.DB, cardName, setName, game);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err("Card lookup failed", e instanceof Error ? e.message : e), 500);
  }
});

/**
 * GET /api/cards/search?q=Gaston&game=lorcana
 * Autocomplete search against the local cache only (no external API call).
 * Returns up to 20 matches — used for form typeahead in WP7.
 */
cardRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  const game = c.req.query("game") ?? "lorcana";

  if (!q || q.length < 2) {
    return c.json(ok([]));
  }

  const db = drizzle(c.env.DB);
  const results = await db
    .select({
      cardName: cardDataCache.cardName,
      setName: cardDataCache.setName,
      setCode: cardDataCache.setCode,
      collectorNumber: cardDataCache.collectorNumber,
      rarity: cardDataCache.rarity,
      inkColor: cardDataCache.inkColor,
      imageUrl: cardDataCache.imageUrl,
    })
    .from(cardDataCache)
    .where(
      and(
        eq(cardDataCache.game, game),
        like(cardDataCache.cardName, `%${q}%`)
      )
    )
    .limit(20)
    .all();

  return c.json(ok(results));
});

/**
 * GET /api/cards/cache/:cardName/:setName
 * Returns the raw cache entry for a card (for debugging/testing).
 */
cardRoutes.get("/cache/:cardName/:setName", async (c) => {
  const cardName = decodeURIComponent(c.req.param("cardName"));
  const setName = decodeURIComponent(c.req.param("setName"));
  const game = c.req.query("game") ?? "lorcana";

  const db = drizzle(c.env.DB);
  const result = await db
    .select()
    .from(cardDataCache)
    .where(
      and(
        eq(cardDataCache.cardName, cardName),
        eq(cardDataCache.setName, setName),
        eq(cardDataCache.game, game)
      )
    )
    .get();

  if (!result) return c.json(err("Not found in cache"), 404);
  return c.json(ok(result));
});
