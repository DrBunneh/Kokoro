import { Hono } from "hono";
import {
  createEntry,
  createTradeEntries,
  getEntry,
  updateEntry,
  deleteEntry,
  listEntries,
  summariseEntries,
} from "../services/ledger";
import { ok, err } from "../lib/types";
import type { Env } from "../index";
import type { LedgerEntryInput, TradeInput } from "../services/ledger";

export const ledgerRoutes = new Hono<{ Bindings: Env }>();

// POST /api/ledger — create entry (TRADE type creates two linked entries)
ledgerRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Request body must be JSON"), 400);
  }

  if (body["type"] === "TRADE") {
    const result = await createTradeEntries(c.env.DB, body as Partial<TradeInput>);
    if ("error" in result) return c.json(err(result.error), 422);
    return c.json(ok(result), 201);
  }

  const result = await createEntry(c.env.DB, body as Partial<LedgerEntryInput>);
  if ("error" in result) return c.json(err(result.error), 422);
  return c.json(ok(result), 201);
});

// GET /api/ledger/summary — P&L summary (registered before /:id)
ledgerRoutes.get("/summary", async (c) => {
  const { from, to, tax_year } = c.req.query();
  const result = await summariseEntries(c.env.DB, {
    from: from || undefined,
    to: to || undefined,
    tax_year: tax_year ? parseInt(tax_year, 10) : undefined,
  });
  return c.json(ok(result));
});

// GET /api/ledger — list with filters and pagination
ledgerRoutes.get("/", async (c) => {
  const { from, to, platform, game, set, type, tax_year, page, limit } = c.req.query();
  const result = await listEntries(c.env.DB, {
    from: from || undefined,
    to: to || undefined,
    platform: platform || undefined,
    game: game || undefined,
    set: set || undefined,
    type: type || undefined,
    tax_year: tax_year ? parseInt(tax_year, 10) : undefined,
    page: page ? parseInt(page, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  });
  return c.json(ok(result));
});

// GET /api/ledger/:id — single entry
ledgerRoutes.get("/:id", async (c) => {
  const entry = await getEntry(c.env.DB, c.req.param("id"));
  if (!entry) return c.json(err("Entry not found"), 404);
  return c.json(ok({ entry }));
});

// PUT /api/ledger/:id — update entry (recalculates net_amount)
ledgerRoutes.put("/:id", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Request body must be JSON"), 400);
  }

  const result = await updateEntry(c.env.DB, c.req.param("id"), body as Partial<LedgerEntryInput>);
  if (result === null) return c.json(err("Entry not found"), 404);
  if ("error" in result) return c.json(err(result.error), 422);
  return c.json(ok(result));
});

// DELETE /api/ledger/:id — soft delete (sets deleted_at, preserves HMRC audit trail)
ledgerRoutes.delete("/:id", async (c) => {
  const deleted = await deleteEntry(c.env.DB, c.req.param("id"));
  if (!deleted) return c.json(err("Entry not found"), 404);
  return c.json(ok({ deleted: true }));
});
