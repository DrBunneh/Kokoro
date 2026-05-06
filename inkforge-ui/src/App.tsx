import { useState } from "react";
import { DashboardPage } from "./pages/DashboardPage";
import { LedgerPage } from "./pages/LedgerPage";
import { InventoryPage } from "./pages/InventoryPage";
import { ImportPage } from "./pages/ImportPage";

type Tab = "dashboard" | "ledger" | "inventory" | "import";

const TAB_LABELS: Record<Tab, string> = {
  dashboard: "📊 Dashboard",
  ledger: "📒 Ledger",
  inventory: "📦 Inventory",
  import: "📥 Import",
};

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto", padding: "0 16px" }}>
      <header style={headerStyle}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>InkForge</h1>
        <nav style={{ display: "flex", gap: 4 }}>
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...navBtn,
                background: tab === t ? "#2563eb" : "transparent",
                color: tab === t ? "#fff" : "#374151",
              }}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </header>

      <main style={{ padding: "24px 0" }}>
        {tab === "dashboard" && <DashboardPage />}
        {tab === "ledger" && <LedgerPage />}
        {tab === "inventory" && <InventoryPage />}
        {tab === "import" && <ImportPage />}
      </main>
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 0", borderBottom: "1px solid #e5e7eb", position: "sticky",
  top: 0, background: "#fff", zIndex: 50,
};

const navBtn: React.CSSProperties = {
  border: "none", borderRadius: 6, padding: "6px 14px",
  cursor: "pointer", fontWeight: 500, fontSize: 14, transition: "background 0.1s",
};
