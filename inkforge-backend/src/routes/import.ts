import { Hono } from "hono";
import type { Env } from "../index";

export const importRoutes = new Hono<{ Bindings: Env }>();

// Implemented in WP4
importRoutes.get("/", (c) => c.json({ message: "Import routes — coming in WP4" }));
