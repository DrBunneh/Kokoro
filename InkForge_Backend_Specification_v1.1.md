# InkForge Backend — Functional & Technical Specification

**Version:** 1.1 — Updated with Cardmarket Order Data & Research Findings  
**Date:** 5 May 2026  
**Author:** InkForge Project  
**Status:** Awaiting Final Review  

---

## 1. Purpose & Scope

InkForge is a backend system for managing a TCG (Trading Card Game) resale business. It replaces manual spreadsheet tracking with an integrated platform that handles inventory, financial record-keeping, platform sales integration, purchase logging, and market analysis.

The system is designed for a single operator running a UK-based online TCG business selling primarily through eBay UK, with purchases sourced from Cardmarket, Vinted, eBay, and in-person events. It must produce records suitable for HMRC self-assessment reporting.

**Current TCG focus:** Disney Lorcana.  
**Future scope:** Multi-TCG expansion (Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece TCG).

### 1.1 What This Document Covers

- Core data architecture (Ledger, Inventory, Market Data)
- Platform integrations (eBay, Cardmarket, Vinted)
- Purchase and sales feed automation
- Analysis and pricing intelligence tools
- HMRC compliance requirements
- Technical architecture and hosting
- Phased delivery plan

### 1.2 What This Document Does Not Cover

- Customer-facing online storefront (Phase 2 — will be specified separately when inventory levels support launch)
- Social media content strategy
- Grading submission workflows (future add-on)
- Wholesale purchasing (blocked by lack of brick-and-mortar premises)

---

## 2. Definitions

| Term | Meaning |
|------|---------|
| **Ledger** | The financial transaction log. Every purchase, sale, fee, write-off, and adjustment is a ledger entry. This is the HMRC-facing record. |
| **Inventory** | The current stock of cards, sealed product, and memorabilia. Inventory is affected by ledger transactions but is a separate entity — it tracks what you *have*, not what you *spent*. |
| **Market Data** | Externally gathered pricing and sales information from eBay, TCGPlayer, and other sources. This data does not touch the ledger — it is research, not accounting. |
| **Platform** | A sales or purchase channel: eBay, Cardmarket, Vinted, in-person events, or the future online store. |
| **COGS** | Cost of Goods Sold — the purchase price plus attributable costs (shipping, fees) of items that have been sold. |
| **NM** | Near Mint condition — the assumed default for all inventory unless explicitly stated otherwise. |
| **BIN** | Buy It Now — fixed-price eBay listing. |
| **Enchanted** | Lorcana's highest-rarity variant. Key product category. |
| **Promo** | Promotional cards not found in standard booster packs. Currently the primary product line. |

---

## 3. Core Data Architecture

The system has three distinct data domains that interact but are not the same thing.

```
┌──────────────┐     affects      ┌──────────────┐
│              │ ──────────────►  │              │
│    LEDGER    │                  │  INVENTORY   │
│  (financial) │ ◄──────────────  │  (physical)  │
│              │    feeds from    │              │
└──────────────┘                  └──────────────┘
                                        │
                                        │ compared against
                                        ▼
                                  ┌──────────────┐
                                  │              │
                                  │ MARKET DATA  │
                                  │  (research)  │
                                  │              │
                                  └──────────────┘
```

### 3.1 The Ledger

The ledger is the single source of truth for all financial transactions. It must satisfy HMRC self-assessment requirements for a sole trader.

#### 3.1.1 Transaction Types

| Type | Direction | Description |
|------|-----------|-------------|
| `PURCHASE` | Money out | Buying stock from any source |
| `SALE` | Money in | Selling stock through any channel |
| `FEE` | Money out | Platform fees, shipping costs, packaging materials |
| `WRITE_OFF` | Adjustment | Stock damaged, lost, or deemed unsellable |
| `TRADE` | Both | Card-for-card exchange — recorded as a simultaneous sale (at market value) and purchase (at market value). See §3.1.3. |
| `ADJUSTMENT` | Either | Corrections, refunds, price adjustments |
| `PRIZE` | Money in (notional) | Tournament winnings, promotional acquisitions. Recorded at £0 cost basis initially, with market value noted. See §3.1.4. |

#### 3.1.2 Ledger Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID | Auto | Unique transaction identifier |
| `date` | DateTime | Yes | Transaction date and time |
| `type` | Enum | Yes | One of the transaction types above |
| `platform` | Enum | Yes | `ebay_uk`, `cardmarket`, `vinted`, `in_person`, `online_store`, `other` |
| `platform_ref` | String | No | Platform-specific reference (eBay order number, Cardmarket shipment number, etc.) |
| `card_name` | String | Yes | Card name as it appears on the card |
| `set_name` | String | Yes | Expansion/set name |
| `game` | String | Yes | `lorcana`, `pokemon`, `mtg`, `yugioh`, `onepiece`, `other` |
| `product_id` | String | No | Platform product ID (e.g., Cardmarket Product ID). Auto-populated where possible. |
| `collector_number` | String | No | Set number + collector number. Auto-populated via lookup — user does not manually maintain this. |
| `category` | Enum | Yes | `single`, `sealed_booster`, `sealed_box`, `sealed_case`, `memorabilia`, `accessory`, `bundle` |
| `quantity` | Integer | Yes | Number of units in this transaction |
| `unit_price` | Decimal | Yes | Price per unit in GBP |
| `total_price` | Decimal | Auto | `quantity × unit_price` |
| `shipping_cost` | Decimal | No | Shipping/postage cost attributable to this transaction |
| `platform_fees` | Decimal | No | Fees charged by the sales platform (eBay final value fee, Cardmarket commission, etc.) |
| `other_costs` | Decimal | No | Packaging, insurance, grading fees, or other attributable costs |
| `net_amount` | Decimal | Auto | For sales: `total_price - shipping_cost - platform_fees - other_costs`. For purchases: `total_price + shipping_cost + platform_fees + other_costs` |
| `condition` | Enum | Yes | `NM` (default), `LP`, `MP`, `HP`, `DMG`, `SEALED`, `GRADED` |
| `grade_company` | String | No | PSA, CGC, BGS, etc. Only if `condition = GRADED` |
| `grade_value` | String | No | Grade number (e.g., "10", "9.5"). Only if `condition = GRADED` |
| `currency_original` | String | No | Original transaction currency if not GBP |
| `currency_rate` | Decimal | No | Exchange rate used for conversion to GBP |
| `notes` | String | No | Free text notes |
| `bundle_id` | UUID | No | Groups multiple items from a single bundle sale/purchase. See §3.1.5. |
| `created_at` | DateTime | Auto | When this record was created in the system |
| `updated_at` | DateTime | Auto | Last modification timestamp |
| `source` | Enum | Auto | `manual`, `ebay_sync`, `cardmarket_import`, `vinted_sync`, `auto` — how the entry was created |

#### 3.1.3 Trade Handling

Trades (card-for-card swaps) are recorded as two linked transactions:

1. A `SALE` entry for the card given away, valued at current market price (median eBay sold, last 30 days)
2. A `PURCHASE` entry for the card received, valued at the same methodology

Both entries share a `bundle_id` and carry a note indicating a trade. This approach ensures HMRC sees the market value movement and the inventory is correctly updated in both directions.

**Open question:** HMRC treatment of trades needs confirmation from an accountant. The system will record them transparently either way.

#### 3.1.4 Prize & Promo Acquisitions

Cards received as tournament prizes, promotional giveaways, or free inserts are entered as `PRIZE` type with `unit_price = 0.00`. The system also records a `market_value_at_acquisition` field (not shown in the main schema — stored as metadata) so that if the card is later sold, COGS is £0 and the full sale amount is profit.

When full Cardmarket purchase history is obtained, any cards that were originally free but have been retroactively identified as purchased will be corrected via an `ADJUSTMENT` entry.

#### 3.1.5 Bundle Handling

When multiple cards are sold as a single listing (e.g., "Dumbo + Jasmine combo"):

- Each card gets its own ledger entry
- All entries share the same `bundle_id`
- Revenue is split proportionally based on each card's individual market value at time of sale
- Example: Dumbo market value £8, Jasmine market value £12, bundle sells for £18 → Dumbo gets £7.20, Jasmine gets £10.80

When multiple cards are purchased in a single shipment (Cardmarket orders):

- Each card gets its own ledger entry
- Shipping cost for that shipment is split proportionally across items by value
- All entries share the same `bundle_id` (using the Cardmarket shipment number)

#### 3.1.6 HMRC Reporting Requirements

The ledger must support generation of the following for self-assessment:

- **Total income** — sum of all `SALE` transactions (gross, before fees)
- **Total expenses** — sum of all `PURCHASE`, `FEE`, and allowable `WRITE_OFF` amounts
- **Net profit/loss** — income minus expenses
- **COGS report** — cost basis of all items sold in the tax year
- **Stock valuation** — value of unsold inventory at year end (for accounting method: lower of cost or market value)
- **Platform fee summary** — breakdown of fees by platform for expense claims
- **Mileage/travel** — not tracked in the system (manual claim), but a placeholder field exists for future inclusion

The tax year runs 6 April to 5 April. The system must support filtering and reporting by tax year.

### 3.2 Inventory

Inventory represents the current physical stock. It is derived from ledger transactions but maintained as its own entity because inventory carries attributes that the ledger does not (location, status, listing state).

#### 3.2.1 Inventory Item Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID | Auto | Unique inventory item identifier |
| `card_name` | String | Yes | Card name |
| `set_name` | String | Yes | Expansion/set |
| `game` | String | Yes | TCG game |
| `product_id` | String | No | Cardmarket / platform product ID |
| `collector_number` | String | No | Auto-populated — not manually maintained |
| `category` | Enum | Yes | `single`, `sealed_booster`, `sealed_box`, `sealed_case`, `memorabilia`, `accessory` |
| `condition` | Enum | Yes | Default: `NM` |
| `grade_company` | String | No | If graded |
| `grade_value` | String | No | If graded |
| `quantity_total` | Integer | Auto | Total units held |
| `quantity_available` | Integer | Auto | Units available for sale |
| `quantity_listed` | Integer | Auto | Units currently listed on a platform |
| `quantity_reserved` | Integer | Auto | Units held/not for sale (see §3.2.2) |
| `quantity_grading` | Integer | Auto | Units sent for grading, not yet returned |
| `cost_basis_avg` | Decimal | Auto | Weighted average cost per unit across all purchases |
| `cost_basis_total` | Decimal | Auto | Total capital invested in current stock of this item |
| `market_value_current` | Decimal | Auto | Current estimated market value per unit (see §3.4) |
| `location` | Enum | No | `home_binder_a`, `home_binder_b`, `home_storage`, `listed_ebay`, `listed_store`, `trade_show_kit`, `grading_submission`, `other` |
| `first_acquired` | DateTime | Auto | Date of first purchase |
| `last_acquired` | DateTime | Auto | Date of most recent purchase |
| `days_in_inventory` | Integer | Auto | Days since `first_acquired` for oldest unsold unit |
| `updated_at` | DateTime | Auto | Last modification |

**Inventory quantities must always reconcile:**  
`quantity_total = quantity_available + quantity_listed + quantity_reserved + quantity_grading`

#### 3.2.2 Inventory Statuses

| Status | Meaning |
|--------|---------|
| `AVAILABLE` | In stock, not listed, available for listing or sale |
| `LISTED` | Currently active on a sales platform |
| `RESERVED` | Held intentionally — not for sale (e.g., personal collection, long-term holds like Fabled boxes) |
| `GRADING` | Sent to PSA/CGC/BGS, awaiting return |
| `SOLD` | Sold and dispatched — removed from active inventory |
| `WRITTEN_OFF` | Damaged, lost, or otherwise removed from inventory |

#### 3.2.3 Inventory ↔ Ledger Interaction

| Event | Ledger Effect | Inventory Effect |
|-------|---------------|------------------|
| Purchase recorded | `PURCHASE` entry created | `quantity_total` and `quantity_available` increase; `cost_basis_avg` recalculated |
| Sale confirmed | `SALE` entry created | `quantity_listed` decreases; if not listed, `quantity_available` decreases |
| Item listed on eBay | No ledger entry | `quantity_available` decreases, `quantity_listed` increases |
| Listing ended unsold | No ledger entry | `quantity_listed` decreases, `quantity_available` increases |
| Item reserved | No ledger entry | `quantity_available` decreases, `quantity_reserved` increases |
| Item sent for grading | `FEE` entry for grading cost | `quantity_available` decreases, `quantity_grading` increases; condition changes to `GRADED` on return |
| Write-off | `WRITE_OFF` entry | `quantity_total` and `quantity_available` decrease |

### 3.3 Market Data

Market data is external research. It **never** creates ledger entries and **never** modifies inventory quantities. It exists to inform pricing decisions and trigger alerts.

#### 3.3.1 Market Data Record

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique record ID |
| `card_name` | String | Card name |
| `set_name` | String | Expansion |
| `game` | String | TCG game |
| `source` | Enum | `ebay_sold`, `tcgplayer_sold`, `ebay_listed`, `cardmarket_listed` |
| `price` | Decimal | Sold price or listing price |
| `shipping` | Decimal | Shipping cost (if applicable) |
| `condition` | String | Condition as stated in the listing |
| `listing_type` | Enum | `auction`, `buy_it_now`, `unknown` |
| `date_sold` | DateTime | When the item sold (or was observed) |
| `date_captured` | DateTime | When we captured this data point |
| `graded` | Boolean | Whether the item was graded |
| `grade_company` | String | If graded |
| `grade_value` | String | If graded |
| `seller_name` | String | Seller username (for competitor tracking) |
| `capture_method` | Enum | `screenshot_scan`, `manual`, `api`, `rss` |

#### 3.3.2 Derived Market Metrics

Calculated per card, per time window (default: 30 days):

| Metric | Calculation | Purpose |
|--------|-------------|---------|
| `median_sold_price` | Median of sold prices (BIN only) | Primary pricing reference |
| `avg_sold_price` | Mean of sold prices (BIN only) | Secondary reference |
| `auction_avg` | Mean of auction final prices | Floor price indicator |
| `lowest_current_listing` | Lowest active BIN listing | Competitive positioning |
| `sell_through_velocity` | Sales per day across all sellers | Demand indicator |
| `personal_velocity` | Your sales per day for this card | Your demand indicator |
| `days_to_sell` | Avg days between listing and sale | Capital lock-up indicator |
| `supply_trend` | Sold volume change vs prior period | Saturation detection |
| `price_trend_direction` | Price movement (up/stable/down) | Buy/sell/hold signal |
| `condition_premium` | Price gap between NM and LP/MP | Grading ROI indicator |
| `bin_vs_auction_gap` | BIN median minus auction average | Listing format decision |

#### 3.3.3 Market Value Calculation

The system uses a blended approach for "current market value" of inventory:

```
market_value = weighted_average(
    lowest_current_listing × 0.3,
    median_sold_30d × 0.5,
    avg_sold_30d × 0.2
)
```

If fewer than 3 sold data points exist in the last 30 days, the window extends to 60 days. If still insufficient, the system flags the item as `INSUFFICIENT_DATA` and uses the last known value.

**Auction vs BIN separation:** Auction sold prices are excluded from the market value calculation. They are tracked separately as a floor-price reference. BIN sold prices are the basis for all valuation. This prevents auction bargains from dragging down the reported value of your stock.

---

## 4. Platform Integrations

### 4.1 eBay UK

**Purpose:** Primary sales channel. Also a source for market data (sold listings).

#### 4.1.1 Sales Feed (Automated)

| Attribute | Detail |
|-----------|--------|
| **Trigger** | eBay sale notification or polling |
| **Frequency** | Near real-time for stock updates; daily reconciliation pass |
| **Data captured** | Order number, item title, sale price, shipping charged, eBay fees (final value fee + regulatory operating fee), buyer username, date/time |
| **Actions on sale** | 1. Create `SALE` ledger entry. 2. Create `FEE` ledger entry for eBay fees. 3. Deduct from inventory (`quantity_listed` → sold). 4. Auto-match to inventory item by title + set. |
| **Auto-match logic** | Match on `card_name` + `set_name` + `condition`. If ambiguous (multiple inventory items match), flag for manual review rather than guessing. |
| **Bundle handling** | If an eBay listing contains multiple cards, the system prompts for card breakdown or splits proportionally by market value. |
| **Integration method** | Via Make automation for MVP webhook relay. Migration path: eBay Fulfillment API (order data + fees), Finances API (payout reconciliation). Free developer access, register at developer.ebay.com (separate account from seller account, ~1 business day approval). 5,000 calls/day rate limit — sufficient at current volume. |

#### 4.1.2 Market Data Feed (Screenshot-Based)

| Attribute | Detail |
|-----------|--------|
| **Method** | Automated screenshot of saved search URLs → Claude vision API extraction |
| **Frequency** | Every 1–2 hours via scheduled Make scenario |
| **Data captured** | All visible sold listing fields (see §3.3.1) |
| **Scope** | Broad searches preferred (e.g., "Lorcana enchanted") — the AI categorises by set, not the search parameters |
| **Storage** | Market data records (§3.3.1), never touches ledger |
| **ToS consideration** | Frequency kept modest (max 1 request per search per 2 hours). Personal research use only. Data not resold. |

#### 4.1.3 Competitor Monitoring (Stretch Goal)

Capture active listing prices from other UK sellers for cards in your inventory. Logged as `ebay_listed` market data records with seller name. Used to calculate your competitive position relative to the market.

### 4.2 Cardmarket

**Purpose:** Primary purchase channel for sourcing stock.

#### 4.2.1 Purchase Import

The system ingests TWO Cardmarket export file types which together provide complete transaction data:

**File 1: Purchased Articles (.xls)**

| Column | Type | Example |
|--------|------|---------|
| Shipment nr. | Integer | 1239536902 |
| Date of purchase | String | 05/11/2025 0:11 |
| Article | String | Gaston - Arrogant Hunter |
| Product ID | Integer | 740810 |
| Localized Product Name | String | Gaston - Arrogant Hunter |
| Expansion | String | Promos Year 1 |
| Category | String | Lorcana Single |
| Amount | Integer | 8 |
| Article Value | Decimal | 8.48 |
| Total | Decimal | 67.84 |
| Currency | String | GBP |
| Comments | String | (usually empty) |

**File 2: Purchased Orders (.xls)**

| Column | Type | Example |
|--------|------|---------|
| OrderID | Integer | 1239536902 |
| Username | String | BulldogCardTraders |
| Name | String | Seller full name |
| Street | String | Seller address |
| City | String | City + postcode |
| Country | String | United Kingdom |
| Is Professional | String | X (if professional seller) |
| VAT Number | String | VAT number if applicable |
| Date of Purchase | Excel date | 45966.007962963 |
| Article Count | Integer | 8 |
| Merchandise Value | String | 67,84 (comma-separated decimal) |
| Shipment Costs | String | 4,01 |
| Trustee service fee | String | 0,68 |
| Total Value | String | 72,53 |
| Currency | String | GBP |
| Description | String | Full item description with condition, language, foil status |
| Product ID | Integer | 740810 |
| Localized Product Name | String | Gaston - Arrogant Hunter |

**Note:** Order files use commas as decimal separators (European format). The importer must handle this. Multi-item orders have continuation rows where OrderID and order-level fields are blank — only Description, Product ID, and Localized Product Name are populated.

| Attribute | Detail |
|-----------|--------|
| **Method** | Manual upload of both Cardmarket export files (.xls format) |
| **Frequency** | On-demand (monthly or after significant purchases) |
| **Processing** | Articles file provides per-item costs. Orders file provides shipping, trustee fees, and seller details. Joined on OrderID / Shipment nr. |
| **Shipping allocation** | Shipping cost from the Orders file is split proportionally across items in that order by article value. Trustee service fees are recorded as a separate `FEE` ledger entry per order. |
| **Product ID mapping** | Cardmarket Product ID is stored as `product_id` on both ledger and inventory records for cross-referencing with the Lorcana card database |
| **Deduplication** | System checks for duplicate entries by `platform_ref` (OrderID) + `product_id` + `date` to prevent re-importing the same export |
| **Seller tracking** | Seller username, country, and professional status are stored for future supplier analysis |
| **Historical data** | Full Cardmarket purchase history expected within 1–2 weeks. Will retroactively assign cost bases to items currently logged as `PRIZE` acquisitions. |

#### 4.2.2 Known Data from Cardmarket Exports

Based on analysis of the 12 provided export files — 6 Articles + 6 Orders (Nov 2025 – Apr 2026):

- **84 purchase line items** across 74 unique orders
- **Merchandise spend:** £2,353.05
- **Shipping costs:** £315.23
- **Trustee service fees:** £13.18
- **Total all-in cost:** £2,708.98 (shipping is 13.4% on top of merchandise value)
- **Seller countries:** Austria, Belgium, Denmark, France, Germany, Netherlands, Poland, Portugal, Spain, Switzerland, United Kingdom
- **Professional sellers:** 10 out of 74 orders (some with VAT numbers)
- **Expansions covered:** Azurite Sea, Fabled, Promos Year 1–3, Shimmering Skies, Whispers in the Well, Winterspell
- **Categories:** Lorcana Single, Lorcana Booster Boxes, Memorabilia
- **All transactions in GBP** — no currency conversion needed
- **Multi-item orders:** 10 orders contain continuation rows with multiple distinct cards

### 4.3 Vinted

**Purpose:** Secondary purchase channel and potential sales channel.

#### 4.3.1 Purchase Logging

| Attribute | Detail |
|-----------|--------|
| **Method** | Primary: Gmail email parsing of Vinted order confirmations (via Gmail MCP connector). Fallback: manual entry or photo-based quick-add. |
| **Frequency** | Automated: polled hourly via Gmail search filter. Manual: per-purchase as they occur. |
| **Gmail filter** | Search for emails from Vinted matching purchase confirmation templates. Filter by sender address + subject line keywords to isolate purchase emails from other Vinted notifications (shipping updates, messages, etc.). |
| **Data captured** | Item description, price paid, shipping cost, date, Vinted order reference |
| **Notes** | Gmail parsing extracts structured data from Vinted confirmation emails. The system presents extracted data for user confirmation before creating ledger entries, since Vinted items may need manual card identification (Vinted listings aren't standardised like Cardmarket). |

#### 4.3.2 Photo Quick-Add

For Vinted and in-person purchases, the system supports a photo-based entry flow:

1. User takes a photo of the card(s) or the purchase confirmation screen
2. Claude vision API identifies the card(s), condition, and price if visible
3. System pre-fills a purchase entry for user confirmation
4. User adds any missing fields (price, shipping) and confirms

### 4.4 In-Person Events

**Purpose:** Purchase channel (trade shows, local game stores, player trades).

| Attribute | Detail |
|-----------|--------|
| **Method** | Batch entry via the manual entry interface after the event |
| **Quick-add** | Photo-based entry supported (§4.3.2) |
| **Trades** | Logged as simultaneous sale + purchase at market value (§3.1.3) |
| **Notes** | Mobile-friendly interface is a later priority but the batch entry form should be functional on mobile from launch |

### 4.5 Online Store (Future — Phase 2)

Not specified in this document. When launched, the online store will act as an additional sales platform feeding the same ledger and inventory system. It will be the only channel where no platform fees are deducted.

---

## 5. Automated Workflows

### 5.1 eBay Sale Workflow

```
eBay Sale Notification
    │
    ├─► Create SALE ledger entry (price, date, buyer)
    ├─► Create FEE ledger entry (eBay fees)
    ├─► Match to inventory item
    │       ├─ Match found → deduct stock
    │       └─ No match → flag for manual review
    ├─► If card is also listed on other platforms → flag for delisting
    └─► Update dashboard metrics
```

### 5.2 Cardmarket Import Workflow

```
User uploads .xls export file
    │
    ├─► Parse rows
    ├─► Deduplicate against existing entries
    ├─► For each new row:
    │       ├─► Create PURCHASE ledger entry
    │       ├─► Add to / increase inventory
    │       └─► Flag if shipping cost is missing for this shipment
    ├─► Prompt user for missing shipping costs (grouped by shipment)
    └─► Recalculate cost basis for affected inventory items
```

### 5.3 Market Data Capture Workflow

```
Scheduled trigger (every 1-2 hours)
    │
    ├─► For each saved search URL:
    │       ├─► Headless browser loads page
    │       ├─► Screenshot captured
    │       ├─► Claude vision API extracts listing data
    │       ├─► Diff against previous capture
    │       └─► New listings → create market data records
    │
    ├─► Recalculate derived metrics (§3.3.2)
    ├─► Check price alert conditions (§5.4)
    └─► Update market value on inventory items
```

### 5.4 Price Alert System

User-configurable alerts. Each alert has:

- **Card or set filter** — which cards to monitor
- **Condition** — the trigger logic
- **Channel** — how to notify (in-app, email, or both)

| Alert Type | Trigger |
|------------|---------|
| Price spike | Card price increases by X% within Y days |
| Price drop | Card price decreases by X% within Y days |
| Below cost basis | Market value drops below your average cost basis |
| Competitor undercut | A competitor lists below your price |
| High velocity | Sell-through rate exceeds X/day (buying signal) |
| Supply flood | Sold volume spikes X% above average (hold signal) |

### 5.5 Restock Analysis

The restock engine evaluates whether a card is worth restocking based on three factors:

1. **Market sell-through velocity** — how fast is this card selling across the market? High velocity = high demand.
2. **Personal sell-through velocity** — how fast are YOUR listings selling? This accounts for your pricing and listing quality.
3. **Days-to-sell** — how long did your last unit sit before selling? If a card takes 6 months to move, the capital is better deployed elsewhere, even if the margin is good.

**Restock score formula (to be refined with real data):**

```
restock_score = (
    market_velocity_weight × normalised_market_velocity
  + personal_velocity_weight × normalised_personal_velocity
  - days_to_sell_penalty × normalised_days_to_sell
) × margin_multiplier
```

Where `margin_multiplier` is the expected profit margin based on current COGS vs market value. A card with a 10% margin and fast velocity scores lower than a card with 60% margin and moderate velocity.

Cards are ranked by restock score and presented as a prioritised list with recommended purchase quantities based on available capital.

---

## 6. Analysis Tools

### 6.1 Inventory Dashboard

Displays current stock with:

- Card name, set, game, condition, quantity, location
- Cost basis (average per unit and total)
- Current market value and unrealised P&L per item
- Days in inventory (oldest unit)
- Inventory status breakdown (available / listed / reserved / grading)
- Filters by game, set, category, status, location
- Sort by any column
- Total portfolio value and total unrealised P&L

### 6.2 Sales Performance

- Revenue by period (week/month/quarter/tax year)
- Profit margin by card, by set, by category
- Fees paid by platform
- Average days to sell
- Best and worst performers
- BIN vs auction price comparison (separated, not blended)

### 6.3 Pricing Tool

For setting list prices on cards:

- Shows BIN median sold (30d), auction average, lowest current listing
- Suggests a list price based on target margin and competitive position
- Bulk mode: select multiple cards, set target margin, generate all prices at once
- Accounts for platform fees in the suggested price (eBay ~13%, Vinted ~5%, online store 0%)

### 6.4 Capital Efficiency

- Capital deployed vs capital returned over time
- ROI by tier / price bracket
- Inventory age analysis (capital locked in slow-moving stock)
- Opportunity cost estimates (what could this capital earn if redeployed to faster-moving cards?)

### 6.5 HMRC Reports

- Income summary by tax year
- Expense summary by tax year and category
- Net profit/loss
- Stock valuation at year-end
- Exportable to CSV/PDF for submission to accountant

---

## 7. Technical Architecture

### 7.1 Hosting

**Primary:** Cloudflare (existing domain and account connected).

| Component | Service |
|-----------|---------|
| Application server | Cloudflare Workers (or Pages Functions) |
| Database | Cloudflare D1 (SQLite at the edge) — 10 GB per database, more than sufficient for this use case. No row limits. Paid plan ($5/mo) removes daily read/write caps. |
| File storage | Cloudflare R2 (screenshots, exports, receipts) |
| Scheduled jobs | Cloudflare Workers Cron Triggers (market data capture, email polling) |
| Domain & DNS | Already on Cloudflare |

**D1 capacity assessment:** At current volumes (~84 purchases and ~100 sales per 6 months), the ledger and inventory tables would use well under 1 MB. Even at 10x scale with full market data capture (thousands of data points per month), storage stays comfortably under 1 GB. The 10 GB cap per database is not a concern for the foreseeable future. If market data eventually outgrows a single database, it can be separated into its own D1 instance (market_data DB) with no architectural changes.

**Screenshot processing consideration:** Claude API calls for vision analysis run from the Worker, not within D1. Worker CPU time limit is 30 seconds on the paid plan — sufficient for a single screenshot analysis. If batch processing multiple screenshots, they should be queued and processed sequentially via Cloudflare Queues.

### 7.2 Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Runtime | Node.js (Cloudflare Workers compatible) | Bun is not supported in Workers runtime. Node.js APIs are available via `nodejs_compat` flag. |
| Backend framework | Hono | Lightweight, Cloudflare-native, excellent D1 bindings |
| Database ORM | Drizzle | Type-safe, lightweight, D1-compatible |
| Frontend (backend UI) | React | Consistent with existing tooling |
| Automation | Make (Integromat) for eBay webhooks initially; Cloudflare Workers Cron for scheduled tasks (market capture, email polling); migrate eBay integration to direct API as volume grows |
| AI/Vision | Anthropic Claude API (Sonnet) | Screenshot analysis, photo quick-add, Vinted email parsing |
| Authentication | Single-user — Cloudflare Access (zero-trust, tied to your email) | No multi-user needed for 2+ years. Cloudflare Access is free for up to 50 users. |
| Card data | Lorcana API (api-lorcana.com) + Lorcast API (lorcast.com) | Auto-populate collector numbers, set codes, rarity, ink cost, and card images. See §7.5. |

### 7.3 Card Data APIs (Lorcana)

Two complementary APIs are available for auto-populating card metadata:

**api-lorcana.com** (great-illuminary)
- Swagger/OpenAPI documented
- Comprehensive card data
- Free and open source

**lorcast.com**
- `/cards/:set/:number` endpoint for precise lookups by set code + collector number
- `/cards/search` endpoint with full-text search supporting complex queries
- `/sets` endpoint listing all sets with codes and release dates
- Returns card images, rarity, ink cost, and all gameplay attributes

**Integration approach:** When a card enters inventory (via Cardmarket import, manual entry, or sale), the system uses the Cardmarket Product ID or card name + set name to query these APIs and auto-populate `collector_number`, rarity, and image URL. This data is cached locally in D1 so repeated lookups aren't needed. The user never manually maintains collector numbers.

### 7.3 Database Schema (Simplified)

Three primary tables plus supporting tables:

```
ledger_entries
    id, date, type, platform, platform_ref, card_name, set_name, game,
    product_id, collector_number, category, quantity, unit_price, total_price,
    shipping_cost, platform_fees, other_costs, net_amount, condition,
    grade_company, grade_value, currency_original, currency_rate,
    notes, bundle_id, source, created_at, updated_at

inventory_items
    id, card_name, set_name, game, product_id, collector_number, category,
    condition, grade_company, grade_value, quantity_total, quantity_available,
    quantity_listed, quantity_reserved, quantity_grading, cost_basis_avg,
    cost_basis_total, market_value_current, location, first_acquired,
    last_acquired, updated_at

market_data_records
    id, card_name, set_name, game, source, price, shipping, condition,
    listing_type, date_sold, date_captured, graded, grade_company,
    grade_value, seller_name, capture_method, created_at

price_alerts
    id, card_name, set_name, game, alert_type, threshold_value,
    threshold_unit, enabled, last_triggered, channel, created_at

saved_searches
    id, label, url, platform, frequency_minutes, last_captured, enabled, created_at

card_data_cache
    id, card_name, set_name, set_code, collector_number, game, rarity,
    ink_cost, ink_color, card_type, image_url, cardmarket_product_id,
    lorcana_api_id, lorcast_id, last_refreshed, created_at

cardmarket_sellers
    id, username, country, is_professional, vat_number, first_purchase_date,
    total_orders, total_spend, created_at, updated_at
```

### 7.4 API Endpoints (Draft)

```
# Ledger
POST   /api/ledger/entries              Create entry (manual or automated)
GET    /api/ledger/entries              List entries (filterable, paginated)
PUT    /api/ledger/entries/:id          Update entry
DELETE /api/ledger/entries/:id          Delete entry
POST   /api/ledger/import/cardmarket    Upload Cardmarket export
GET    /api/ledger/report/hmrc/:year    Generate HMRC summary

# Inventory
GET    /api/inventory                   List inventory (filterable)
GET    /api/inventory/:id               Get single item detail
PUT    /api/inventory/:id/status        Change status (reserve, send to grading, etc.)
PUT    /api/inventory/:id/location      Update location
GET    /api/inventory/valuation         Portfolio valuation summary

# Market Data
POST   /api/market/scan                 Submit screenshot for analysis
GET    /api/market/prices/:card         Get price history for a card
GET    /api/market/metrics/:card        Get derived metrics for a card
GET    /api/market/alerts               List configured alerts
POST   /api/market/alerts               Create alert
PUT    /api/market/alerts/:id           Update alert
GET    /api/market/restock              Get restock recommendations

# Saved Searches
GET    /api/searches                    List saved searches
POST   /api/searches                    Add search
DELETE /api/searches/:id                Remove search

# Integration Triggers (called by Make / eBay)
POST   /api/webhooks/ebay/sale          Incoming eBay sale notification
POST   /api/webhooks/vinted/sale        Incoming Vinted sale notification (future)
```

---

## 8. Phased Delivery

### Phase 1: Foundation (Build First)

**Goal:** Replace manual ledger and inventory tracking.

- [ ] Database schema and migrations
- [ ] Ledger CRUD operations
- [ ] Cardmarket import processor (Articles + Orders files, auto-splits shipping and trustee fees)
- [ ] Inventory management (add, deduct, status, location)
- [ ] Manual entry interface for purchases and sales
- [ ] Basic inventory dashboard
- [ ] Photo quick-add for single cards

### Phase 2: eBay Integration

**Goal:** Automate the biggest time sink.

- [ ] eBay sale webhook receiver (via Make)
- [ ] Auto-match sale to inventory
- [ ] Auto-create ledger entries for sales and fees
- [ ] Multi-platform listing deconfliction (flag when sold elsewhere)

### Phase 3: Market Intelligence

**Goal:** Data-driven pricing and purchasing decisions.

- [ ] Screenshot-based market data capture
- [ ] Saved search management
- [ ] Market metrics calculation engine
- [ ] Auction vs BIN separated analysis
- [ ] Price alert system
- [ ] Restock scoring and recommendations
- [ ] Pricing tool with fee-adjusted suggestions

### Phase 4: Reporting & Compliance

**Goal:** HMRC-ready financials.

- [ ] Tax year reporting
- [ ] COGS calculation
- [ ] Stock valuation
- [ ] Expense categorisation
- [ ] CSV/PDF export

### Phase 5: Online Store & Expansion

**Goal:** Direct sales channel and multi-TCG support.

- [ ] Customer-facing storefront (separate spec)
- [ ] Inventory → store listing sync
- [ ] Multi-TCG data model validation
- [ ] Social media content tools

---

## 9. Open Questions & Decisions Needed

| # | Question | Status |
|---|----------|--------|
| 1 | HMRC treatment of card-for-card trades | **RESOLVED** — Record as simultaneous sale + purchase at market value. Accountant confirmation still recommended but system records transparently either way. |
| 2 | Cloudflare Workers compatibility (D1 limits, Worker CPU time) | **RESOLVED** — D1 supports 10 GB per database, more than sufficient. Worker CPU limit is 30 seconds on paid plan, enough for single screenshot analysis. Batch processing via Cloudflare Queues if needed. See §7.1. |
| 3 | eBay API tier — basic developer access vs Make | **RESOLVED** — eBay Developer Program offers free API access. Sell APIs (Fulfillment, Inventory, Finances) cover order management and transaction data. Use Make for MVP webhook relay, migrate to direct eBay API (Fulfillment API for orders, Finances API for payouts/fees) as integration matures. 5,000 calls/day rate limit is not a concern at current volume. Register at developer.ebay.com — requires separate account from seller account, review takes ~1 business day. |
| 4 | Cardmarket full purchase history | **IN PROGRESS** — Expected within 1–2 weeks. Will be imported using the same Articles + Orders dual-file processor built in Phase 1. |
| 5 | Vinted integration | **RESOLVED** — Gmail email parsing via Gmail MCP connector. Filter for Vinted purchase confirmation emails by sender + subject keywords. Extracted data presented for user confirmation before ledger entry. See §4.3.1. |
| 6 | Grading workflow detail | **PARTIALLY RESOLVED** — Grading provider is PSA. Inventory status `GRADING` tracks cards sent for grading. Grading cost recorded as `FEE` ledger entry. On return, condition updates to `GRADED` with `grade_company = PSA` and `grade_value` populated. Detailed submission batch tracking (which cards in which submission, turnaround tracking, insurance) deferred to future spec. |
| 7 | Mobile interface priority | **RESOLVED** — Responsive web, not urgent. Backend UI will be functional on mobile from launch but optimised for desktop. |
| 8 | Collector number auto-population | **RESOLVED** — Two Lorcana APIs available: api-lorcana.com (Swagger-documented, comprehensive) and lorcast.com (set/number lookup, full-text search). System queries by card name + set, caches results in `card_data_cache` table. User never manually maintains collector numbers. See §7.3. |

---

## 10. Appendices

### A. Cardmarket Export Schemas

Full schemas for both file types are documented in §4.2.1 (Purchase Import). Key points:

- **Articles file:** Per-item costs, quantities, card details, Cardmarket Product IDs
- **Orders file:** Per-order shipping costs, trustee fees, seller details, country, VAT status
- **Join key:** OrderID (Orders) = Shipment nr. (Articles)
- **Decimal format:** European comma-separated (e.g., "67,84" = 67.84)
- **Multi-item orders:** Continuation rows in Orders file have blank OrderID — Description/Product ID only

### B. Current Inventory Profile (from Cardmarket Exports)

Based on Nov 2025 – Apr 2026 purchase data (does not include eBay purchases, Vinted, or in-person):

- **84 purchase line items** across 74 orders
- **£2,353.05** merchandise spend + **£315.23** shipping + **£13.18** trustee fees = **£2,708.98** total
- **Primary product lines:** Promos Year 1, Promos Year 2, Promos Year 3
- **Key cards by volume:** Stitch - High Badness Level (61 units), Jasmine - Soothing Princess (20 units), Dumbo - The Flying Elephant (15 units)
- **Expansion into:** Azurite Sea, Shimmering Skies, Whispers in the Well, Winterspell, Fabled
- **Sourcing geography:** 11 countries across Europe (highest volume from Germany, Poland, Belgium)
- **Seller mix:** ~14% professional sellers (some with VAT numbers)

### C. Platform Fee Reference

| Platform | Fee Structure |
|----------|--------------|
| eBay UK | ~13.5% final value fee (category dependent) + £0.30 per order regulatory fee |
| Cardmarket (buying) | Trustee service fee: variable, typically £0–£2 per order (£13.18 across 74 orders = avg £0.18/order). Shipping: variable by seller country (£315.23 across 74 orders = avg £4.26/order, 13.4% of merchandise value). |
| Cardmarket (selling) | ~5% seller commission (relevant if selling via CM in future) |
| Vinted | ~5% buyer protection fee (paid by buyer, but affects pricing) |
| Online Store | Payment processor only (Stripe ~2.9% + 20p, or PayPal ~3.4% + 30p) |
| In-person | 0% (cash/bank transfer) |

### D. eBay Developer API — Relevant Endpoints

| API | Purpose | Access |
|-----|---------|--------|
| Fulfillment API | Order data, shipping, tracking | Free — standard developer access |
| Finances API | Transaction details, payouts, fee breakdowns | Free — standard developer access |
| Inventory API | Create/manage listings programmatically | Free — standard developer access |
| Browse API | Search active listings (competitors, pricing) | Free — active listings only. Sold data restricted. |
| Marketplace Insights API | Sold item data (like Terapeak) | **Restricted** — not available to individual developers |

### E. Lorcana Card Data APIs

| API | Base URL | Key Features |
|-----|----------|--------------|
| api-lorcana.com | `https://api-lorcana.com` | Swagger docs, comprehensive data, open source |
| lorcana-api.com | `https://api.lorcana-api.com` | `/cards/all`, `/cards/fetch` with search/filter, 1000 cards per page |
| lorcast.com | `https://lorcast.com` | `/cards/:set/:number` precise lookup, `/cards/search` full-text, `/sets` listing |

---

*End of Specification — Version 1.1*
