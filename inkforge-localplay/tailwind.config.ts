import type { Config } from "tailwindcss";

/**
 * Mobile-first design tokens. Ink colours map to Lorcana's six inks so deck
 * tiles / decklist lines can tint by colour (spec §11.2, §11.4).
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          amber: "#f5a623",
          amethyst: "#9b59b6",
          emerald: "#2ecc71",
          ruby: "#e74c3c",
          sapphire: "#3498db",
          steel: "#95a5a6",
        },
      },
      // Comfortable thumb-reach minimums for primary tap targets.
      minHeight: { tap: "44px" },
      minWidth: { tap: "44px" },
    },
  },
  plugins: [],
} satisfies Config;
