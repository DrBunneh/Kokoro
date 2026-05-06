import { Hono } from "hono";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

import { ledgerRoutes } from "./routes/ledger";
import { inventoryRoutes } from "./routes/inventory";
import { importRoutes } from "./routes/import";
import { marketRoutes } from "./routes/market";
import { cardRoutes } from "./routes/cards";

export type Env = {
  DB: D1Database;
  STORAGE: R2Bucket;
  ANTHROPIC_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use("*", prettyJSON());

app.get("/", (c) => {
  return c.json({
    name: "InkForge Backend",
    status: "ok",
    version: "0.1.0",
  });
});

// Smoke-test routes (WP1 acceptance criteria)
app.get("/health/db", async (c) => {
  const result = await c.env.DB.prepare("SELECT 1 as ok").first();
  return c.json({ db: result });
});

app.get("/health/storage", async (c) => {
  await c.env.STORAGE.put("_health_check", "ok");
  const obj = await c.env.STORAGE.get("_health_check");
  const text = await obj?.text();
  await c.env.STORAGE.delete("_health_check");
  return c.json({ storage: text === "ok" ? "ok" : "error" });
});

// API routes (implemented in subsequent WPs)
app.route("/api/ledger", ledgerRoutes);
app.route("/api/inventory", inventoryRoutes);
app.route("/api/import", importRoutes);
app.route("/api/market", marketRoutes);
app.route("/api/cards", cardRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
