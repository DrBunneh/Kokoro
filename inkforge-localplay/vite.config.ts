import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "InkForge LocalPlay",
        short_name: "LocalPlay",
        description: "Offline Lorcana duel simulator",
        theme_color: "#0b1020",
        background_color: "#0b1020",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [],
      },
      workbox: {
        // App shell precache; image runtime caching keyed on the (configurable)
        // image host so a missing/blocked host degrades to placeholders rather
        // than failing the SW install (spec §5.2).
        globPatterns: ["**/*.{js,css,html,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[^/]*duels\.ink\/.*\.webp$/,
            handler: "CacheFirst",
            options: {
              cacheName: "card-images",
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
