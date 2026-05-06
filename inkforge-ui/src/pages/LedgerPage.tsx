import { useState, useEffect, useCallback } from "react";
import {
  getLedgerEntries, getLedgerSummary, createLedgerEntry, deleteLedgerEntry,
  penceToGBP, gbpToPence,
  type LedgerListResult,
} from "../api";
import { CardAutocomplete } from "../components/CardAutocomplete";

// ─── Shared form field types ───────────────────────────────────────────────────

type FormMode = "purchase" | "sale" | "write_off" | "trade" | "quick_add" | null;

const GAMES = ["lorcana", "pokemon", "mtg", "yugioh", "onepiece", "other"] as const;
const PLATFORMS = ["cardmarket", "ebay_uk", "vinted", "in_person", "online_store", "other"] as const;
const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG", "SEALED", "GRADED"] as const;
const CATEGORIES = ["single", "sealed_booster", "sealed_box", "sealed_case", "memorabilia", "accessory", "bundle"] as const;

interface BaseFields {
  card_name: string;
  set_name: string;
  game: string;
  category: string;
  condition: string;
  quantity: string;
  unit_price: string; // GBP string
  platform: string;
  notes: string;
}

const defaultBase: BaseFields = {
  card_name: "", set_name: "", game: "lorcana", category: "single",
  condition: "NM", quantity: "1", unit_price: "", platform: "cardmarket", notes: "",
};

// ─── Purchase Form ─────────────────────────────────────────────────────────────

function PurchaseForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ ...defaultBase, shipping: "", date: new Date().toISOString().slice(0, 10) });
  const [err, setErr] = useState("");

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setErr("");
    try {
      await createLedgerEntry({
        type: "PURCHASE", date: f.date, platform: f.platform,
        card_name: f.card_name, set_name: f.set_name, game: f.game,
        category: f.category, condition: f.condition,
        quantity: parseInt(f.quantity, 10),
        unit_price_pence: gbpToPence(f.unit_price),
        shipping_cost_pence: f.shipping ? gbpToPence(f.shipping) : 0,
        notes: f.notes || null,
        source: "manual",
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div style={formStyle}>
      <h3>New Purchase</h3>
      {err && <p style={{ color: "red" }}>{err}</p>}
      <label>Date<input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></label>
      <label>Card Name
        <CardAutocomplete value={f.card_name} game={f.game}
          onChange={(n, s) => { set("card_name", n); if (s) set("set_name", s); }} />
      </label>
      <label>Set Name<input value={f.set_name} onChange={(e) => set("set_name", e.target.value)} /></label>
      <label>Game<select value={f.game} onChange={(e) => set("game", e.target.value)}>
        {GAMES.map((g) => <option key={g}>{g}</option>)}</select></label>
      <label>Category<select value={f.category} onChange={(e) => set("category", e.target.value)}>
        {CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>Condition<select value={f.condition} onChange={(e) => set("condition", e.target.value)}>
        {CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>Quantity<input type="number" min="1" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} /></label>
      <label>Unit Price (£)<input type="number" step="0.01" min="0" value={f.unit_price} onChange={(e) => set("unit_price", e.target.value)} /></label>
      <label>Shipping (£)<input type="number" step="0.01" min="0" value={f.shipping} onChange={(e) => set("shipping", e.target.value)} /></label>
      <label>Platform<select value={f.platform} onChange={(e) => set("platform", e.target.value)}>
        {PLATFORMS.map((p) => <option key={p}>{p}</option>)}</select></label>
      <label>Notes<input value={f.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} style={btnPrimary}>Save Purchase</button>
        <button onClick={onDone} style={btnSecondary}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Sale Form ─────────────────────────────────────────────────────────────────

function SaleForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ ...defaultBase, platform_fees: "", date: new Date().toISOString().slice(0, 10), platform: "ebay_uk" });
  const [err, setErr] = useState("");

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setErr("");
    try {
      await createLedgerEntry({
        type: "SALE", date: f.date, platform: f.platform,
        card_name: f.card_name, set_name: f.set_name, game: f.game,
        category: f.category, condition: f.condition,
        quantity: parseInt(f.quantity, 10),
        unit_price_pence: gbpToPence(f.unit_price),
        platform_fees_pence: f.platform_fees ? gbpToPence(f.platform_fees) : 0,
        notes: f.notes || null, source: "manual",
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div style={formStyle}>
      <h3>New Sale</h3>
      {err && <p style={{ color: "red" }}>{err}</p>}
      <label>Date<input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></label>
      <label>Card Name
        <CardAutocomplete value={f.card_name} game={f.game}
          onChange={(n, s) => { set("card_name", n); if (s) set("set_name", s); }} />
      </label>
      <label>Set Name<input value={f.set_name} onChange={(e) => set("set_name", e.target.value)} /></label>
      <label>Game<select value={f.game} onChange={(e) => set("game", e.target.value)}>
        {GAMES.map((g) => <option key={g}>{g}</option>)}</select></label>
      <label>Category<select value={f.category} onChange={(e) => set("category", e.target.value)}>
        {CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>Condition<select value={f.condition} onChange={(e) => set("condition", e.target.value)}>
        {CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>Quantity<input type="number" min="1" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} /></label>
      <label>Sale Price (£)<input type="number" step="0.01" min="0" value={f.unit_price} onChange={(e) => set("unit_price", e.target.value)} /></label>
      <label>Platform Fees (£)<input type="number" step="0.01" min="0" value={f.platform_fees} onChange={(e) => set("platform_fees", e.target.value)} /></label>
      <label>Platform<select value={f.platform} onChange={(e) => set("platform", e.target.value)}>
        {PLATFORMS.map((p) => <option key={p}>{p}</option>)}</select></label>
      <label>Notes<input value={f.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} style={btnPrimary}>Save Sale</button>
        <button onClick={onDone} style={btnSecondary}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Write-off Form ────────────────────────────────────────────────────────────

function WriteOffForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ ...defaultBase, date: new Date().toISOString().slice(0, 10) });
  const [err, setErr] = useState("");

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setErr("");
    try {
      await createLedgerEntry({
        type: "WRITE_OFF", date: f.date, platform: "other",
        card_name: f.card_name, set_name: f.set_name, game: f.game,
        category: f.category, condition: f.condition,
        quantity: parseInt(f.quantity, 10),
        unit_price_pence: gbpToPence(f.unit_price),
        notes: f.notes || null, source: "manual",
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div style={formStyle}>
      <h3>Write-Off</h3>
      {err && <p style={{ color: "red" }}>{err}</p>}
      <label>Date<input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></label>
      <label>Card Name
        <CardAutocomplete value={f.card_name} game={f.game}
          onChange={(n, s) => { set("card_name", n); if (s) set("set_name", s); }} />
      </label>
      <label>Set Name<input value={f.set_name} onChange={(e) => set("set_name", e.target.value)} /></label>
      <label>Game<select value={f.game} onChange={(e) => set("game", e.target.value)}>
        {GAMES.map((g) => <option key={g}>{g}</option>)}</select></label>
      <label>Category<select value={f.category} onChange={(e) => set("category", e.target.value)}>
        {CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>Condition<select value={f.condition} onChange={(e) => set("condition", e.target.value)}>
        {CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>Quantity<input type="number" min="1" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} /></label>
      <label>Written-off Value (£)<input type="number" step="0.01" min="0" value={f.unit_price} onChange={(e) => set("unit_price", e.target.value)} /></label>
      <label>Notes<input value={f.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} style={btnPrimary}>Save Write-Off</button>
        <button onClick={onDone} style={btnSecondary}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Trade Form ────────────────────────────────────────────────────────────────

function TradeForm({ onDone }: { onDone: () => void }) {
  const [given, setGiven] = useState({ ...defaultBase });
  const [received, setReceived] = useState({ ...defaultBase });
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState("");

  const setG = (k: string, v: string) => setGiven((p) => ({ ...p, [k]: v }));
  const setR = (k: string, v: string) => setReceived((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setErr("");
    try {
      await createLedgerEntry({
        type: "TRADE", date, platform: "in_person",
        card_name: given.card_name, set_name: given.set_name, game: given.game,
        category: given.category, condition: given.condition,
        quantity: parseInt(given.quantity, 10),
        unit_price_pence: gbpToPence(given.unit_price),
        received_card_name: received.card_name,
        received_set_name: received.set_name,
        received_game: received.game,
        received_category: received.category,
        received_quantity: parseInt(received.quantity, 10),
        received_unit_price_pence: gbpToPence(received.unit_price),
        source: "manual",
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div style={formStyle}>
      <h3>Trade</h3>
      {err && <p style={{ color: "red" }}>{err}</p>}
      <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <h4 style={{ margin: "8px 0 4px" }}>Card Given Away</h4>
          <label>Name
            <CardAutocomplete value={given.card_name} game={given.game}
              onChange={(n, s) => { setG("card_name", n); if (s) setG("set_name", s); }} />
          </label>
          <label>Set<input value={given.set_name} onChange={(e) => setG("set_name", e.target.value)} /></label>
          <label>Qty<input type="number" min="1" value={given.quantity} onChange={(e) => setG("quantity", e.target.value)} /></label>
          <label>Market Value (£)<input type="number" step="0.01" value={given.unit_price} onChange={(e) => setG("unit_price", e.target.value)} /></label>
        </div>
        <div>
          <h4 style={{ margin: "8px 0 4px" }}>Card Received</h4>
          <label>Name
            <CardAutocomplete value={received.card_name} game={received.game}
              onChange={(n, s) => { setR("card_name", n); if (s) setR("set_name", s); }} />
          </label>
          <label>Set<input value={received.set_name} onChange={(e) => setR("set_name", e.target.value)} /></label>
          <label>Qty<input type="number" min="1" value={received.quantity} onChange={(e) => setR("quantity", e.target.value)} /></label>
          <label>Market Value (£)<input type="number" step="0.01" value={received.unit_price} onChange={(e) => setR("unit_price", e.target.value)} /></label>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={submit} style={btnPrimary}>Save Trade</button>
        <button onClick={onDone} style={btnSecondary}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Quick Add (photo → Claude vision) ───────────────────────────────────────

function QuickAdd({ onDone }: { onDone: () => void }) {
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [identified, setIdentified] = useState<{ card_name: string; set_name: string; game: string; condition_estimate: string } | null>(null);
  const [f, setF] = useState({ unit_price: "", quantity: "1", platform: "cardmarket", category: "single" });
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState("");

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const handleFile = (file: File) => {
    setImage(file);
    setPreview(URL.createObjectURL(file));
    setIdentified(null);
  };

  const identify = async () => {
    if (!image) return;
    setIdentifying(true);
    setErr("");
    try {
      const result = await fetch("/api/cards/identify", {
        method: "POST",
        body: (() => { const fd = new FormData(); fd.append("image", image); return fd; })(),
      });
      const json = await result.json() as { success: boolean; data?: typeof identified; error?: string };
      if (!json.success || !json.data) throw new Error(json.error ?? "Identification failed");
      setIdentified(json.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setIdentifying(false);
    }
  };

  const submit = async () => {
    if (!identified) return;
    setErr("");
    try {
      await createLedgerEntry({
        type: "PURCHASE", date, platform: f.platform,
        card_name: identified.card_name, set_name: identified.set_name, game: identified.game,
        category: f.category, condition: identified.condition_estimate,
        quantity: parseInt(f.quantity, 10),
        unit_price_pence: gbpToPence(f.unit_price),
        source: "manual",
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div style={formStyle}>
      <h3>Quick Add (Photo)</h3>
      {err && <p style={{ color: "red" }}>{err}</p>}
      <input type="file" accept="image/*" capture="environment"
        onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
      {preview && <img src={preview} alt="Card" style={{ maxWidth: 200, marginTop: 8 }} />}
      {image && !identified && (
        <button onClick={identify} disabled={identifying} style={{ ...btnPrimary, marginTop: 8 }}>
          {identifying ? "Identifying…" : "Identify Card"}
        </button>
      )}
      {identified && (
        <div style={{ marginTop: 12 }}>
          <p><strong>{identified.card_name}</strong> — {identified.set_name} ({identified.game})</p>
          <p>Condition estimate: {identified.condition_estimate}</p>
          <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Unit Price (£)<input type="number" step="0.01" min="0" value={f.unit_price} onChange={(e) => set("unit_price", e.target.value)} /></label>
          <label>Quantity<input type="number" min="1" value={f.quantity} onChange={(e) => set("quantity", e.target.value)} /></label>
          <label>Platform<select value={f.platform} onChange={(e) => set("platform", e.target.value)}>
            {PLATFORMS.map((p) => <option key={p}>{p}</option>)}</select></label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={submit} style={btnPrimary}>Save</button>
            <button onClick={onDone} style={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}
      {!identified && <button onClick={onDone} style={{ ...btnSecondary, marginTop: 8 }}>Cancel</button>}
    </div>
  );
}

// ─── Ledger Page ───────────────────────────────────────────────────────────────

export function LedgerPage() {
  const [data, setData] = useState<LedgerListResult | null>(null);
  const [summary, setSummary] = useState<{ total_income_pence: number; total_expenses_pence: number; net_pnl_pence: number } | null>(null);
  const [mode, setMode] = useState<FormMode>(null);
  const [recentlyCreated, setRecentlyCreated] = useState<string[]>([]);

  const load = useCallback(async () => {
    const [d, s] = await Promise.all([getLedgerEntries(), getLedgerSummary()]);
    setData(d);
    setSummary(s);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDone = () => {
    setMode(null);
    load().then(() => {});
  };

  const undo = async (id: string) => {
    if (!confirm("Soft-delete this entry?")) return;
    await deleteLedgerEntry(id);
    setRecentlyCreated((prev) => prev.filter((x) => x !== id));
    load();
  };

  return (
    <div>
      <h2>Ledger</h2>
      {summary && (
        <div style={summaryBox}>
          <span>Income: <strong style={{ color: "#1a7a1a" }}>{penceToGBP(summary.total_income_pence)}</strong></span>
          <span>Expenses: <strong style={{ color: "#a00" }}>{penceToGBP(summary.total_expenses_pence)}</strong></span>
          <span>Net P&amp;L: <strong style={{ color: summary.net_pnl_pence >= 0 ? "#1a7a1a" : "#a00" }}>
            {penceToGBP(summary.net_pnl_pence)}</strong></span>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button onClick={() => setMode("purchase")} style={btnPrimary}>+ Purchase</button>
        <button onClick={() => setMode("sale")} style={btnPrimary}>+ Sale</button>
        <button onClick={() => setMode("write_off")} style={btnPrimary}>+ Write-Off</button>
        <button onClick={() => setMode("trade")} style={btnPrimary}>+ Trade</button>
        <button onClick={() => setMode("quick_add")} style={{ ...btnPrimary, background: "#7c3aed" }}>📷 Quick Add</button>
      </div>

      {mode === "purchase" && <PurchaseForm onDone={handleDone} />}
      {mode === "sale" && <SaleForm onDone={handleDone} />}
      {mode === "write_off" && <WriteOffForm onDone={handleDone} />}
      {mode === "trade" && <TradeForm onDone={handleDone} />}
      {mode === "quick_add" && <QuickAdd onDone={handleDone} />}

      {data && (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th>Date</th><th>Type</th><th>Card</th><th>Set</th>
                <th>Qty</th><th>Unit</th><th>Net</th><th>Platform</th><th></th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id} style={{ background: recentlyCreated.includes(e.id) ? "#fffbeb" : undefined }}>
                  <td>{e.date.slice(0, 10)}</td>
                  <td><span style={typeBadge(e.type)}>{e.type}</span></td>
                  <td>{e.card_name}</td>
                  <td>{e.set_name}</td>
                  <td>{e.quantity}</td>
                  <td>{penceToGBP(e.unit_price_pence)}</td>
                  <td><strong style={{ color: e.type === "SALE" ? "#1a7a1a" : "#a00" }}>{penceToGBP(e.net_amount_pence)}</strong></td>
                  <td>{e.platform}</td>
                  <td>{!e.deleted_at && <button onClick={() => undo(e.id)} style={btnDanger}>Undo</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: "#666", fontSize: 13 }}>Showing {data.entries.length} of {data.total}</p>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const formStyle: React.CSSProperties = {
  background: "#f9f9f9", border: "1px solid #ddd", borderRadius: 8,
  padding: 16, marginBottom: 24, display: "flex", flexDirection: "column", gap: 10,
};

const summaryBox: React.CSSProperties = {
  display: "flex", gap: 24, flexWrap: "wrap",
  background: "#f0f4ff", borderRadius: 8, padding: "12px 16px", marginBottom: 16,
};

const tableStyle: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse", fontSize: 14,
};

const btnPrimary: React.CSSProperties = {
  background: "#2563eb", color: "#fff", border: "none",
  borderRadius: 6, padding: "8px 14px", cursor: "pointer", fontWeight: 600,
};

const btnSecondary: React.CSSProperties = {
  background: "#e5e7eb", color: "#374151", border: "none",
  borderRadius: 6, padding: "8px 14px", cursor: "pointer",
};

const btnDanger: React.CSSProperties = {
  background: "transparent", color: "#b91c1c", border: "none",
  cursor: "pointer", fontSize: 12, textDecoration: "underline",
};

function typeBadge(type: string): React.CSSProperties {
  const colors: Record<string, string> = {
    PURCHASE: "#dbeafe", SALE: "#dcfce7", FEE: "#fef9c3",
    WRITE_OFF: "#fee2e2", TRADE: "#ede9fe", ADJUSTMENT: "#f3f4f6", PRIZE: "#fdf4ff",
  };
  return {
    background: colors[type] ?? "#f3f4f6", padding: "1px 6px",
    borderRadius: 4, fontSize: 11, fontWeight: 600,
  };
}
