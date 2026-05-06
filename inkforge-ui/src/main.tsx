import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Global table cell styles injected via a style tag
const style = document.createElement("style");
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: 500; }
  input, select { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; width: 100%; }
  th { background: #f3f4f6; text-align: left; padding: 8px 10px; font-size: 13px; border-bottom: 2px solid #e5e7eb; }
  td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; }
  tr:hover td { background: #f9fafb; }
  @media (max-width: 600px) {
    th, td { padding: 5px 6px; font-size: 12px; }
  }
`;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
