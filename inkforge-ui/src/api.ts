// ─── Typed API client ─────────────────────────────────────────────────────────

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options);
  const json = await res.json() as { success: boolean; data?: T; error?: string };
  if (!json.success) throw new Error(json.error ?? "API error");
  return json.data as T;
}

// ─── Types (mirroring backend schema) ────────────────────────────────────────

export interface LedgerEntry {
  id: string;
  date: string;
  type: string;
  platform: string;
  platform_ref: string | null;
  card_name: string;
  set_name: string;
  game: string;
  category: string;
  quantity: number;
  unit_price_pence: number;
  total_price_pence: number;
  shipping_cost_pence: number | null;
  platform_fees_pence: number | null;
  net_amount_pence: number;
  condition: string;
  notes: string | null;
  bundle_id: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface InventoryItem {
  id: string;
  card_name: string;
  set_name: string;
  game: string;
  category: string;
  condition: string;
  quantity_total: number;
  quantity_available: number;
  quantity_listed: number;
  quantity_reserved: number;
  quantity_grading: number;
  cost_basis_avg_pence: number;
  cost_basis_total_pence: number;
  market_value_pence: number | null;
  location: string | null;
}

export interface ImportPreview {
  staging_id: string;
  preview: {
    orders_count: number;
    line_items_count: number;
    merchandise_total: string;
    shipping_total: string;
    trustee_fees_total: string;
    grand_total: string;
    articles: Array<{
      shipment_nr: string;
      date: string;
      card_name: string;
      expansion: string;
      amount: number;
      unit_price: string;
      total: string;
    }>;
  };
}

export interface CardSearchResult {
  cardName: string;
  setName: string;
  rarity: string | null;
  inkColor: string | null;
  imageUrl: string | null;
}

// ─── Ledger API ───────────────────────────────────────────────────────────────

export interface LedgerListResult {
  entries: LedgerEntry[];
  total: number;
  page: number;
  limit: number;
}

export async function getLedgerEntries(params?: Record<string, string>): Promise<LedgerListResult> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return request<LedgerListResult>(`/ledger${qs}`);
}

export async function getLedgerSummary(params?: Record<string, string>): Promise<{
  total_income_pence: number;
  total_expenses_pence: number;
  net_pnl_pence: number;
  entries_count: number;
}> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return request(`/ledger/summary${qs}`);
}

export async function createLedgerEntry(body: Record<string, unknown>): Promise<{ entry: LedgerEntry } | { entries: LedgerEntry[] }> {
  return request(`/ledger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteLedgerEntry(id: string): Promise<void> {
  await request(`/ledger/${id}`, { method: "DELETE" });
}

// ─── Inventory API ────────────────────────────────────────────────────────────

export interface InventoryListResult {
  items: InventoryItem[];
  total: number;
  page: number;
  limit: number;
}

export async function getInventory(params?: Record<string, string>): Promise<InventoryListResult> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return request<InventoryListResult>(`/inventory${qs}`);
}

export async function updateInventoryStatus(id: string, status: string, quantity?: number): Promise<{ item: InventoryItem }> {
  return request(`/inventory/${id}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, quantity }),
  });
}

export async function updateInventoryLocation(id: string, location: string): Promise<{ item: InventoryItem }> {
  return request(`/inventory/${id}/location`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location }),
  });
}

export async function getInventoryValuation(): Promise<{
  total_cost_basis_pence: number;
  total_market_value_pence: number | null;
  unrealised_pnl_pence: number | null;
  item_count: number;
  unit_count: number;
}> {
  return request(`/inventory/valuation`);
}

// ─── Import API ───────────────────────────────────────────────────────────────

export async function uploadImportFiles(articles: File, orders: File): Promise<ImportPreview> {
  const form = new FormData();
  form.append("articles", articles);
  form.append("orders", orders);
  return request<ImportPreview>(`/import/cardmarket/upload`, { method: "POST", body: form });
}

export async function confirmImport(staging_id: string): Promise<{
  entries_created: number;
  fees_created: number;
  rows_skipped: number;
  sellers_upserted: number;
}> {
  return request(`/import/cardmarket/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ staging_id }),
  });
}

// ─── Cards API ────────────────────────────────────────────────────────────────

export async function searchCards(q: string, game = "lorcana"): Promise<CardSearchResult[]> {
  if (q.length < 2) return [];
  return request<CardSearchResult[]>(`/cards/search?q=${encodeURIComponent(q)}&game=${game}`);
}

export async function identifyCard(image: File): Promise<{
  card_name: string;
  set_name: string;
  game: string;
  condition_estimate: string;
}> {
  const form = new FormData();
  form.append("image", image);
  return request(`/cards/identify`, { method: "POST", body: form });
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function penceToGBP(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export function gbpToPence(gbp: string): number {
  return Math.round(parseFloat(gbp) * 100);
}
