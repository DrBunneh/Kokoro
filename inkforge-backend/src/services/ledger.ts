import { drizzle } from "drizzle-orm/d1";
import { eq, and, gte, lte, desc, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { ledgerEntries } from "../db/schema";
import { uuid, now, taxYearRange, isValidEnum } from "../lib/utils";
import { upsertInventoryFromLedger, reverseInventoryFromLedger } from "./inventory";
import type { NewLedgerEntry, LedgerEntry } from "../db/schema";
import type { TransactionType, Platform, Game, Category, Condition } from "../lib/types";

// ─── Valid enum sets ───────────────────────────────────────────────────────────

const VALID_TYPES = ["PURCHASE", "SALE", "FEE", "WRITE_OFF", "TRADE", "ADJUSTMENT", "PRIZE"] as const;
const VALID_PLATFORMS = ["ebay_uk", "cardmarket", "vinted", "in_person", "online_store", "other"] as const;
const VALID_GAMES = ["lorcana", "pokemon", "mtg", "yugioh", "onepiece", "other"] as const;
const VALID_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG", "SEALED", "GRADED"] as const;
const VALID_CATEGORIES = ["single", "sealed_booster", "sealed_box", "sealed_case", "memorabilia", "accessory", "bundle"] as const;

// ─── Net amount calculation ────────────────────────────────────────────────────

function calculateNetAmount(
  type: TransactionType,
  totalPricePence: number,
  shippingCostPence: number,
  platformFeesPence: number,
  otherCostsPence: number
): number {
  const costs = shippingCostPence + platformFeesPence + otherCostsPence;
  if (type === "SALE") return totalPricePence - costs;
  if (type === "PURCHASE") return totalPricePence + costs;
  return totalPricePence; // FEE, WRITE_OFF, ADJUSTMENT, PRIZE, TRADE
}

// ─── Input shape (snake_case from HTTP body) ──────────────────────────────────

export interface LedgerEntryInput {
  date: string;
  type: string;
  platform: string;
  platform_ref?: string | null;
  card_name: string;
  set_name: string;
  game: string;
  product_id?: string | null;
  collector_number?: string | null;
  category: string;
  quantity: number;
  unit_price_pence: number;
  total_price_pence?: number;
  shipping_cost_pence?: number;
  platform_fees_pence?: number;
  other_costs_pence?: number;
  condition?: string;
  grade_company?: string | null;
  grade_value?: string | null;
  currency_original?: string | null;
  currency_rate?: number | null;
  notes?: string | null;
  bundle_id?: string | null;
  market_value_at_acquisition_pence?: number | null;
  source?: string;
}

export interface TradeInput extends LedgerEntryInput {
  received_card_name?: string;
  received_set_name?: string;
  received_game?: string;
  received_category?: string;
  received_quantity?: number;
  received_unit_price_pence?: number;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateInput(body: Partial<LedgerEntryInput>): string | null {
  if (!body.card_name || !body.card_name.trim()) return "card_name is required";
  if (!body.set_name || !body.set_name.trim()) return "set_name is required";
  if (!body.date) return "date is required";
  if (isNaN(Date.parse(body.date))) return "date must be a valid ISO 8601 string";
  if (!isValidEnum(body.type, VALID_TYPES)) return `type must be one of: ${VALID_TYPES.join(", ")}`;
  if (!isValidEnum(body.platform, VALID_PLATFORMS)) return `platform must be one of: ${VALID_PLATFORMS.join(", ")}`;
  if (!isValidEnum(body.game, VALID_GAMES)) return `game must be one of: ${VALID_GAMES.join(", ")}`;
  if (!isValidEnum(body.category, VALID_CATEGORIES)) return `category must be one of: ${VALID_CATEGORIES.join(", ")}`;
  if (body.condition !== undefined && body.condition !== null && body.condition !== "" &&
      !isValidEnum(body.condition, VALID_CONDITIONS)) {
    return `condition must be one of: ${VALID_CONDITIONS.join(", ")}`;
  }
  if (!Number.isInteger(body.quantity) || (body.quantity ?? 0) < 1) return "quantity must be a positive integer";
  if (!Number.isInteger(body.unit_price_pence) || (body.unit_price_pence ?? -1) < 0) {
    return "unit_price_pence must be a non-negative integer (pence)";
  }
  return null;
}

// ─── Build a NewLedgerEntry from validated input ──────────────────────────────

function buildEntry(
  body: LedgerEntryInput,
  overrides: Partial<NewLedgerEntry> = {}
): NewLedgerEntry {
  const type = body.type as TransactionType;
  const totalPricePence = body.total_price_pence ?? body.quantity * body.unit_price_pence;
  const shippingCostPence = body.shipping_cost_pence ?? 0;
  const platformFeesPence = body.platform_fees_pence ?? 0;
  const otherCostsPence = body.other_costs_pence ?? 0;
  const netAmountPence = calculateNetAmount(type, totalPricePence, shippingCostPence, platformFeesPence, otherCostsPence);
  const timestamp = now();

  return {
    id: uuid(),
    date: body.date,
    type,
    platform: body.platform as Platform,
    platformRef: body.platform_ref ?? null,
    cardName: body.card_name.trim(),
    setName: body.set_name.trim(),
    game: body.game as Game,
    productId: body.product_id ?? null,
    collectorNumber: body.collector_number ?? null,
    category: body.category as Category,
    quantity: body.quantity,
    unitPricePence: body.unit_price_pence,
    totalPricePence,
    shippingCostPence: shippingCostPence || null,
    platformFeesPence: platformFeesPence || null,
    otherCostsPence: otherCostsPence || null,
    netAmountPence,
    condition: (body.condition as Condition) || "NM",
    gradeCompany: body.grade_company ?? null,
    gradeValue: body.grade_value ?? null,
    currencyOriginal: body.currency_original ?? null,
    currencyRate: body.currency_rate ?? null,
    notes: body.notes ?? null,
    bundleId: body.bundle_id ?? null,
    marketValueAtAcquisitionPence: body.market_value_at_acquisition_pence ?? null,
    source: body.source ?? "manual",
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

// ─── CRUD operations ──────────────────────────────────────────────────────────

export async function createEntry(
  d1: D1Database,
  body: Partial<LedgerEntryInput>
): Promise<{ entry: LedgerEntry } | { error: string }> {
  const error = validateInput(body);
  if (error) return { error };

  const row = buildEntry(body as LedgerEntryInput);
  const db = drizzle(d1);
  await db.insert(ledgerEntries).values(row);
  const created = await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, row.id)).get();
  await upsertInventoryFromLedger(d1, created!);
  return { entry: created! };
}

export async function createTradeEntries(
  d1: D1Database,
  body: Partial<TradeInput>
): Promise<{ entries: LedgerEntry[] } | { error: string }> {
  if (body.type !== "TRADE") return { error: "type must be TRADE for trade creation" };

  const error = validateInput(body);
  if (error) return { error };

  const db = drizzle(d1);
  const sharedBundleId = body.bundle_id ?? uuid();
  const timestamp = now();

  const givenTotal = (body.total_price_pence ?? (body.quantity! * body.unit_price_pence!));

  // Card given away → SALE at market value
  const saleRow = buildEntry(body as LedgerEntryInput, {
    id: uuid(),
    type: "SALE",
    totalPricePence: givenTotal,
    shippingCostPence: null,
    platformFeesPence: null,
    otherCostsPence: null,
    netAmountPence: givenTotal,
    notes: body.notes ? `Trade: ${body.notes}` : "Trade",
    bundleId: sharedBundleId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  // Card received → PURCHASE at market value
  const receivedQty = body.received_quantity ?? body.quantity!;
  const receivedUnitPrice = body.received_unit_price_pence ?? body.unit_price_pence!;
  const receivedTotal = receivedQty * receivedUnitPrice;

  const purchaseRow: NewLedgerEntry = {
    id: uuid(),
    date: body.date!,
    type: "PURCHASE",
    platform: body.platform as Platform,
    platformRef: body.platform_ref ?? null,
    cardName: (body.received_card_name ?? body.card_name!).trim(),
    setName: (body.received_set_name ?? body.set_name!).trim(),
    game: (body.received_game ?? body.game) as Game,
    productId: null,
    collectorNumber: null,
    category: (body.received_category ?? body.category) as Category,
    quantity: receivedQty,
    unitPricePence: receivedUnitPrice,
    totalPricePence: receivedTotal,
    shippingCostPence: null,
    platformFeesPence: null,
    otherCostsPence: null,
    netAmountPence: receivedTotal,
    condition: "NM",
    gradeCompany: null,
    gradeValue: null,
    currencyOriginal: null,
    currencyRate: null,
    notes: body.notes ? `Trade: ${body.notes}` : "Trade",
    bundleId: sharedBundleId,
    marketValueAtAcquisitionPence: null,
    source: body.source ?? "manual",
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await db.insert(ledgerEntries).values(saleRow);
  await db.insert(ledgerEntries).values(purchaseRow);

  const [sale, purchase] = await Promise.all([
    db.select().from(ledgerEntries).where(eq(ledgerEntries.id, saleRow.id)).get(),
    db.select().from(ledgerEntries).where(eq(ledgerEntries.id, purchaseRow.id)).get(),
  ]);
  return { entries: [sale!, purchase!] };
}

export async function getEntry(d1: D1Database, id: string): Promise<LedgerEntry | null> {
  const db = drizzle(d1);
  const row = await db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.id, id), isNull(ledgerEntries.deletedAt)))
    .get();
  return row ?? null;
}

export async function updateEntry(
  d1: D1Database,
  id: string,
  body: Partial<LedgerEntryInput>
): Promise<{ entry: LedgerEntry } | { error: string } | null> {
  const existing = await getEntry(d1, id);
  if (!existing) return null;

  // Merge with existing so validation sees a complete record
  const merged: Partial<LedgerEntryInput> = {
    card_name: existing.cardName,
    set_name: existing.setName,
    date: existing.date,
    type: existing.type,
    platform: existing.platform,
    game: existing.game,
    category: existing.category,
    quantity: existing.quantity,
    unit_price_pence: existing.unitPricePence,
    condition: existing.condition,
    ...body,
  };

  const error = validateInput(merged);
  if (error) return { error };

  const type = (body.type ?? existing.type) as TransactionType;
  const quantity = body.quantity ?? existing.quantity;
  const unitPrice = body.unit_price_pence ?? existing.unitPricePence;
  const totalPricePence = body.total_price_pence ?? quantity * unitPrice;
  const shippingCostPence = body.shipping_cost_pence ?? existing.shippingCostPence ?? 0;
  const platformFeesPence = body.platform_fees_pence ?? existing.platformFeesPence ?? 0;
  const otherCostsPence = body.other_costs_pence ?? existing.otherCostsPence ?? 0;
  const netAmountPence = calculateNetAmount(type, totalPricePence, shippingCostPence, platformFeesPence, otherCostsPence);

  const db = drizzle(d1);
  await db
    .update(ledgerEntries)
    .set({
      date: body.date ?? existing.date,
      type,
      platform: (body.platform ?? existing.platform) as Platform,
      platformRef: "platform_ref" in body ? (body.platform_ref ?? null) : existing.platformRef,
      cardName: body.card_name?.trim() ?? existing.cardName,
      setName: body.set_name?.trim() ?? existing.setName,
      game: (body.game ?? existing.game) as Game,
      productId: "product_id" in body ? (body.product_id ?? null) : existing.productId,
      collectorNumber: "collector_number" in body ? (body.collector_number ?? null) : existing.collectorNumber,
      category: (body.category ?? existing.category) as Category,
      quantity,
      unitPricePence: unitPrice,
      totalPricePence,
      shippingCostPence: shippingCostPence || null,
      platformFeesPence: platformFeesPence || null,
      otherCostsPence: otherCostsPence || null,
      netAmountPence,
      condition: (body.condition ?? existing.condition) as Condition,
      gradeCompany: "grade_company" in body ? (body.grade_company ?? null) : existing.gradeCompany,
      gradeValue: "grade_value" in body ? (body.grade_value ?? null) : existing.gradeValue,
      currencyOriginal: "currency_original" in body ? (body.currency_original ?? null) : existing.currencyOriginal,
      currencyRate: "currency_rate" in body ? (body.currency_rate ?? null) : existing.currencyRate,
      notes: "notes" in body ? (body.notes ?? null) : existing.notes,
      bundleId: "bundle_id" in body ? (body.bundle_id ?? null) : existing.bundleId,
      marketValueAtAcquisitionPence:
        "market_value_at_acquisition_pence" in body
          ? (body.market_value_at_acquisition_pence ?? null)
          : existing.marketValueAtAcquisitionPence,
      updatedAt: now(),
    })
    .where(eq(ledgerEntries.id, id));

  const updated = await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id)).get();
  return { entry: updated! };
}

export async function deleteEntry(d1: D1Database, id: string): Promise<boolean> {
  const existing = await getEntry(d1, id);
  if (!existing) return false;

  const db = drizzle(d1);
  await db
    .update(ledgerEntries)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(ledgerEntries.id, id));
  await reverseInventoryFromLedger(d1, existing);
  return true;
}

// ─── Listing with filters ─────────────────────────────────────────────────────

export interface ListParams {
  from?: string;
  to?: string;
  platform?: string;
  game?: string;
  set?: string;
  type?: string;
  tax_year?: number;
  page?: number;
  limit?: number;
}

export async function listEntries(
  d1: D1Database,
  params: ListParams
): Promise<{ entries: LedgerEntry[]; total: number; page: number; limit: number }> {
  const db = drizzle(d1);
  const pageN = Math.max(1, params.page ?? 1);
  const limitN = Math.min(200, Math.max(1, params.limit ?? 50));
  const offset = (pageN - 1) * limitN;

  let from = params.from;
  let to = params.to;
  if (params.tax_year) {
    const range = taxYearRange(params.tax_year);
    from = range.from;
    to = range.to;
  }

  const conditions: SQL[] = [isNull(ledgerEntries.deletedAt)];
  if (from) conditions.push(gte(ledgerEntries.date, from));
  if (to) conditions.push(lte(ledgerEntries.date, to));
  if (params.platform && isValidEnum(params.platform, VALID_PLATFORMS)) {
    conditions.push(eq(ledgerEntries.platform, params.platform));
  }
  if (params.game && isValidEnum(params.game, VALID_GAMES)) {
    conditions.push(eq(ledgerEntries.game, params.game));
  }
  if (params.set) {
    conditions.push(eq(ledgerEntries.setName, params.set));
  }
  if (params.type && isValidEnum(params.type, VALID_TYPES)) {
    conditions.push(eq(ledgerEntries.type, params.type));
  }

  const where = and(...conditions);

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(ledgerEntries)
      .where(where)
      .orderBy(desc(ledgerEntries.date))
      .limit(limitN)
      .offset(offset)
      .all(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(ledgerEntries)
      .where(where)
      .get(),
  ]);

  return { entries: rows, total: countRow?.count ?? 0, page: pageN, limit: limitN };
}

// ─── P&L summary ──────────────────────────────────────────────────────────────

export async function summariseEntries(
  d1: D1Database,
  params: Pick<ListParams, "from" | "to" | "tax_year">
): Promise<{
  total_income_pence: number;
  total_expenses_pence: number;
  net_pnl_pence: number;
  entries_count: number;
}> {
  const db = drizzle(d1);

  let from = params.from;
  let to = params.to;
  if (params.tax_year) {
    const range = taxYearRange(params.tax_year);
    from = range.from;
    to = range.to;
  }

  const conditions: SQL[] = [isNull(ledgerEntries.deletedAt)];
  if (from) conditions.push(gte(ledgerEntries.date, from));
  if (to) conditions.push(lte(ledgerEntries.date, to));

  const rows = await db
    .select({
      type: ledgerEntries.type,
      netSum: sql<number>`sum(${ledgerEntries.netAmountPence})`,
      count: sql<number>`count(*)`,
    })
    .from(ledgerEntries)
    .where(and(...conditions))
    .groupBy(ledgerEntries.type)
    .all();

  let total_income_pence = 0;
  let total_expenses_pence = 0;
  let entries_count = 0;

  for (const row of rows) {
    const amount = row.netSum ?? 0;
    entries_count += row.count ?? 0;
    if (row.type === "SALE") {
      total_income_pence += amount;
    } else if (row.type === "PURCHASE" || row.type === "FEE" || row.type === "WRITE_OFF") {
      total_expenses_pence += amount;
    }
  }

  return {
    total_income_pence,
    total_expenses_pence,
    net_pnl_pence: total_income_pence - total_expenses_pence,
    entries_count,
  };
}
