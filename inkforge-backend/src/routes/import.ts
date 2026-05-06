import { Hono } from "hono";
import { parseArticlesFile, parseOrdersFile, buildImportPreview } from "../services/cardmarket";
import { checkDuplicate, executeImport } from "../services/import";
import { hashFile } from "../services/cardmarket";
import { ok, err } from "../lib/types";
import type { Env } from "../index";

export const importRoutes = new Hono<{ Bindings: Env }>();

// In-memory staging store for previewed imports (keyed by session token).
// Workers are stateless across requests, so we use R2 to persist the staged data.
const STAGING_PREFIX = "import-staging/";

/**
 * POST /api/import/cardmarket/upload
 * Accepts multipart form with articles and orders .xls files.
 * Returns a preview and a staging_id — call /confirm with staging_id to commit.
 *
 * Form fields:
 *   articles: File (.xls)
 *   orders:   File (.xls)
 */
importRoutes.post("/cardmarket/upload", async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json(err("Request must be multipart/form-data with articles and orders files"), 400);
  }

  const articlesFile = formData.get("articles") as unknown as File | null;
  const ordersFile = formData.get("orders") as unknown as File | null;

  if (!articlesFile || typeof articlesFile.arrayBuffer !== "function" ||
      !ordersFile || typeof ordersFile.arrayBuffer !== "function") {
    return c.json(err("Both articles and orders files are required"), 400);
  }

  const articlesBuffer = await articlesFile.arrayBuffer();
  const ordersBuffer = await ordersFile.arrayBuffer();

  // Hash both files for deduplication
  const [articlesHash, ordersHash] = await Promise.all([
    hashFile(articlesBuffer),
    hashFile(ordersBuffer),
  ]);

  // Check for duplicate imports
  const [artDup, ordDup] = await Promise.all([
    checkDuplicate(c.env.DB, articlesHash),
    checkDuplicate(c.env.DB, ordersHash),
  ]);

  if (artDup.isDuplicate) {
    return c.json(
      err(`Articles file was already imported on ${artDup.importedAt}`),
      409
    );
  }
  if (ordDup.isDuplicate) {
    return c.json(
      err(`Orders file was already imported on ${ordDup.importedAt}`),
      409
    );
  }

  // Parse both files
  let articles, orders;
  try {
    articles = parseArticlesFile(articlesBuffer);
    orders = parseOrdersFile(ordersBuffer);
  } catch (e) {
    return c.json(
      err("Failed to parse files. Ensure both are Cardmarket .xls exports.", e instanceof Error ? e.message : e),
      422
    );
  }

  if (articles.length === 0) {
    return c.json(err("No articles found in the articles file"), 422);
  }

  const preview = buildImportPreview(articles, orders);

  // Stage the import data in R2 so /confirm can retrieve it without re-parsing
  const stagingId = crypto.randomUUID();
  const stagingPayload = JSON.stringify({
    preview,
    articlesHash,
    ordersHash,
    articlesFileName: articlesFile.name,
    ordersFileName: ordersFile.name,
  });
  await c.env.STORAGE.put(`${STAGING_PREFIX}${stagingId}`, stagingPayload, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: String(Date.now() + 30 * 60 * 1000) }, // 30 min TTL
  });

  return c.json(
    ok({
      staging_id: stagingId,
      preview: {
        orders_count: preview.ordersCount,
        line_items_count: preview.lineItemsCount,
        merchandise_total: (preview.merchandiseTotalPence / 100).toFixed(2),
        shipping_total: (preview.shippingTotalPence / 100).toFixed(2),
        trustee_fees_total: (preview.trusteeFeesTotalPence / 100).toFixed(2),
        grand_total: (preview.grandTotalPence / 100).toFixed(2),
        articles: preview.articles.map((a) => ({
          shipment_nr: a.shipmentNr,
          date: a.dateOfPurchase,
          card_name: a.articleName,
          expansion: a.expansion,
          amount: a.amount,
          unit_price: (a.articleValuePence / 100).toFixed(2),
          total: (a.totalPence / 100).toFixed(2),
        })),
      },
    })
  );
});

/**
 * POST /api/import/cardmarket/confirm
 * Commits a previously staged import.
 *
 * Body: { staging_id: string }
 */
importRoutes.post("/cardmarket/confirm", async (c) => {
  let body: { staging_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Request body must be JSON with staging_id"), 400);
  }

  const { staging_id } = body;
  if (!staging_id) {
    return c.json(err("staging_id is required"), 400);
  }

  // Retrieve staged data from R2
  const staged = await c.env.STORAGE.get(`${STAGING_PREFIX}${staging_id}`);
  if (!staged) {
    return c.json(err("Staging session not found or expired. Please re-upload."), 404);
  }

  const {
    preview,
    articlesHash,
    ordersHash,
    articlesFileName,
    ordersFileName,
  } = JSON.parse(await staged.text());

  // Clean up staging object
  await c.env.STORAGE.delete(`${STAGING_PREFIX}${staging_id}`);

  // Execute the import
  try {
    const result = await executeImport(
      c.env.DB,
      preview,
      articlesHash,
      ordersHash,
      articlesFileName,
      ordersFileName
    );

    return c.json(
      ok({
        entries_created: result.entriesCreated,
        fees_created: result.feesCreated,
        rows_skipped: result.rowsSkipped,
        sellers_upserted: result.sellersUpserted,
      })
    );
  } catch (e) {
    return c.json(
      err("Import failed during commit", e instanceof Error ? e.message : e),
      500
    );
  }
});

/**
 * GET /api/import/status
 * Lists recent imports from the import_logs table.
 */
importRoutes.get("/status", async (c) => {
  // Implemented fully in WP5 once the ledger engine provides query helpers.
  return c.json(ok({ message: "Import status — full listing available in WP5" }));
});
