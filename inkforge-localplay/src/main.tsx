import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "@/app/router";
import { notifyReady } from "@/lib/updater";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

// Confirm the current (possibly OTA-applied) web bundle booted OK, so the
// updater doesn't roll it back. No-op on web.
void notifyReady();
