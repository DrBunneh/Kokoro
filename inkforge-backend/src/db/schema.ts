import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── ledger_entries ───────────────────────────────────────────────────────────
// Single source of truth for all financial transactions.
// All monetary values stored as integers in pence (£8.48 → 848).

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id:                  text("id").primaryKey(),
    date:                text("date").notNull(),
    type:                text("type").notNull(),                 // TransactionType
    platform:            text("platform").notNull(),             // Platform
    platformRef:         text("platform_ref"),
    cardName:            text("card_name").notNull(),
    setName:             text("set_name").notNull(),
    game:                text("game").notNull(),                  // Game
    productId:           text("product_id"),
    collectorNumber:     text("collector_number"),
    category:            text("category").notNull(),             // Category
    quantity:            integer("quantity").notNull(),
    unitPricePence:      integer("unit_price_pence").notNull(),
    totalPricePence:     integer("total_price_pence").notNull(), // quantity × unit_price
    shippingCostPence:   integer("shipping_cost_pence"),
    platformFeesPence:   integer("platform_fees_pence"),
    otherCostsPence:     integer("other_costs_pence"),
    netAmountPence:      integer("net_amount_pence").notNull(),  // auto-calculated
    condition:           text("condition").notNull().default("NM"), // Condition
    gradeCompany:        text("grade_company"),
    gradeValue:          text("grade_value"),
    currencyOriginal:    text("currency_original"),
    currencyRate:        integer("currency_rate"),               // stored as rate × 10000 for precision
    notes:               text("notes"),
    bundleId:            text("bundle_id"),
    marketValueAtAcquisitionPence: integer("market_value_at_acquisition_pence"), // PRIZE entries: market value at time of acquisition (COGS is £0)
    source:              text("source").notNull().default("manual"), // LedgerEntrySource
    deletedAt:           text("deleted_at"),                    // soft delete for HMRC audit trail
    createdAt:           text("created_at").notNull(),
    updatedAt:           text("updated_at").notNull(),
  },
  (t) => [
    index("ledger_date_idx").on(t.date),
    index("ledger_platform_idx").on(t.platform),
    index("ledger_card_idx").on(t.cardName),
    index("ledger_set_idx").on(t.setName),
    index("ledger_game_idx").on(t.game),
    index("ledger_type_idx").on(t.type),
    index("ledger_bundle_idx").on(t.bundleId),
    index("ledger_source_idx").on(t.source),
    index("ledger_platform_ref_idx").on(t.platformRef),
  ]
);

// ─── inventory_items ──────────────────────────────────────────────────────────
// Current physical stock. Derived from ledger events but maintained separately
// because it carries attributes the ledger doesn't (location, status, listing state).
// Constraint: quantity_total = quantity_available + quantity_listed + quantity_reserved + quantity_grading

export const inventoryItems = sqliteTable(
  "inventory_items",
  {
    id:                    text("id").primaryKey(),
    cardName:              text("card_name").notNull(),
    setName:               text("set_name").notNull(),
    game:                  text("game").notNull(),
    productId:             text("product_id"),
    collectorNumber:       text("collector_number"),
    category:              text("category").notNull(),
    condition:             text("condition").notNull().default("NM"),
    gradeCompany:          text("grade_company"),
    gradeValue:            text("grade_value"),
    quantityTotal:         integer("quantity_total").notNull().default(0),
    quantityAvailable:     integer("quantity_available").notNull().default(0),
    quantityListed:        integer("quantity_listed").notNull().default(0),
    quantityReserved:      integer("quantity_reserved").notNull().default(0),
    quantityGrading:       integer("quantity_grading").notNull().default(0),
    costBasisAvgPence:     integer("cost_basis_avg_pence").notNull().default(0), // weighted avg per unit
    costBasisTotalPence:   integer("cost_basis_total_pence").notNull().default(0),
    marketValuePence:      integer("market_value_current_pence"),                // populated in Phase 3
    location:              text("location"),                                      // InventoryLocation
    firstAcquired:         text("first_acquired").notNull(),
    lastAcquired:          text("last_acquired").notNull(),
    updatedAt:             text("updated_at").notNull(),
  },
  (t) => [
    index("inventory_card_idx").on(t.cardName),
    index("inventory_set_idx").on(t.setName),
    index("inventory_game_idx").on(t.game),
    index("inventory_condition_idx").on(t.condition),
    index("inventory_location_idx").on(t.location),
    // Composite unique: one row per card+set+game+condition combination
    uniqueIndex("inventory_unique_item_idx").on(t.cardName, t.setName, t.game, t.condition),
  ]
);

// ─── market_data_records ──────────────────────────────────────────────────────
// External pricing research. Never touches the ledger or modifies inventory quantities.

export const marketDataRecords = sqliteTable(
  "market_data_records",
  {
    id:              text("id").primaryKey(),
    cardName:        text("card_name").notNull(),
    setName:         text("set_name").notNull(),
    game:            text("game").notNull(),
    source:          text("source").notNull(),         // MarketDataSource
    pricePence:      integer("price_pence").notNull(),
    shippingPence:   integer("shipping_pence"),
    condition:       text("condition"),
    listingType:     text("listing_type").notNull(),   // ListingType
    dateSold:        text("date_sold"),
    dateCaptured:    text("date_captured").notNull(),
    graded:          integer("graded", { mode: "boolean" }).notNull().default(false),
    gradeCompany:    text("grade_company"),
    gradeValue:      text("grade_value"),
    sellerName:      text("seller_name"),
    captureMethod:   text("capture_method").notNull(), // CaptureMethod
    createdAt:       text("created_at").notNull(),
  },
  (t) => [
    index("market_card_idx").on(t.cardName),
    index("market_set_idx").on(t.setName),
    index("market_source_idx").on(t.source),
    index("market_date_sold_idx").on(t.dateSold),
    index("market_listing_type_idx").on(t.listingType),
  ]
);

// ─── price_alerts ─────────────────────────────────────────────────────────────
// User-configured alerts. Logic implemented in Phase 3.

export const priceAlerts = sqliteTable(
  "price_alerts",
  {
    id:               text("id").primaryKey(),
    cardName:         text("card_name"),
    setName:          text("set_name"),
    game:             text("game"),
    alertType:        text("alert_type").notNull(),     // AlertType
    thresholdValue:   integer("threshold_value").notNull(),
    thresholdUnit:    text("threshold_unit").notNull(), // "percent" | "pence"
    enabled:          integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastTriggered:    text("last_triggered"),
    channel:          text("channel").notNull().default("in_app"), // AlertChannel
    createdAt:        text("created_at").notNull(),
  }
);

// ─── saved_searches ───────────────────────────────────────────────────────────
// eBay saved search URLs for scheduled market data capture. Logic in Phase 3.

export const savedSearches = sqliteTable(
  "saved_searches",
  {
    id:               text("id").primaryKey(),
    label:            text("label").notNull(),
    url:              text("url").notNull(),
    platform:         text("platform").notNull(),
    frequencyMinutes: integer("frequency_minutes").notNull().default(120),
    lastCaptured:     text("last_captured"),
    enabled:          integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt:        text("created_at").notNull(),
  }
);

// ─── card_data_cache ──────────────────────────────────────────────────────────
// Cached Lorcana card metadata from external APIs (lorcast, api-lorcana.com).
// Populated in WP3. User never manually maintains this.

export const cardDataCache = sqliteTable(
  "card_data_cache",
  {
    id:                   text("id").primaryKey(),
    cardName:             text("card_name").notNull(),
    setName:              text("set_name").notNull(),
    setCode:              text("set_code"),
    collectorNumber:      text("collector_number"),
    game:                 text("game").notNull().default("lorcana"),
    rarity:               text("rarity"),
    inkCost:              integer("ink_cost"),
    inkColor:             text("ink_color"),
    cardType:             text("card_type"),
    imageUrl:             text("image_url"),
    cardmarketProductId:  text("cardmarket_product_id"),
    lorcanaApiId:         text("lorcana_api_id"),
    lorcastId:            text("lorcast_id"),
    lastRefreshed:        text("last_refreshed").notNull(),
    createdAt:            text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("cache_card_set_game_idx").on(t.cardName, t.setName, t.game),
    index("cache_product_id_idx").on(t.cardmarketProductId),
  ]
);

// ─── cardmarket_sellers ───────────────────────────────────────────────────────
// Seller info extracted from Cardmarket order imports.

export const cardmarketSellers = sqliteTable(
  "cardmarket_sellers",
  {
    id:                text("id").primaryKey(),
    username:          text("username").notNull().unique(),
    country:           text("country"),
    isProfessional:    integer("is_professional", { mode: "boolean" }).notNull().default(false),
    vatNumber:         text("vat_number"),
    firstPurchaseDate: text("first_purchase_date"),
    totalOrders:       integer("total_orders").notNull().default(0),
    totalSpendPence:   integer("total_spend_pence").notNull().default(0),
    createdAt:         text("created_at").notNull(),
    updatedAt:         text("updated_at").notNull(),
  }
);

// ─── import_logs ──────────────────────────────────────────────────────────────
// Tracks which Cardmarket export files have been imported to prevent duplicates.

export const importLogs = sqliteTable(
  "import_logs",
  {
    id:             text("id").primaryKey(),
    fileName:       text("file_name").notNull(),
    fileHash:       text("file_hash").notNull(),   // SHA-256 of file contents
    fileType:       text("file_type").notNull(),   // "articles" | "orders"
    rowsProcessed:  integer("rows_processed").notNull().default(0),
    rowsSkipped:    integer("rows_skipped").notNull().default(0),
    importedAt:     text("imported_at").notNull(),
    importedBy:     text("imported_by").default("owner"),
  },
  (t) => [
    uniqueIndex("import_hash_idx").on(t.fileHash),
  ]
);

// ─── Type exports for use in services ────────────────────────────────────────

export type LedgerEntry        = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry     = typeof ledgerEntries.$inferInsert;
export type InventoryItem      = typeof inventoryItems.$inferSelect;
export type NewInventoryItem   = typeof inventoryItems.$inferInsert;
export type MarketDataRecord   = typeof marketDataRecords.$inferSelect;
export type NewMarketDataRecord = typeof marketDataRecords.$inferInsert;
export type CardDataCache      = typeof cardDataCache.$inferSelect;
export type NewCardDataCache   = typeof cardDataCache.$inferInsert;
export type CardmarketSeller   = typeof cardmarketSellers.$inferSelect;
export type NewCardmarketSeller = typeof cardmarketSellers.$inferInsert;
export type ImportLog          = typeof importLogs.$inferSelect;
export type NewImportLog       = typeof importLogs.$inferInsert;
