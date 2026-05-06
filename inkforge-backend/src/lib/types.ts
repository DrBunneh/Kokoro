// ─── Transaction Types ────────────────────────────────────────────────────────

export type TransactionType =
  | "PURCHASE"
  | "SALE"
  | "FEE"
  | "WRITE_OFF"
  | "TRADE"
  | "ADJUSTMENT"
  | "PRIZE";

export type Platform =
  | "ebay_uk"
  | "cardmarket"
  | "vinted"
  | "in_person"
  | "online_store"
  | "other";

export type Game =
  | "lorcana"
  | "pokemon"
  | "mtg"
  | "yugioh"
  | "onepiece"
  | "other";

export type Category =
  | "single"
  | "sealed_booster"
  | "sealed_box"
  | "sealed_case"
  | "memorabilia"
  | "accessory"
  | "bundle";

export type Condition =
  | "NM"
  | "LP"
  | "MP"
  | "HP"
  | "DMG"
  | "SEALED"
  | "GRADED";

export type LedgerEntrySource =
  | "manual"
  | "ebay_sync"
  | "cardmarket_import"
  | "vinted_sync"
  | "auto";

// ─── Inventory Types ─────────────────────────────────────────────────────────

export type InventoryStatus =
  | "AVAILABLE"
  | "LISTED"
  | "RESERVED"
  | "GRADING"
  | "SOLD"
  | "WRITTEN_OFF";

export type InventoryLocation =
  | "home_binder_a"
  | "home_binder_b"
  | "home_storage"
  | "listed_ebay"
  | "listed_store"
  | "trade_show_kit"
  | "grading_submission"
  | "other";

// ─── Market Data Types ────────────────────────────────────────────────────────

export type MarketDataSource =
  | "ebay_sold"
  | "tcgplayer_sold"
  | "ebay_listed"
  | "cardmarket_listed";

export type ListingType = "auction" | "buy_it_now" | "unknown";

export type CaptureMethod = "screenshot_scan" | "manual" | "api" | "rss";

// ─── Alert Types ──────────────────────────────────────────────────────────────

export type AlertType =
  | "price_spike"
  | "price_drop"
  | "below_cost_basis"
  | "competitor_undercut"
  | "high_velocity"
  | "supply_flood";

export type AlertChannel = "in_app" | "email" | "both";

// ─── API Response Helpers ─────────────────────────────────────────────────────

export type ApiSuccess<T> = { success: true; data: T };
export type ApiError = { success: false; error: string; details?: unknown };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function err(error: string, details?: unknown): ApiError {
  return { success: false, error, details };
}
