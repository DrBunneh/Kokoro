import { useState, useEffect, useCallback } from "react";
import {
  getInventory, getInventoryValuation, updateInventoryStatus, updateInventoryLocation,
  penceToGBP, type InventoryItem, type InventoryListResult,
} from "../api";

const LOCATIONS = [
  "home_binder_a", "home_binder_b", "home_storage",
  "listed_ebay", "listed_store", "trade_show_kit",
  "grading_submission", "other",
] as const;

export function InventoryPage() {
  const [data, setData] = useState<InventoryListResult | null>(null);
  const [valuation, setValuation] = useState<{
    total_cost_basis_pence: number; item_count: number; unit_count: number;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusTarget, setStatusTarget] = useState("LISTED");
  const [statusQty, setStatusQty] = useState("");
  const [locationTarget, setLocationTarget] = useState("home_storage");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [d, v] = await Promise.all([getInventory({ limit: "200" }), getInventoryValuation()]);
    setData(d);
    setValuation(v);
    setSelected(new Set());
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const applyStatus = async () => {
    setErr("");
    const qty = statusQty ? parseInt(statusQty, 10) : undefined;
    try {
      await Promise.all([...selected].map((id) => updateInventoryStatus(id, statusTarget, qty)));
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  const applyLocation = async () => {
    setErr("");
    try {
      await Promise.all([...selected].map((id) => updateInventoryLocation(id, locationTarget)));
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div>
      <h2>Inventory</h2>
      {valuation && (
        <div style={summaryBox}>
          <span>Items: <strong>{valuation.item_count}</strong></span>
          <span>Units: <strong>{valuation.unit_count}</strong></span>
          <span>Cost Basis: <strong>{penceToGBP(valuation.total_cost_basis_pence)}</strong></span>
        </div>
      )}

      {selected.size > 0 && (
        <div style={actionBar}>
          <strong>{selected.size} selected</strong>
          <label>Status:
            <select value={statusTarget} onChange={(e) => setStatusTarget(e.target.value)}>
              {["LISTED", "RESERVED", "GRADING", "AVAILABLE"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <input type="number" min="1" placeholder="qty (all)" value={statusQty}
            onChange={(e) => setStatusQty(e.target.value)} style={{ width: 80 }} />
          <button onClick={applyStatus} style={btnPrimary}>Apply Status</button>
          <label>Location:
            <select value={locationTarget} onChange={(e) => setLocationTarget(e.target.value)}>
              {LOCATIONS.map((l) => <option key={l}>{l}</option>)}
            </select>
          </label>
          <button onClick={applyLocation} style={btnSecondary}>Apply Location</button>
          {err && <span style={{ color: "red" }}>{err}</span>}
        </div>
      )}

      {data && (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th>☐</th><th>Card</th><th>Set</th><th>Game</th><th>Cond</th>
                <th>Total</th><th>Avail</th><th>Listed</th><th>Rsv</th><th>Grad</th>
                <th>Avg Cost</th><th>Total Cost</th><th>Location</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <InventoryRow key={item.id} item={item} selected={selected.has(item.id)} onToggle={() => toggle(item.id)} />
              ))}
            </tbody>
          </table>
          <p style={{ color: "#666", fontSize: 13 }}>Showing {data.items.length} of {data.total}</p>
        </div>
      )}
    </div>
  );
}

function InventoryRow({ item, selected, onToggle }: { item: InventoryItem; selected: boolean; onToggle: () => void }) {
  return (
    <tr style={{ background: selected ? "#eff6ff" : undefined }}>
      <td><input type="checkbox" checked={selected} onChange={onToggle} /></td>
      <td>{item.card_name}</td>
      <td>{item.set_name}</td>
      <td>{item.game}</td>
      <td>{item.condition}</td>
      <td><strong>{item.quantity_total}</strong></td>
      <td>{item.quantity_available}</td>
      <td>{item.quantity_listed}</td>
      <td>{item.quantity_reserved}</td>
      <td>{item.quantity_grading}</td>
      <td>{penceToGBP(item.cost_basis_avg_pence)}</td>
      <td>{penceToGBP(item.cost_basis_total_pence)}</td>
      <td style={{ fontSize: 12, color: "#666" }}>{item.location ?? "—"}</td>
    </tr>
  );
}

const summaryBox: React.CSSProperties = {
  display: "flex", gap: 24, flexWrap: "wrap",
  background: "#f0f4ff", borderRadius: 8, padding: "12px 16px", marginBottom: 16,
};

const actionBar: React.CSSProperties = {
  display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center",
  background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8,
  padding: "10px 14px", marginBottom: 16,
};

const tableStyle: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse", fontSize: 13,
};

const btnPrimary: React.CSSProperties = {
  background: "#2563eb", color: "#fff", border: "none",
  borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontWeight: 600,
};

const btnSecondary: React.CSSProperties = {
  background: "#e5e7eb", color: "#374151", border: "none",
  borderRadius: 6, padding: "6px 12px", cursor: "pointer",
};
