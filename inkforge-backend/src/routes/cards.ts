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
 * POST /api/cards/identify
 * Accepts a card image and calls Claude Sonnet vision to identify it.
 * Returns { card_name, set_name, condition_estimate } for form pre-fill.
 */
cardRoutes.post("/identify", async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json(err("Request must be multipart/form-data with an image field"), 400);
  }

  const imageFile = formData.get("image") as unknown as File | null;
  if (!imageFile || typeof imageFile.arrayBuffer !== "function") {
    return c.json(err("image file is required"), 400);
  }

  const buffer = await imageFile.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const mediaType = (imageFile.type || "image/jpeg") as string;

  const requestBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: 'Identify this TCG card. Return ONLY valid JSON with no markdown: {"card_name":"<name>","set_name":"<set>","game":"<lorcana|pokemon|mtg|yugioh|onepiece|other>","condition_estimate":"<NM|LP|MP|HP|DMG>"}',
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": c.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await response.text();
      return c.json(err("Claude API error", text), 502);
    }

    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content.find((b) => b.type === "text")?.text ?? "";

    let parsed: { card_name: string; set_name: string; game: string; condition_estimate: string };
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      return c.json(err("Could not parse card identification from Claude response", text), 422);
    }

    return c.json(ok(parsed));
  } catch (e) {
    return c.json(err("Failed to call Claude API", e instanceof Error ? e.message : e), 502);
  }
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
