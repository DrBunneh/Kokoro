import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Test config kept separate from vite.config.ts: the engine test surface runs
 * in plain Node and needs none of the React/PWA build plugins, which also
 * avoids a vite/vitest plugin-type mismatch.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
