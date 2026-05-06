import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { ledgerEntries, cardmarketSellers, importLogs, inventoryItems } from "../db/schema";
import { uuid, now, splitProportionally } from "../lib/utils";
import { lookupCard } from "./card-lookup";
import type { ParsedArticle, ParsedOrder, ImportPreview } from "./cardmarket";
import type { NewLedgerEntry, NewCardmarketSeller, NewImportLog } from "../db/schema";

// ─── Category mapping (Cardmarket → InkForge) ────────────────────────────────

function mapCategory(cmCategory: string): string {
  const lower = cmCategory.toLowerCase();
  if (lower.includes("booster box") || lower.includes("display")) return "sealed_box";
  if (lower.includes("booster")) return "sealed_booster";
  if (lower.includes("case")) return "sealed_case";
  if (lower.includes("memorabilia")) return "memorabilia";
  return "single";
}

function mapGame(cmCategory: string): string {
  const lower = cmCategory.toLowerCase();
  if (lower.includes("pokemon") || lower.includes("pokémon")) return "pokemon";
  if (lower.includes("magic") || lower.includes("mtg")) return "mtg";
  if (lower.includes("yugioh") || lower.includes("yu-gi-oh")) return "yugioh";
  if (lower.includes("one piece")) return "onepiece";
  return "lorcana"; // default for this business
}

// ─── Deduplication check ──────────────────────────────────────────────────────

export async function checkDuplicate(
  d1: D1Database,
  fileHash: string
): Promise<{ isDuplicate: boolean; importedAt?: string }> {
  const db = drizzle(d1);
  const existing = await db
    .select()
    .from(importLogs)
    .where(eq(importLogs.fileHash, fileHash))
    .get();

  if (existing) {
    return { isDuplicate: true, importedAt: existing.importedAt };
  }
  return { isDuplicate: false };
}

// ─── Row-level dedup (catches partial overlaps between monthly exports) ───────

async function isRowAlreadyImported(
  d1: D1Database,
  platformRef: string,
  productId: string,
  cardName: string,
  date: string
): Promise<boolean> {
  const db = drizzle(d1);

  // When productId is present, use it as the precise identifier.
  // When absent, fall back to platformRef + cardName + date to avoid
  // false misses caused by comparing "" against NULL in the DB.
  if (productId) {
    const existing = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.platformRef, platformRef),
          eq(ledgerEntries.productId, productId),
          eq(ledgerEntries.date, date),
          eq(ledgerEntries.platform, "cardmarket")
        )
      )
      .get();
    return !!existing;
  }

  // Fallback: no productId — match on platformRef + cardName + date
  const existing = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.platformRef, platformRef),
        eq(ledgerEntries.cardName, cardName),
        eq(ledgerEntries.date, date),
        eq(ledgerEntries.platform, "cardmarket")
      )
    )
    .get();
  return !!existing;
}

// ─── Upsert inventory ─────────────────────────────────────────────────────────

async function upsertInventory(
  d1: D1Database,
  article: ParsedArticle,
  costTotalPence: number,
  timestamp: string
): Promise<void> {
  const db = drizzle(d1);
  const game = mapGame(article.category);
  const category = mapCategory(article.category);

  const existing = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.cardName, article.articleName),
        eq(inventoryItems.setName, article.expansion),
        eq(inventoryItems.game, game),
        eq(inventoryItems.condition, "NM")
      )
    )
    .get();

  if (existing) {
    const newTotal = existing.quantityTotal + article.amount;
    const newCostTotal = existing.costBasisTotalPence + costTotalPence;
    const newAvg = Math.round(newCostTotal / newTotal);

    await db
      .update(inventoryItems)
      .set({
        quantityTotal: newTotal,
        quantityAvailable: existing.quantityAvailable + article.amount,
        costBasisTotalPence: newCostTotal,
        costBasisAvgPence: newAvg,
        lastAcquired: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(inventoryItems.id, existing.id));
  } else {
    await db.insert(inventoryItems).values({
      id: uuid(),
      cardName: article.articleName,
      setName: article.expansion,
      game,
      productId: article.productId || null,
      collectorNumber: null, // populated by WP3 card lookup
      category,
      condition: "NM",
      quantityTotal: article.amount,
      quantityAvailable: article.amount,
      quantityListed: 0,
      quantityReserved: 0,
      quantityGrading: 0,
      costBasisTotalPence: costTotalPence,
      costBasisAvgPence: Math.round(costTotalPence / article.amount),
      marketValuePence: null,
      location: null,
      firstAcquired: timestamp,
      lastAcquired: timestamp,
      updatedAt: timestamp,
    });
  }
}

// ─── Core import function ─────────────────────────────────────────────────────

export interface ImportResult {
  entriesCreated: number;
  feesCreated: number;
  rowsSkipped: number;
  sellersUpserted: number;
}

export async function executeImport(
  d1: D1Database,
  preview: ImportPreview,
  articlesHash: string,
  ordersHash: string,
  articlesFileName: string,
  ordersFileName: string
): Promise<ImportResult> {
  const db = drizzle(d1);
  const timestamp = now();
  let entriesCreated = 0;
  let feesCreated = 0;
  let rowsSkipped = 0;
  let sellersUpserted = 0;

  // Build order lookup map
  const orderMap = new Map<string, ParsedOrder>();
  for (const order of preview.orders) {
    orderMap.set(order.orderId, order);
  }

  // Group articles by shipment number
  const articlesByShipment = new Map<string, ParsedArticle[]>();
  for (const article of preview.articles) {
    const group = articlesByShipment.get(article.shipmentNr) ?? [];
    group.push(article);
    articlesByShipment.set(article.shipmentNr, group);
  }

  // Collect unique card+set combinations for card lookup after all DB writes
  const uniqueCards = new Map<string, { cardName: string; setName: string; game: string }>();

  // Process each shipment
  for (const [shipmentNr, articles] of articlesByShipment) {
    const order = orderMap.get(shipmentNr);
    const shippingPence = order?.shipmentCostsPence ?? 0;
    const trusteeFeesPence = order?.trusteeFeesPence ?? 0;

    // Split shipping proportionally across items by article value
    const itemValues = articles.map((a) => a.totalPence);
    const shippingPerItem = splitProportionally(shippingPence, itemValues);

    // Upsert seller
    if (order && order.username) {
      const existingSeller = await db
        .select()
        .from(cardmarketSellers)
        .where(eq(cardmarketSellers.username, order.username))
        .get();

      if (existingSeller) {
        await db
          .update(cardmarketSellers)
          .set({
            totalOrders: existingSeller.totalOrders + 1,
            totalSpendPence: existingSeller.totalSpendPence + (order.totalValuePence ?? 0),
            updatedAt: timestamp,
          })
          .where(eq(cardmarketSellers.id, existingSeller.id));
      } else {
        const seller: NewCardmarketSeller = {
          id: uuid(),
          username: order.username,
          country: order.country || null,
          isProfessional: order.isProfessional,
          vatNumber: order.vatNumber,
          firstPurchaseDate: articles[0]?.dateOfPurchase ?? timestamp,
          totalOrders: 1,
          totalSpendPence: order.totalValuePence ?? 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await db.insert(cardmarketSellers).values(seller);
        sellersUpserted++;
      }
    }

    // Process each article in the shipment
    let shipmentItemsInserted = 0;
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i]!;
      const itemShippingPence = shippingPerItem[i] ?? 0;
      const netCostPence = article.totalPence + itemShippingPence;

      // Row-level dedup
      const alreadyImported = await isRowAlreadyImported(
        d1,
        shipmentNr,
        article.productId,
        article.articleName,
        article.dateOfPurchase
      );

      if (alreadyImported) {
        rowsSkipped++;
        continue;
      }

      const game = mapGame(article.category);
      const category = mapCategory(article.category);

      const entry: NewLedgerEntry = {
        id: uuid(),
        date: article.dateOfPurchase,
        type: "PURCHASE",
        platform: "cardmarket",
        platformRef: shipmentNr,
        cardName: article.articleName,
        setName: article.expansion,
        game,
        productId: article.productId || null,
        collectorNumber: null, // populated async by card lookup
        category,
        quantity: article.amount,
        unitPricePence: article.articleValuePence,
        totalPricePence: article.totalPence,
        shippingCostPence: itemShippingPence,
        platformFeesPence: null,
        otherCostsPence: null,
        netAmountPence: netCostPence,
        condition: "NM",
        gradeCompany: null,
        gradeValue: null,
        currencyOriginal: article.currency !== "GBP" ? article.currency : null,
        currencyRate: null,
        notes: article.comments || null,
        bundleId: articles.length > 1 ? shipmentNr : null,
        marketValueAtAcquisitionPence: null,
        source: "cardmarket_import",
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await db.insert(ledgerEntries).values(entry);
      entriesCreated++;
      shipmentItemsInserted++;

      // Update inventory
      await upsertInventory(d1, article, netCostPence, timestamp);

      // Queue unique card for lookup after all DB writes are done
      const cardKey = `${article.articleName}||${article.expansion}||${game}`;
      if (!uniqueCards.has(cardKey)) {
        uniqueCards.set(cardKey, { cardName: article.articleName, setName: article.expansion, game });
      }
    }

    // Create FEE entry for trustee service fee (one per order, only if new articles were inserted)
    if (trusteeFeesPence > 0 && shipmentItemsInserted > 0) {
      const feeEntry: NewLedgerEntry = {
        id: uuid(),
        date: articles[0]?.dateOfPurchase ?? timestamp,
        type: "FEE",
        platform: "cardmarket",
        platformRef: shipmentNr,
        cardName: "Trustee Service Fee",
        setName: "N/A",
        game: "other",
        productId: null,
        collectorNumber: null,
        category: "accessory",
        quantity: 1,
        unitPricePence: trusteeFeesPence,
        totalPricePence: trusteeFeesPence,
        shippingCostPence: null,
        platformFeesPence: trusteeFeesPence,
        otherCostsPence: null,
        netAmountPence: trusteeFeesPence,
        condition: "NM",
        gradeCompany: null,
        gradeValue: null,
        currencyOriginal: null,
        currencyRate: null,
        notes: `Cardmarket trustee service fee for order ${shipmentNr}`,
        bundleId: null,
        marketValueAtAcquisitionPence: null,
        source: "cardmarket_import",
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await db.insert(ledgerEntries).values(feeEntry);
      feesCreated++;
    }
  }

  // Trigger card lookups for all unique cards encountered in this import.
  // Run sequentially (rate-limited inside lookupCard) after all DB writes.
  // Best-effort: failures are swallowed so they don't roll back a successful import.
  for (const card of uniqueCards.values()) {
    await lookupCard(d1, card.cardName, card.setName, card.game).catch(() => {});
  }

  // Write import log entries to prevent re-import
  const articlesLog: NewImportLog = {
    id: uuid(),
    fileName: articlesFileName,
    fileHash: articlesHash,
    fileType: "articles",
    rowsProcessed: entriesCreated,
    rowsSkipped,
    importedAt: timestamp,
    importedBy: "owner",
  };
  const ordersLog: NewImportLog = {
    id: uuid(),
    fileName: ordersFileName,
    fileHash: ordersHash,
    fileType: "orders",
    rowsProcessed: preview.orders.length,
    rowsSkipped: 0,
    importedAt: timestamp,
    importedBy: "owner",
  };

  await db.insert(importLogs).values(articlesLog);
  await db.insert(importLogs).values(ordersLog);

  return { entriesCreated, feesCreated, rowsSkipped, sellersUpserted };
}
