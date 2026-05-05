import { Hono } from "hono";
import type { Env } from "../index";

export const marketRoutes = new Hono<{ Bindings: Env }>();

// Implemented in Phase 3
marketRoutes.get("/", (c) => c.json({ message: "Market data routes — coming in Phase 3" }));
