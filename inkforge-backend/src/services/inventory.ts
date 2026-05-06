import { drizzle } from "drizzle-orm/d1";
import { eq, and, sql, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { inventoryItems } from "../db/schema";
import { uuid, now, isValidEnum } from "../lib/utils";
import type { InventoryItem, LedgerEntry } from "../db/schema";

// ─── Valid enum sets ───────────────────────────────────────────────────────────

const VALID_LOCATIONS = [
  "home_binder_a", "home_binder_b", "home_storage",
  "listed_ebay", "listed_store", "trade_show_kit",
  "grading_submission", "other",
] as const;

// ─── Inventory upsert (called by ledger engine and Cardmarket import) ─────────

interface UpsertParams {
  cardName: string;
  setName: string;
  game: string;
  condition: string;
  productId?: string | null;
  category: string;
  quantityDelta: number;       // positive for purchases, negative for sales/write-offs
  costDeltaPence: number;      // positive for purchases, negative for sales/write-offs
  timestamp?: string;
}

export async function upsertInventoryItem(d1: D1Database, params: UpsertParams): Promise<void> {
  const db = drizzle(d1);
  const timestamp = params.timestamp ?? now();

  const existing = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.cardName, params.cardName),
        eq(inventoryItems.setName, params.setName),
        eq(inventoryItems.game, params.game),
        eq(inventoryItems.condition, params.condition)
      )
    )
    .get();

  if (existing) {
    const newTotal = Math.max(0, existing.quantityTotal + params.quantityDelta);
    const newAvailable = Math.max(0, existing.quantityAvailable + params.quantityDelta);
    const newCostTotal = Math.max(0, existing.costBasisTotalPence + params.costDeltaPence);
    const newAvg = newTotal > 0 ? Math.round(newCostTotal / newTotal) : 0;

    await db
      .update(inventoryItems)
      .set({
        quantityTotal: newTotal,
        quantityAvailable: newAvailable,
        costBasisTotalPence: newCostTotal,
        costBasisAvgPence: newAvg,
        lastAcquired: params.quantityDelta > 0 ? timestamp : existing.lastAcquired,
        updatedAt: timestamp,
      })
      .where(eq(inventoryItems.id, existing.id));
  } else if (params.quantityDelta > 0) {
    // Only create a new row for additions — nothing to remove if row doesn't exist
    await db.insert(inventoryItems).values({
      id: uuid(),
      cardName: params.cardName,
      setName: params.setName,
      game: params.game,
      productId: params.productId ?? null,
      collectorNumber: null,
      category: params.category,
      condition: params.condition,
      quantityTotal: params.quantityDelta,
      quantityAvailable: params.quantityDelta,
      quantityListed: 0,
      quantityReserved: 0,
      quantityGrading: 0,
      costBasisTotalPence: params.costDeltaPence,
      costBasisAvgPence: Math.round(params.costDeltaPence / params.quantityDelta),
      marketValuePence: null,
      location: null,
      firstAcquired: timestamp,
      lastAcquired: timestamp,
      updatedAt: timestamp,
    });
  }
}

// ─── Ledger integration hooks ─────────────────────────────────────────────────

export async function upsertInventoryFromLedger(
  d1: D1Database,
  entry: LedgerEntry
): Promise<void> {
  if (entry.type === "PURCHASE" || entry.type === "PRIZE") {
    await upsertInventoryItem(d1, {
      cardName: entry.cardName,
      setName: entry.setName,
      game: entry.game,
      condition: entry.condition,
      productId: entry.productId,
      category: entry.category,
      quantityDelta: entry.quantity,
      costDeltaPence: entry.netAmountPence,
    });
  } else if (entry.type === "SALE" || entry.type === "WRITE_OFF") {
    const db = drizzle(d1);
    const existing = await db
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.cardName, entry.cardName),
          eq(inventoryItems.setName, entry.setName),
          eq(inventoryItems.game, entry.game),
          eq(inventoryItems.condition, entry.condition)
        )
      )
      .get();

    if (!existing) return;

    const costReduction = entry.quantity * existing.costBasisAvgPence;
    await upsertInventoryItem(d1, {
      cardName: entry.cardName,
      setName: entry.setName,
      game: entry.game,
      condition: entry.condition,
      category: entry.category,
      quantityDelta: -entry.quantity,
      costDeltaPence: -costReduction,
    });
  }
  // FEE, ADJUSTMENT, TRADE: no inventory quantity effect
}

export async function reverseInventoryFromLedger(
  d1: D1Database,
  entry: LedgerEntry
): Promise<void> {
  // Reverse the effect of a soft-deleted ledger entry
  if (entry.type === "PURCHASE" || entry.type === "PRIZE") {
    const db = drizzle(d1);
    const existing = await db
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.cardName, entry.cardName),
          eq(inventoryItems.setName, entry.setName),
          eq(inventoryItems.game, entry.game),
          eq(inventoryItems.condition, entry.condition)
        )
      )
      .get();

    if (!existing) return;

    const costReduction = entry.quantity * existing.costBasisAvgPence;
    await upsertInventoryItem(d1, {
      cardName: entry.cardName,
      setName: entry.setName,
      game: entry.game,
      condition: entry.condition,
      category: entry.category,
      quantityDelta: -entry.quantity,
      costDeltaPence: -costReduction,
    });
  } else if (entry.type === "SALE" || entry.type === "WRITE_OFF") {
    // Restoring sold/written-off quantity back to available
    await upsertInventoryItem(d1, {
      cardName: entry.cardName,
      setName: entry.setName,
      game: entry.game,
      condition: entry.condition,
      category: entry.category,
      quantityDelta: entry.quantity,
      costDeltaPence: entry.netAmountPence,
    });
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function getInventoryItem(
  d1: D1Database,
  id: string
): Promise<InventoryItem | null> {
  const db = drizzle(d1);
  const row = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.id, id))
    .get();
  return row ?? null;
}

export interface InventoryListParams {
  game?: string;
  set?: string;
  condition?: string;
  location?: string;
  page?: number;
  limit?: number;
}

export async function listInventory(
  d1: D1Database,
  params: InventoryListParams
): Promise<{ items: InventoryItem[]; total: number; page: number; limit: number }> {
  const db = drizzle(d1);
  const pageN = Math.max(1, params.page ?? 1);
  const limitN = Math.min(200, Math.max(1, params.limit ?? 50));
  const offset = (pageN - 1) * limitN;

  const conditions: SQL[] = [];
  if (params.game) conditions.push(eq(inventoryItems.game, params.game));
  if (params.set) conditions.push(eq(inventoryItems.setName, params.set));
  if (params.condition) conditions.push(eq(inventoryItems.condition, params.condition));
  if (params.location) conditions.push(eq(inventoryItems.location, params.location));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(inventoryItems)
      .where(where)
      .orderBy(inventoryItems.cardName)
      .limit(limitN)
      .offset(offset)
      .all(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(inventoryItems)
      .where(where)
      .get(),
  ]);

  return { items: rows, total: countRow?.count ?? 0, page: pageN, limit: limitN };
}

// ─── Status transitions ────────────────────────────────────────────────────────

const MUTABLE_STATUSES = ["LISTED", "RESERVED", "GRADING", "AVAILABLE"] as const;

export async function updateItemStatus(
  d1: D1Database,
  id: string,
  targetStatus: string,
  quantity?: number
): Promise<InventoryItem | null | { error: string }> {
  if (!MUTABLE_STATUSES.includes(targetStatus as typeof MUTABLE_STATUSES[number])) {
    return { error: `status must be one of: ${MUTABLE_STATUSES.join(", ")}` };
  }

  const item = await getInventoryItem(d1, id);
  if (!item) return null;

  const db = drizzle(d1);
  const timestamp = now();

  if (targetStatus === "LISTED") {
    const qty = quantity ?? item.quantityAvailable;
    if (item.quantityAvailable < qty) {
      return { error: `Only ${item.quantityAvailable} units available to list` };
    }
    await db
      .update(inventoryItems)
      .set({
        quantityAvailable: item.quantityAvailable - qty,
        quantityListed: item.quantityListed + qty,
        updatedAt: timestamp,
      })
      .where(eq(inventoryItems.id, id));
  } else if (targetStatus === "RESERVED") {
    const qty = quantity ?? item.quantityAvailable;
    if (item.quantityAvailable < qty) {
      return { error: `Only ${item.quantityAvailable} units available to reserve` };
    }
    await db
      .update(inventoryItems)
      .set({
        quantityAvailable: item.quantityAvailable - qty,
        quantityReserved: item.quantityReserved + qty,
        updatedAt: timestamp,
      })
      .where(eq(inventoryItems.id, id));
  } else if (targetStatus === "GRADING") {
    const qty = quantity ?? item.quantityAvailable;
    if (item.quantityAvailable < qty) {
      return { error: `Only ${item.quantityAvailable} units available to send to grading` };
    }
    await db
      .update(inventoryItems)
      .set({
        quantityAvailable: item.quantityAvailable - qty,
        quantityGrading: item.quantityGrading + qty,
        updatedAt: timestamp,
      })
      .where(eq(inventoryItems.id, id));
  } else if (targetStatus === "AVAILABLE") {
    // Return units from listed, reserved, or grading back to available
    let qty = quantity ?? (item.quantityListed + item.quantityReserved + item.quantityGrading);
    const fromListed = Math.min(qty, item.quantityListed);
    qty -= fromListed;
    const fromReserved = Math.min(qty, item.quantityReserved);
    qty -= fromReserved;
    const fromGrading = Math.min(qty, item.quantityGrading);
    qty -= fromGrading;

    if (qty > 0) {
      return { error: "Not enough non-available units to return to available" };
    }
    await db
      .update(inventoryItems)
      .set({
        quantityAvailable: item.quantityAvailable + fromListed + fromReserved + fromGrading,
        quantityListed: item.quantityListed - fromListed,
        quantityReserved: item.quantityReserved - fromReserved,
        quantityGrading: item.quantityGrading - fromGrading,
        updatedAt: timestamp,
      })
      .where(eq(inventoryItems.id, id));
  }

  return await getInventoryItem(d1, id);
}

// ─── Location update ──────────────────────────────────────────────────────────

export async function updateItemLocation(
  d1: D1Database,
  id: string,
  location: string
): Promise<InventoryItem | null | { error: string }> {
  if (!isValidEnum(location, VALID_LOCATIONS)) {
    return { error: `location must be one of: ${VALID_LOCATIONS.join(", ")}` };
  }

  const item = await getInventoryItem(d1, id);
  if (!item) return null;

  const db = drizzle(d1);
  await db
    .update(inventoryItems)
    .set({ location, updatedAt: now() })
    .where(eq(inventoryItems.id, id));

  return await getInventoryItem(d1, id);
}

// ─── Valuation ────────────────────────────────────────────────────────────────

export async function getValuation(d1: D1Database): Promise<{
  total_cost_basis_pence: number;
  total_market_value_pence: number | null;
  unrealised_pnl_pence: number | null;
  item_count: number;
  unit_count: number;
}> {
  const db = drizzle(d1);

  const row = await db
    .select({
      totalCost: sql<number>`sum(${inventoryItems.costBasisTotalPence})`,
      totalMarket: sql<number>`sum(${inventoryItems.marketValuePence} * ${inventoryItems.quantityTotal})`,
      itemCount: sql<number>`count(*)`,
      unitCount: sql<number>`sum(${inventoryItems.quantityTotal})`,
      marketNullCount: sql<number>`sum(case when ${inventoryItems.marketValuePence} is null then 1 else 0 end)`,
    })
    .from(inventoryItems)
    .get();

  const totalCost = row?.totalCost ?? 0;
  const totalMarket = row?.marketNullCount === 0 ? (row?.totalMarket ?? null) : null;

  return {
    total_cost_basis_pence: totalCost,
    total_market_value_pence: totalMarket,
    unrealised_pnl_pence: totalMarket !== null ? totalMarket - totalCost : null,
    item_count: row?.itemCount ?? 0,
    unit_count: row?.unitCount ?? 0,
  };
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

export async function reconcileInventory(d1: D1Database): Promise<{
  ok: boolean;
  discrepancies: Array<{
    id: string;
    cardName: string;
    quantityTotal: number;
    sumOfBuckets: number;
    diff: number;
  }>;
}> {
  const db = drizzle(d1);

  const rows = await db
    .select({
      id: inventoryItems.id,
      cardName: inventoryItems.cardName,
      quantityTotal: inventoryItems.quantityTotal,
      sumBuckets: sql<number>`(${inventoryItems.quantityAvailable} + ${inventoryItems.quantityListed} + ${inventoryItems.quantityReserved} + ${inventoryItems.quantityGrading})`,
    })
    .from(inventoryItems)
    .all();

  const discrepancies = rows
    .filter((r) => r.quantityTotal !== r.sumBuckets)
    .map((r) => ({
      id: r.id,
      cardName: r.cardName,
      quantityTotal: r.quantityTotal,
      sumOfBuckets: r.sumBuckets,
      diff: r.quantityTotal - r.sumBuckets,
    }));

  return { ok: discrepancies.length === 0, discrepancies };
}
