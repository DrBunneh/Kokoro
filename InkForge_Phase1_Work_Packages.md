# InkForge — Phase 1 Work Packages

**Reference:** InkForge Backend Specification v1.1  
**Phase:** 1 — Foundation  
**Goal:** Replace manual ledger and inventory tracking with a working system  
**Date:** 5 May 2026  

---

## Overview

Phase 1 is split into 8 work packages (WPs), ordered by dependency. Each WP produces a testable deliverable. You can start using the system after WP5 (manual entry) even if later packages aren't complete.

```
WP1: Project Scaffolding
 └─► WP2: Database Schema
      ├─► WP3: Card Data Cache (Lorcana API)
      ├─► WP4: Cardmarket Importer
      ├─► WP5: Ledger Engine
      │    └─► WP6: Inventory Engine
      │         └─► WP7: Manual Entry UI
      │              └─► WP8: Dashboard UI
      └────────────────────┘
```

WP3 and WP4 can be built in parallel once WP2 is done.

---

## WP1: Project Scaffolding

**Purpose:** Get the development environment, hosting, and deployment pipeline working end-to-end before writing any business logic.

### Scope

- Scaffold a Cloudflare Workers project using Hono
- Configure D1 database binding and R2 bucket binding
- Set up Drizzle ORM with SQLite dialect for D1
- Configure Cloudflare Access to restrict the app to your email address
- Set up local development with `wrangler dev`
- Deploy a "hello world" to production and confirm it's accessible at the subdomain and protected by Cloudflare Access
- Set up the Git repository

### Technical Detail

**Project init:**
```bash
pnpm create hono@latest inkforge-backend
# Select: cloudflare-workers template
```

**Dependencies:**
```
hono, drizzle-orm, drizzle-kit, @cloudflare/workers-types, wrangler
```

**Config file** (`wrangler.jsonc`):
- `main`: `src/index.ts`
- `compatibility_date`: current date
- `compatibility_flags`: `["nodejs_compat"]`
- D1 database binding: `DB`, database name `inkforge-db`
- R2 bucket binding: `STORAGE`, bucket name `inkforge-storage`
- Cron triggers: placeholder for Phase 3 (market data capture)

**Drizzle config** (`drizzle.config.ts`):
- `dialect`: `sqlite`
- `schema`: `./src/db/schema.ts`
- `out`: `./migrations`

**Cloudflare Access:**
- Create an Access Application in the Cloudflare Zero Trust dashboard
- Policy: Allow → Email = your email address
- Attach to the subdomain (e.g., `app.inkforge.co.uk`)
- Free tier (up to 50 users) — no cost

**Project structure:**
```
inkforge-backend/
├── src/
│   ├── index.ts              # Hono app entry
│   ├── db/
│   │   └── schema.ts         # Drizzle schema (WP2)
│   ├── routes/
│   │   ├── ledger.ts          # Ledger API routes (WP5)
│   │   ├── inventory.ts       # Inventory API routes (WP6)
│   │   ├── import.ts          # Cardmarket import routes (WP4)
│   │   └── market.ts          # Market data routes (Phase 3)
│   ├── services/
│   │   ├── ledger.ts          # Ledger business logic
│   │   ├── inventory.ts       # Inventory business logic
│   │   ├── cardmarket.ts      # Cardmarket file parser
│   │   ├── card-lookup.ts     # Lorcana API integration (WP3)
│   │   └── pricing.ts         # Market valuation logic (Phase 3)
│   └── lib/
│       ├── types.ts           # Shared types and enums
│       └── utils.ts           # Helpers (decimal handling, date parsing)
├── migrations/                # Drizzle-generated SQL migrations
├── drizzle.config.ts
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

### Acceptance Criteria

- [ ] Running `pnpm dev` starts a local server with a working hello-world route
- [ ] `pnpm run deploy` deploys to `app.inkforge.co.uk` (or chosen subdomain)
- [ ] Visiting the URL without Cloudflare Access authentication returns a login prompt
- [ ] After authenticating with your email, the hello-world response is visible
- [ ] D1 database exists and is bound (confirmed with a test query: `SELECT 1`)
- [ ] R2 bucket exists and is bound (confirmed with a test upload/download)
- [ ] Git repository initialised with first commit

### Estimated Effort

1 session. Mostly configuration, no business logic.

---

## WP2: Database Schema & Migrations

**Purpose:** Create all tables for Phase 1. Later phases add tables — they don't modify these ones.

### Scope

Define Drizzle schema for the following tables and generate + apply migrations:

**Tables:**
1. `ledger_entries` — all financial transactions
2. `inventory_items` — current stock
3. `card_data_cache` — Lorcana card metadata (auto-populated)
4. `cardmarket_sellers` — seller info from Cardmarket imports
5. `price_alerts` — user-configured alerts (schema only — logic in Phase 3)
6. `saved_searches` — eBay search URLs (schema only — logic in Phase 3)
7. `import_logs` — tracks which files have been imported to prevent duplicates

### Technical Detail

All field definitions follow §3.1.2, §3.2.1, §3.3.1, and §7.3 of the spec. Key implementation notes:

**IDs:** Use `text` type with UUID v4 generated at insert time (D1/SQLite doesn't have native UUID). Utility function: `crypto.randomUUID()` (available in Workers runtime).

**Decimals:** SQLite doesn't have a DECIMAL type. Store all monetary values as **integers in pence** (e.g., £8.48 = 848). This avoids floating-point errors entirely. All display formatting divides by 100. The Drizzle schema uses `integer` type with column names suffixed `_pence` for clarity.

**Dates:** Store as ISO 8601 strings (`text` type). SQLite date functions work with ISO strings.

**Enums:** Stored as `text` with application-level validation. Drizzle doesn't enforce enums at the SQLite level, so validation happens in the service layer.

**Indexes:**
- `ledger_entries`: on `date`, `platform`, `card_name`, `set_name`, `game`, `bundle_id`, `source`, `type`
- `inventory_items`: on `card_name`, `set_name`, `game`, `condition`, `location`
- `card_data_cache`: on `card_name + set_name` (composite), `cardmarket_product_id`
- `import_logs`: on `file_hash`

**import_logs table:**
```
id, file_name, file_hash (SHA-256 of file contents), file_type (articles/orders),
rows_processed, rows_skipped, imported_at, imported_by
```
This prevents double-importing the same Cardmarket export.

### Acceptance Criteria

- [ ] `drizzle-kit generate` produces migration SQL files
- [ ] `wrangler d1 migrations apply inkforge-db --local` succeeds
- [ ] `wrangler d1 migrations apply inkforge-db --remote` succeeds
- [ ] All 7 tables exist with correct columns (verified via D1 console or test query)
- [ ] Indexes are created on key columns
- [ ] A test insert + select works for each table
- [ ] Monetary values store correctly as integers in pence (e.g., inserting 848 and reading back £8.48)

### Estimated Effort

1 session. Schema definition + migration generation.

---

## WP3: Card Data Cache (Lorcana API Integration)

**Purpose:** Auto-populate card metadata (collector number, rarity, image, ink cost) so you never maintain it manually.

### Scope

- Build a service that queries Lorcana APIs to look up card data
- Cache results in `card_data_cache` table
- Provide a lookup function used by WP4 (Cardmarket import) and WP5 (Ledger) to enrich records
- Handle cases where the API doesn't recognise a card (log it, don't block)

### Technical Detail

**Lookup strategy (in order):**
1. Check `card_data_cache` by `card_name + set_name` — if found and `last_refreshed` < 30 days ago, return cached data
2. If not cached, try `lorcast.com` `/cards/search?q=name:"{card_name}"` — this API has the most structured data
3. If lorcast returns no result, try `api.lorcana-api.com` `/cards/fetch?search=name=={card_name}` — broader search
4. If neither returns a match, create a cache entry with `collector_number = null` and flag for manual review

**Mapping Cardmarket expansion names to API set names:**
Cardmarket uses names like "Promos Year 1" while the APIs use set codes. Build a static mapping table:

```typescript
const SET_MAP: Record<string, string> = {
  "The First Chapter": "1",
  "Rise of the Floodborn": "2",
  "Into the Inklands": "3",
  "Ursula's Return": "4",
  "Shimmering Skies": "5",
  "Azurite Sea": "6",
  "Archazia's Island": "7",
  "Winterspell": "8",
  "Whispers in the Well": "9",
  "Fabled": "F1",
  "Promos Year 1": "P1",
  "Promos Year 2": "P2",
  "Promos Year 3": "P3",
  // extend as new sets release
};
```

**Rate limiting:** Max 1 request per second to external APIs. When doing bulk imports (WP4), batch lookups with a small delay between calls.

**Cache refresh:** Cards don't change once printed, so 30-day cache is conservative. New set releases will trigger misses naturally.

### Acceptance Criteria

- [ ] Looking up "Gaston - Arrogant Hunter" + "Promos Year 1" returns card data including collector number
- [ ] Repeat lookup for the same card hits the cache (no external API call)
- [ ] Unknown card name returns a cache entry with `collector_number = null` and doesn't throw an error
- [ ] Cache table populates correctly with image URL, rarity, ink cost, set code
- [ ] Rate limiting prevents more than 1 API call per second during bulk operations

### Estimated Effort

1 session. API integration + caching logic.

---

## WP4: Cardmarket Importer

**Purpose:** Upload Cardmarket Articles + Orders export files and automatically create ledger entries with full cost breakdown (merchandise, shipping, trustee fees).

### Scope

- Parse Cardmarket `.xls` files (Articles and Orders formats)
- Join Articles to Orders on OrderID/Shipment nr. to attach shipping and fee data
- Split shipping costs proportionally across items by article value
- Create `PURCHASE` ledger entries for each item
- Create `FEE` ledger entries for trustee service fees
- Deduplicate against previous imports (via `import_logs` table)
- Store seller info in `cardmarket_sellers` table
- Trigger card data lookup (WP3) for each unique card
- Increase inventory quantities (WP6 dependency — if WP6 isn't done yet, ledger entries are created but inventory updates are queued)

### Technical Detail

**File parsing:**
Cardmarket exports are `.xls` (legacy Excel format, not `.xlsx`). In the Workers environment, use the `xlsx` (SheetJS) library which can parse `.xls` in the browser/worker runtime:

```typescript
import * as XLSX from 'xlsx';
const workbook = XLSX.read(buffer, { type: 'buffer' });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet);
```

**Decimal parsing:**
Cardmarket uses European comma-separated decimals in Order files (e.g., "67,84"). The importer must detect and convert:
```typescript
function parseEuroDecimal(val: string | number): number {
  if (typeof val === 'number') return Math.round(val * 100); // to pence
  return Math.round(parseFloat(val.replace(',', '.')) * 100);
}
```

**Shipping allocation:**
For each order, total shipping is split across items proportionally by article value:
```
item_shipping = (item_total / order_merchandise_total) × order_shipping
```
Rounding: allocate pence to the largest item first, then distribute remainder to avoid rounding drift.

**Multi-item order handling:**
Order files have continuation rows (blank OrderID) for orders with multiple distinct products. Parser must group these:
```
Row 1: OrderID=123, Description="29x Jasmine..."  → item 1
Row 2: OrderID="",  Description="4x Gaston..."    → item 2 (same order)
Row 3: OrderID=124, Description="1x Dumbo..."      → new order
```

**Deduplication:**
1. Hash the uploaded file contents (SHA-256)
2. Check `import_logs` for existing hash
3. If found, reject with message: "This file was already imported on {date}"
4. Additionally, check individual rows by `platform_ref` (OrderID) + `product_id` + `date` to catch partial overlaps between monthly exports

**Upload flow:**
1. User uploads Articles file
2. User uploads Orders file (or uploads both together)
3. System parses, joins, validates
4. System shows a preview: "Found X orders, Y line items, £Z total including £W shipping"
5. User confirms
6. System creates ledger entries, import log, seller records, triggers card lookups

### Acceptance Criteria

- [ ] Uploading the provided Nov 2025 Articles + Orders files creates 7 ledger entries with correct amounts
- [ ] Shipping costs are split proportionally (e.g., the 8x Gaston order at £67.84 merch + £4.01 shipping = £71.85 total, so per-unit COGS = (£8.48 + £0.50 shipping) = £8.98)
- [ ] Trustee service fee (£0.68 on that order) creates a separate `FEE` ledger entry
- [ ] Re-uploading the same file is rejected with a deduplication message
- [ ] Multi-item orders (e.g., Dec 2025 order 1244020914 with Pluto + Jasmine) correctly split shipping across both items
- [ ] Seller info (username, country, professional status) is stored in `cardmarket_sellers`
- [ ] Card data lookup is triggered for each unique card name + set combination
- [ ] Preview step shows accurate totals before committing
- [ ] All 6 months of provided data (84 line items, £2,708.98 total) can be imported successfully

### Estimated Effort

2 sessions. File parsing + joining is the fiddly part; the business logic is straightforward.

---

## WP5: Ledger Engine

**Purpose:** Core business logic for creating, reading, updating, and managing ledger entries across all transaction types.

### Scope

- CRUD operations for ledger entries
- Transaction type handling (PURCHASE, SALE, FEE, WRITE_OFF, TRADE, ADJUSTMENT, PRIZE)
- Bundle grouping (shared `bundle_id`)
- Net amount calculation (auto-computed from price, shipping, fees, other costs)
- Validation rules (required fields, valid enums, non-negative amounts)
- API endpoints for all ledger operations
- Filtering and pagination (by date range, platform, game, set, type)
- Tax year filtering (6 April – 5 April)
- Basic summary endpoint (total income, total expenses, net P&L for a date range)

### Technical Detail

**Net amount calculation:**
```typescript
function calculateNetAmount(entry: LedgerEntry): number {
  const gross = entry.total_price_pence;
  const costs = (entry.shipping_cost_pence || 0) 
              + (entry.platform_fees_pence || 0) 
              + (entry.other_costs_pence || 0);
  
  if (entry.type === 'SALE') return gross - costs;     // revenue minus costs
  if (entry.type === 'PURCHASE') return gross + costs;  // total outlay
  if (entry.type === 'FEE') return gross;               // fee amount itself
  if (entry.type === 'WRITE_OFF') return gross;         // value written off
  return gross;
}
```

**Trade handling:**
A trade creates two linked entries:
1. `SALE` at market value for the card given away
2. `PURCHASE` at market value for the card received
Both share a `bundle_id` and carry `notes: "Trade"`.
Market value lookup uses `card_data_cache` market value if available, or is entered manually.

**API routes:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/ledger` | Create entry |
| `GET` | `/api/ledger` | List entries (query params: `from`, `to`, `platform`, `game`, `set`, `type`, `page`, `limit`) |
| `GET` | `/api/ledger/:id` | Get single entry |
| `PUT` | `/api/ledger/:id` | Update entry |
| `DELETE` | `/api/ledger/:id` | Delete entry |
| `GET` | `/api/ledger/summary` | P&L summary (query params: `from`, `to`, `tax_year`) |

**Validation:**
- `card_name` required and non-empty
- `set_name` required and non-empty
- `game` must be a valid enum value
- `type` must be a valid enum value
- `quantity` must be positive integer
- `unit_price` must be non-negative integer (pence)
- `platform` must be a valid enum value
- `date` must be valid ISO 8601

### Acceptance Criteria

- [ ] Creating a PURCHASE entry with all fields returns a valid ledger entry with auto-calculated `net_amount`
- [ ] Creating a SALE entry correctly calculates net (gross minus fees/shipping)
- [ ] Creating a TRADE generates two linked entries (SALE + PURCHASE) with shared `bundle_id`
- [ ] Filtering by date range returns only entries within that range
- [ ] Filtering by tax year (e.g., 2025/26 = 6 Apr 2025 to 5 Apr 2026) works correctly
- [ ] Summary endpoint returns correct total income, expenses, and net P&L
- [ ] Validation rejects entries with missing required fields or invalid enum values
- [ ] Pagination works (default 50 per page, configurable)
- [ ] Updating an entry recalculates `net_amount`
- [ ] Deleting an entry soft-deletes (sets a `deleted_at` timestamp) rather than hard-deleting — HMRC audit trail

### Estimated Effort

2 sessions. Core logic + API routes + validation.

---

## WP6: Inventory Engine

**Purpose:** Track current stock levels, status, location, and cost basis — automatically maintained by ledger events.

### Scope

- Inventory CRUD operations
- Automatic inventory updates when ledger entries are created/modified/deleted
- Cost basis recalculation (weighted average)
- Status management (AVAILABLE, LISTED, RESERVED, GRADING, SOLD, WRITTEN_OFF)
- Location tracking
- Quantity reconciliation (`total = available + listed + reserved + grading`)
- API endpoints

### Technical Detail

**Inventory ↔ Ledger integration:**
When a ledger entry is created, the inventory engine is called as a side effect:

```typescript
async function onLedgerEntryCreated(entry: LedgerEntry, db: DrizzleD1) {
  const inventoryKey = {
    card_name: entry.card_name,
    set_name: entry.set_name,
    game: entry.game,
    condition: entry.condition,
  };
  
  switch (entry.type) {
    case 'PURCHASE':
    case 'PRIZE':
      await upsertInventory(db, inventoryKey, {
        quantityDelta: +entry.quantity,
        costBasisAddPence: entry.net_amount_pence,
      });
      break;
    case 'SALE':
      await upsertInventory(db, inventoryKey, {
        quantityDelta: -entry.quantity,
        // cost basis doesn't change on sale — we reduce quantity, avg stays
      });
      break;
    case 'WRITE_OFF':
      await upsertInventory(db, inventoryKey, {
        quantityDelta: -entry.quantity,
        costBasisRemovePence: entry.quantity * existingItem.cost_basis_avg_pence,
      });
      break;
  }
}
```

**Cost basis recalculation (weighted average):**
```
new_avg = (existing_total_cost + new_purchase_cost) / (existing_qty + new_qty)
```
On sale, the average doesn't change — only total cost and quantity decrease proportionally.

**Upsert logic:**
When a purchase arrives for a card that's already in inventory (same name + set + game + condition), the existing row is updated (quantity increases, cost basis recalculates). If no matching row exists, a new one is created.

**Status transitions:**
```
AVAILABLE → LISTED    (user lists on eBay)
AVAILABLE → RESERVED  (user holds for personal/grading)
AVAILABLE → GRADING   (user sends to PSA)
LISTED → AVAILABLE    (listing ended unsold)
LISTED → SOLD         (sale confirmed via ledger)
GRADING → AVAILABLE   (returned ungraded)
GRADING → AVAILABLE   (returned graded — condition changes to GRADED)
RESERVED → AVAILABLE  (user releases hold)
ANY → WRITTEN_OFF     (via write-off ledger entry)
```

Status changes that don't involve money (listing, reserving, changing location) update inventory directly without creating ledger entries.

**API routes:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/inventory` | List inventory (query params: `game`, `set`, `condition`, `status`, `location`, `page`, `limit`) |
| `GET` | `/api/inventory/:id` | Get single item with full detail |
| `PUT` | `/api/inventory/:id/status` | Change status (body: `{ status, quantity? }`) |
| `PUT` | `/api/inventory/:id/location` | Change location (body: `{ location }`) |
| `GET` | `/api/inventory/valuation` | Portfolio summary: total cost basis, total market value, unrealised P&L |
| `GET` | `/api/inventory/reconcile` | Check that all quantities balance (total = sum of statuses) |

### Acceptance Criteria

- [ ] Creating a PURCHASE ledger entry for a new card creates an inventory item with correct quantity and cost basis
- [ ] Creating a second PURCHASE for the same card increases quantity and recalculates weighted average cost basis
- [ ] Creating a SALE ledger entry decreases inventory quantity; cost basis average remains unchanged
- [ ] Creating a WRITE_OFF removes quantity and reduces total cost basis proportionally
- [ ] Status change from AVAILABLE to LISTED reduces `quantity_available` and increases `quantity_listed` by the same amount
- [ ] Status change from AVAILABLE to RESERVED works the same way for `quantity_reserved`
- [ ] Location update changes the location field without affecting quantities
- [ ] Reconciliation endpoint confirms `quantity_total = quantity_available + quantity_listed + quantity_reserved + quantity_grading` for all items
- [ ] Valuation endpoint returns correct total cost basis across all inventory
- [ ] Deleting (soft-deleting) a ledger entry reverses its inventory effect

### Estimated Effort

2 sessions. The cost basis recalculation and ledger-triggered side effects are the most complex parts.

---

## WP7: Manual Entry UI

**Purpose:** A web interface for manually creating ledger entries and managing inventory — the primary way you interact with the system until platform integrations are built in Phase 2.

### Scope

- Purchase entry form (card name, set, game, quantity, unit price, shipping, platform, condition, notes)
- Sale entry form (same fields + platform fees)
- Write-off entry form
- Trade entry form (card given + card received, auto-valued)
- Quick-add: photo upload → Claude vision API identifies card → pre-fills form
- Inventory status change UI (select items → change status/location)
- Basic navigation between Ledger, Inventory, and Import sections
- Import page for Cardmarket file uploads (built in WP4, UI wrapper here)
- Mobile-functional (responsive, not optimised)

### Technical Detail

**Frontend stack:**
React app served as static assets via Cloudflare Pages (or bundled into the Worker's static assets). Communicates with the Hono API routes via `fetch`.

**Form design principles:**
- Card name + set fields should offer autocomplete from `card_data_cache` (type-ahead search)
- Default values: `condition = NM`, `game = lorcana`, `platform = cardmarket` (most common)
- After submission, show confirmation with the created entry details and an "undo" option (soft-delete)
- Currency input in pounds (£8.48), converted to pence on submit

**Quick-add photo flow:**
1. User taps "Quick Add" → camera opens (or file picker)
2. Image uploaded to R2 (temporary storage)
3. Claude Sonnet API call with image + prompt: "Identify this Lorcana card. Return JSON: { card_name, set_name, condition_estimate }"
4. Response pre-fills the form
5. User adds price and confirms

**Trade form:**
Two card selectors (given / received). Each can be typed manually or selected from inventory. On submit, creates two ledger entries with shared `bundle_id`.

### Acceptance Criteria

- [ ] Purchase form creates a ledger entry and updates inventory
- [ ] Sale form creates a ledger entry (SALE + FEE for platform fees) and reduces inventory
- [ ] Write-off form creates a WRITE_OFF entry and reduces inventory
- [ ] Trade form creates two linked entries (SALE + PURCHASE)
- [ ] Quick-add photo correctly identifies a Lorcana card from a clear photo at least 80% of the time
- [ ] Card name autocomplete suggests results from the card data cache
- [ ] Cardmarket import page accepts file uploads and shows the preview/confirm flow from WP4
- [ ] Inventory status change works (select items → change to LISTED/RESERVED/GRADING)
- [ ] All forms work on mobile (may not be pretty, but must be functional)
- [ ] Undo/delete is available within 30 seconds of creating an entry

### Estimated Effort

3 sessions. This is the largest WP because it's the user-facing layer for everything built in WP4–6.

---

## WP8: Dashboard UI

**Purpose:** At-a-glance view of your business — inventory value, recent transactions, P&L, and stock status.

### Scope

- Portfolio overview: total inventory value (cost basis + market value), total items, unrealised P&L
- Recent transactions list (last 20 ledger entries)
- Inventory breakdown by game, by set, by status
- Top cards by quantity held, by value, by margin
- Monthly P&L chart (income vs expenses)
- Capital deployed vs returned
- Inventory age analysis (cards held > 30/60/90 days)
- Filters: date range, game, set
- Quick links to manual entry, import, inventory management

### Technical Detail

**Data sources:**
All dashboard data comes from the API endpoints built in WP5 and WP6. No new backend logic is needed — this is a frontend-only work package.

**Key views:**

1. **Summary cards** (top row):
   - Total inventory items (count)
   - Total cost basis (£)
   - Total market value (£) — placeholder until Phase 3 populates market data
   - Unrealised P&L (market value minus cost basis)
   - Cash P&L this month (realised from sales)

2. **Recent activity** (middle):
   - Last 20 ledger entries with type indicator (colour-coded: green = sale, red = purchase, grey = fee, amber = write-off)

3. **Inventory breakdown** (bottom):
   - Pie/donut chart: stock by game
   - Bar chart: top 10 cards by capital deployed
   - Table: cards held > 90 days with capital locked and estimated market value

4. **Monthly P&L** (expandable):
   - Line chart: income, expenses, net profit per month
   - Uses the `/api/ledger/summary` endpoint with monthly date ranges

**Market value placeholder:**
Until Phase 3 (Market Intelligence) populates the `market_value_current` field on inventory items, the dashboard shows cost basis only and displays "Market value: pending" for those fields. This avoids blocking Phase 1 delivery.

### Acceptance Criteria

- [ ] Dashboard loads and displays portfolio summary cards with real data from the ledger and inventory
- [ ] Recent transactions show the last 20 entries with correct colour coding
- [ ] Inventory breakdown shows cards grouped by game and set
- [ ] Monthly P&L chart renders with at least 2 months of data (after importing Cardmarket history)
- [ ] Inventory age analysis highlights cards held over 90 days
- [ ] All views respond to game/set/date filters
- [ ] Dashboard loads in under 2 seconds on desktop
- [ ] Dashboard is readable (if not pretty) on mobile

### Estimated Effort

2 sessions. Frontend work using data from existing API endpoints.

---

## Summary

| WP | Name | Depends On | Sessions | Deliverable |
|----|------|------------|----------|-------------|
| 1 | Project Scaffolding | — | 1 | Deployed, authenticated, empty app |
| 2 | Database Schema | WP1 | 1 | All tables created and migrated |
| 3 | Card Data Cache | WP2 | 1 | Lorcana API lookup + cache working |
| 4 | Cardmarket Importer | WP2, WP3 | 2 | Upload .xls → ledger entries with full cost breakdown |
| 5 | Ledger Engine | WP2 | 2 | Full CRUD + summary + tax year filtering |
| 6 | Inventory Engine | WP5 | 2 | Auto-updated inventory with cost basis |
| 7 | Manual Entry UI | WP4, WP5, WP6 | 3 | Forms for all transaction types + photo quick-add |
| 8 | Dashboard UI | WP5, WP6 | 2 | Portfolio overview + P&L + inventory analysis |
| | **Total** | | **14 sessions** | |

### What "Done" Looks Like for Phase 1

When all 8 WPs are complete, you will be able to:

1. Log into `app.inkforge.co.uk` on your phone or PC
2. Upload your Cardmarket export files and see them automatically converted into ledger entries with full cost breakdown (merchandise + shipping + fees)
3. Manually enter eBay sales, Vinted purchases, in-person buys, trades, and write-offs
4. Take a photo of a card and have it identified and pre-filled into a purchase form
5. See your complete inventory with quantities, cost basis, location, and status
6. See a P&L summary for any date range or tax year
7. See which cards have capital locked in them for the longest

You will NOT yet be able to:
- Have eBay sales auto-sync (Phase 2)
- See market pricing data or price alerts (Phase 3)
- Generate HMRC-ready reports (Phase 4)
- Sell via an online store (Phase 5)

---

*End of Phase 1 Work Packages*
