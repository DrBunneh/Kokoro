import { useState } from "react";
import { uploadImportFiles, confirmImport, type ImportPreview } from "../api";

export function ImportPage() {
  const [articlesFile, setArticlesFile] = useState<File | null>(null);
  const [ordersFile, setOrdersFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{
    entries_created: number; fees_created: number; rows_skipped: number; sellers_upserted: number;
  } | null>(null);
  const [err, setErr] = useState("");

  const upload = async () => {
    if (!articlesFile || !ordersFile) { setErr("Both files are required"); return; }
    setUploading(true);
    setErr("");
    try {
      const p = await uploadImportFiles(articlesFile, ordersFile);
      setPreview(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setConfirming(true);
    setErr("");
    try {
      const r = await confirmImport(preview.staging_id);
      setResult(r);
      setPreview(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Confirm failed");
    } finally {
      setConfirming(false);
    }
  };

  const reset = () => {
    setArticlesFile(null);
    setOrdersFile(null);
    setPreview(null);
    setResult(null);
    setErr("");
  };

  return (
    <div>
      <h2>Cardmarket Import</h2>
      {err && <p style={{ color: "red" }}>{err}</p>}

      {!preview && !result && (
        <div style={uploadBox}>
          <label>
            Articles File (.xls)
            <input type="file" accept=".xls,.xlsx"
              onChange={(e) => setArticlesFile(e.target.files?.[0] ?? null)} />
            {articlesFile && <span style={{ color: "#166534", marginLeft: 8 }}>✓ {articlesFile.name}</span>}
          </label>
          <label>
            Orders File (.xls)
            <input type="file" accept=".xls,.xlsx"
              onChange={(e) => setOrdersFile(e.target.files?.[0] ?? null)} />
            {ordersFile && <span style={{ color: "#166534", marginLeft: 8 }}>✓ {ordersFile.name}</span>}
          </label>
          <button
            onClick={upload}
            disabled={uploading || !articlesFile || !ordersFile}
            style={btnPrimary}
          >
            {uploading ? "Parsing…" : "Upload & Preview"}
          </button>
        </div>
      )}

      {preview && (
        <div>
          <div style={summaryBox}>
            <div><strong>Orders:</strong> {preview.preview.orders_count}</div>
            <div><strong>Line items:</strong> {preview.preview.line_items_count}</div>
            <div><strong>Merchandise:</strong> £{preview.preview.merchandise_total}</div>
            <div><strong>Shipping:</strong> £{preview.preview.shipping_total}</div>
            <div><strong>Trustee fees:</strong> £{preview.preview.trustee_fees_total}</div>
            <div><strong>Grand total:</strong> £{preview.preview.grand_total}</div>
          </div>

          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th>Shipment</th><th>Date</th><th>Card</th><th>Set</th>
                  <th>Qty</th><th>Unit</th><th>Total</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.articles.map((a, i) => (
                  <tr key={i}>
                    <td>{a.shipment_nr}</td>
                    <td>{a.date.slice(0, 10)}</td>
                    <td>{a.card_name}</td>
                    <td>{a.expansion}</td>
                    <td>{a.amount}</td>
                    <td>£{a.unit_price}</td>
                    <td>£{a.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={confirm} disabled={confirming} style={btnPrimary}>
              {confirming ? "Importing…" : "Confirm Import"}
            </button>
            <button onClick={reset} style={btnSecondary}>Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div style={{ ...summaryBox, background: "#f0fdf4" }}>
          <h3 style={{ margin: 0, width: "100%", color: "#166534" }}>Import Complete</h3>
          <div><strong>Entries created:</strong> {result.entries_created}</div>
          <div><strong>Fees created:</strong> {result.fees_created}</div>
          <div><strong>Rows skipped:</strong> {result.rows_skipped}</div>
          <div><strong>Sellers upserted:</strong> {result.sellers_upserted}</div>
          <button onClick={reset} style={btnPrimary}>Import Another</button>
        </div>
      )}
    </div>
  );
}

const uploadBox: React.CSSProperties = {
  background: "#f9f9f9", border: "2px dashed #d1d5db", borderRadius: 8,
  padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 480,
};

const summaryBox: React.CSSProperties = {
  display: "flex", gap: 24, flexWrap: "wrap",
  background: "#f0f4ff", borderRadius: 8, padding: "12px 16px", marginBottom: 16,
};

const tableStyle: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse", fontSize: 13,
};

const btnPrimary: React.CSSProperties = {
  background: "#2563eb", color: "#fff", border: "none",
  borderRadius: 6, padding: "8px 16px", cursor: "pointer", fontWeight: 600,
};

const btnSecondary: React.CSSProperties = {
  background: "#e5e7eb", color: "#374151", border: "none",
  borderRadius: 6, padding: "8px 16px", cursor: "pointer",
};
