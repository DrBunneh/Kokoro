import { Hono } from "hono";
import type { Env } from "../index";

export const inventoryRoutes = new Hono<{ Bindings: Env }>();

// Implemented in WP6
inventoryRoutes.get("/", (c) => c.json({ message: "Inventory routes — coming in WP6" }));
