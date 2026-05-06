import { useState, useEffect } from "react";
import {
  getLedgerEntries, getLedgerSummary, getInventory, getInventoryValuation,
  penceToGBP,
} from "../api";
import type { LedgerListResult, InventoryListResult } from "../api";

interface SummaryData {
  total_income_pence: number;
  total_expenses_pence: number;
  net_pnl_pence: number;
  entries_count: number;
}

interface MonthlyPnL {
  month: string; // "YYYY-MM"
  income: number;
  expenses: number;
  net: number;
}

// ─── Utility: build monthly P&L from ledger entries ──────────────────────────

function buildMonthlyPnL(entries: LedgerListResult["entries"]): MonthlyPnL[] {
  const byMonth = new Map<string, MonthlyPnL>();

  for (const e of entries) {
    const month = e.date.slice(0, 7);
    const row = byMonth.get(month) ?? { month, income: 0, expenses: 0, net: 0 };
    if (e.type === "SALE") row.income += e.net_amount_pence;
    else if (e.type === "PURCHASE" || e.type === "FEE" || e.type === "WRITE_OFF") row.expenses += e.net_amount_pence;
    row.net = row.income - row.expenses;
    byMonth.set(month, row);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

// ─── Utility: group inventory by game ────────────────────────────────────────

function groupByGame(items: InventoryListResult["items"]) {
  const map = new Map<string, { units: number; cost: number }>();
  for (const item of items) {
    const g = map.get(item.game) ?? { units: 0, cost: 0 };
    g.units += item.quantity_total;
    g.cost += item.cost_basis_total_pence;
    map.set(item.game, g);
  }
  return [...map.entries()].sort(([, a], [, b]) => b.cost - a.cost);
}

// ─── SVG bar chart component ──────────────────────────────────────────────────

function BarChart({ data }: { data: MonthlyPnL[] }) {
  if (data.length === 0) return <p style={{ color: "#999" }}>No data yet.</p>;

  const maxVal = Math.max(...data.map((d) => Math.max(d.income, d.expenses, 1)));
  const H = 120;
  const barW = Math.max(12, Math.floor(480 / (data.length * 3 + 1)));
  const gap = Math.floor(barW * 0.5);
  const totalW = data.length * (barW * 2 + gap) + gap;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={totalW} height={H + 30} style={{ display: "block" }}>
        {data.map((d, i) => {
          const x = i * (barW * 2 + gap) + gap;
          const incH = Math.round((d.income / maxVal) * H);
          const expH = Math.round((d.expenses / maxVal) * H);
          return (
            <g key={d.month}>
              {/* Income bar */}
              <rect x={x} y={H - incH} width={barW} height={incH} fill="#16a34a" opacity={0.8} />
              {/* Expenses bar */}
              <rect x={x + barW} y={H - expH} width={barW} height={expH} fill="#dc2626" opacity={0.8} />
              {/* Month label */}
              <text x={x + barW} y={H + 18} textAnchor="middle" fontSize={9} fill="#666">
                {d.month.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#666", marginTop: 4 }}>
        <span><span style={{ background: "#16a34a", display: "inline-block", width: 10, height: 10, marginRight: 4 }} />Income</span>
        <span><span style={{ background: "#dc2626", display: "inline-block", width: 10, height: 10, marginRight: 4 }} />Expenses</span>
      </div>
    </div>
  );
}

// ─── Dashboard Page ────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [ledger, setLedger] = useState<LedgerListResult | null>(null);
  const [allLedger, setAllLedger] = useState<LedgerListResult | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [inventory, setInventory] = useState<InventoryListResult | null>(null);
  const [valuation, setValuation] = useState<{
    total_cost_basis_pence: number;
    total_market_value_pence: number | null;
    unrealised_pnl_pence: number | null;
    item_count: number;
    unit_count: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterGame, setFilterGame] = useState("");
  const currentMonth = new Date().toISOString().slice(0, 7);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const params: Record<string, string> = {};
      if (filterGame) params["game"] = filterGame;

      const [led, allLed, sum, inv, val] = await Promise.all([
        getLedgerEntries({ ...params, limit: "20" }),
        getLedgerEntries({ ...params, limit: "500" }),
        getLedgerSummary(params),
        getInventory({ ...params, limit: "500" }),
        getInventoryValuation(),
      ]);
      setLedger(led);
      setAllLedger(allLed);
      setSummary(sum);
      setInventory(inv);
      setValuation(val);
      setLoading(false);
    };
    load();
  }, [filterGame]);

  const monthly = allLedger ? buildMonthlyPnL(allLedger.entries) : [];
  const byGame = inventory ? groupByGame(inventory.items) : [];
  const aged90 = inventory
    ? inventory.items.filter((i) => {
        // We don't have first_acquired in the serialized InventoryItem — use a proxy: items with high cost
        return i.quantity_total > 0;
      })
    : [];

  // This month summary
  const thisMonthData = monthly.find((m) => m.month === currentMonth);

  return (
    <div>
      {/* Filters */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
          Game:
          <select value={filterGame} onChange={(e) => setFilterGame(e.target.value)} style={{ padding: "4px 8px" }}>
            <option value="">All</option>
            {["lorcana", "pokemon", "mtg", "yugioh", "onepiece", "other"].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        {loading && <span style={{ color: "#999", fontSize: 13 }}>Loading…</span>}
      </div>

      {/* Summary Cards */}
      <div style={summaryGrid}>
        <SummaryCard label="Inventory Items" value={String(valuation?.item_count ?? "—")} sub={`${valuation?.unit_count ?? 0} units`} />
        <SummaryCard label="Cost Basis" value={valuation ? penceToGBP(valuation.total_cost_basis_pence) : "—"} sub="total deployed" />
        <SummaryCard
          label="Market Value"
          value={valuation?.total_market_value_pence != null ? penceToGBP(valuation.total_market_value_pence) : "Pending"}
          sub="Phase 3 populates this"
          muted={valuation?.total_market_value_pence == null}
        />
        <SummaryCard
          label="Unrealised P&L"
          value={valuation?.unrealised_pnl_pence != null ? penceToGBP(valuation.unrealised_pnl_pence) : "Pending"}
          sub="market - cost basis"
          muted={valuation?.unrealised_pnl_pence == null}
          positive={valuation?.unrealised_pnl_pence != null && valuation.unrealised_pnl_pence >= 0}
        />
        <SummaryCard
          label="Total Income"
          value={summary ? penceToGBP(summary.total_income_pence) : "—"}
          sub="all time sales"
          positive
        />
        <SummaryCard
          label="Net P&L"
          value={summary ? penceToGBP(summary.net_pnl_pence) : "—"}
          sub="income − expenses"
          positive={summary != null && summary.net_pnl_pence >= 0}
        />
        {thisMonthData && (
          <SummaryCard
            label="This Month"
            value={penceToGBP(thisMonthData.net)}
            sub={`£${(thisMonthData.income / 100).toFixed(0)} in / £${(thisMonthData.expenses / 100).toFixed(0)} out`}
            positive={thisMonthData.net >= 0}
          />
        )}
      </div>

      {/* Main content grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 24 }}>
        {/* Recent Transactions */}
        <section style={cardStyle}>
          <h3 style={sectionTitle}>Recent Transactions</h3>
          {ledger && ledger.entries.length === 0 && <p style={{ color: "#999" }}>No entries yet.</p>}
          {ledger && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {ledger.entries.slice(0, 20).map((e) => (
                  <tr key={e.id}>
                    <td style={{ padding: "4px 0", color: "#666", width: 80 }}>{e.date.slice(0, 10)}</td>
                    <td><span style={typeBadge(e.type)}>{e.type}</span></td>
                    <td style={{ padding: "4px 6px" }}>{e.card_name}</td>
                    <td style={{ textAlign: "right", fontWeight: 600, color: e.type === "SALE" ? "#16a34a" : "#dc2626" }}>
                      {penceToGBP(e.net_amount_pence)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Inventory by Game */}
        <section style={cardStyle}>
          <h3 style={sectionTitle}>Stock by Game</h3>
          {byGame.length === 0 && <p style={{ color: "#999" }}>No inventory yet.</p>}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr><th style={th}>Game</th><th style={th}>Units</th><th style={th}>Cost Basis</th></tr>
            </thead>
            <tbody>
              {byGame.map(([game, data]) => (
                <tr key={game}>
                  <td style={td}>{game}</td>
                  <td style={td}>{data.units}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{penceToGBP(data.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* Monthly P&L Chart */}
      <section style={{ ...cardStyle, marginTop: 24 }}>
        <h3 style={sectionTitle}>Monthly P&L</h3>
        <BarChart data={monthly} />
      </section>

      {/* Top inventory items by cost */}
      <section style={{ ...cardStyle, marginTop: 24 }}>
        <h3 style={sectionTitle}>Top Holdings by Capital Deployed</h3>
        {aged90.length === 0 && <p style={{ color: "#999" }}>No inventory yet.</p>}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={th}>Card</th><th style={th}>Set</th><th style={th}>Game</th>
                <th style={th}>Units</th><th style={th}>Avg Cost</th><th style={th}>Total Cost</th>
                <th style={th}>Market Value</th>
              </tr>
            </thead>
            <tbody>
              {inventory?.items
                .filter((i) => i.quantity_total > 0)
                .sort((a, b) => b.cost_basis_total_pence - a.cost_basis_total_pence)
                .slice(0, 15)
                .map((item) => (
                  <tr key={item.id}>
                    <td style={td}>{item.card_name}</td>
                    <td style={td}>{item.set_name}</td>
                    <td style={td}>{item.game}</td>
                    <td style={td}>{item.quantity_total}</td>
                    <td style={td}>{penceToGBP(item.cost_basis_avg_pence)}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{penceToGBP(item.cost_basis_total_pence)}</td>
                    <td style={{ ...td, color: "#999" }}>
                      {item.market_value_pence ? penceToGBP(item.market_value_pence) : "Pending"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, muted, positive }: {
  label: string; value: string; sub?: string; muted?: boolean; positive?: boolean;
}) {
  return (
    <div style={summaryCard}>
      <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: muted ? "#9ca3af" : positive === false ? "#dc2626" : positive ? "#16a34a" : "#111", margin: "4px 0" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#9ca3af" }}>{sub}</div>}
    </div>
  );
}

function typeBadge(type: string): React.CSSProperties {
  const colors: Record<string, string> = {
    PURCHASE: "#dbeafe", SALE: "#dcfce7", FEE: "#fef9c3",
    WRITE_OFF: "#fee2e2", TRADE: "#ede9fe", ADJUSTMENT: "#f3f4f6", PRIZE: "#fdf4ff",
  };
  return {
    background: colors[type] ?? "#f3f4f6", padding: "1px 6px",
    borderRadius: 4, fontSize: 11, fontWeight: 600, display: "inline-block",
  };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const summaryGrid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12,
};

const summaryCard: React.CSSProperties = {
  background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "14px 16px",
};

const cardStyle: React.CSSProperties = {
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16,
};

const sectionTitle: React.CSSProperties = {
  margin: "0 0 12px", fontSize: 15, fontWeight: 600, color: "#374151",
};

const th: React.CSSProperties = {
  background: "#f3f4f6", textAlign: "left", padding: "6px 8px",
  fontSize: 12, fontWeight: 600, borderBottom: "1px solid #e5e7eb",
};

const td: React.CSSProperties = {
  padding: "6px 8px", borderBottom: "1px solid #f3f4f6", fontSize: 13,
};
