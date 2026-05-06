import { Hono } from "hono";
import {
  listInventory,
  getInventoryItem,
  updateItemStatus,
  updateItemLocation,
  getValuation,
  reconcileInventory,
} from "../services/inventory";
import { ok, err } from "../lib/types";
import type { Env } from "../index";

export const inventoryRoutes = new Hono<{ Bindings: Env }>();

// GET /api/inventory/valuation — portfolio summary (registered before /:id)
inventoryRoutes.get("/valuation", async (c) => {
  const result = await getValuation(c.env.DB);
  return c.json(ok(result));
});

// GET /api/inventory/reconcile — quantity balance check (registered before /:id)
inventoryRoutes.get("/reconcile", async (c) => {
  const result = await reconcileInventory(c.env.DB);
  return c.json(ok(result));
});

// GET /api/inventory — list with filters and pagination
inventoryRoutes.get("/", async (c) => {
  const { game, set, condition, location, page, limit } = c.req.query();
  const result = await listInventory(c.env.DB, {
    game: game || undefined,
    set: set || undefined,
    condition: condition || undefined,
    location: location || undefined,
    page: page ? parseInt(page, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  });
  return c.json(ok(result));
});

// GET /api/inventory/:id — single item
inventoryRoutes.get("/:id", async (c) => {
  const item = await getInventoryItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json(err("Inventory item not found"), 404);
  return c.json(ok({ item }));
});

// PUT /api/inventory/:id/status — status transition
inventoryRoutes.put("/:id/status", async (c) => {
  let body: { status?: string; quantity?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Request body must be JSON with { status, quantity? }"), 400);
  }

  if (!body.status) return c.json(err("status is required"), 400);

  const result = await updateItemStatus(c.env.DB, c.req.param("id"), body.status, body.quantity);
  if (result === null) return c.json(err("Inventory item not found"), 404);
  if ("error" in result) return c.json(err(result.error), 422);
  return c.json(ok({ item: result }));
});

// PUT /api/inventory/:id/location — location update
inventoryRoutes.put("/:id/location", async (c) => {
  let body: { location?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Request body must be JSON with { location }"), 400);
  }

  if (!body.location) return c.json(err("location is required"), 400);

  const result = await updateItemLocation(c.env.DB, c.req.param("id"), body.location);
  if (result === null) return c.json(err("Inventory item not found"), 404);
  if ("error" in result) return c.json(err(result.error), 422);
  return c.json(ok({ item: result }));
});
