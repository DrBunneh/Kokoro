import { Hono } from "hono";
import type { Env } from "../index";

export const ledgerRoutes = new Hono<{ Bindings: Env }>();

// Implemented in WP5
ledgerRoutes.get("/", (c) => c.json({ message: "Ledger routes — coming in WP5" }));
