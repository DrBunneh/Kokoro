import type { InkColor } from "@/data/card-types";

export const INK_COLORS: InkColor[] = [
  "amber",
  "amethyst",
  "emerald",
  "ruby",
  "sapphire",
  "steel",
];

export const INK_HEX: Record<InkColor, string> = {
  amber: "#b8860b",
  amethyst: "#7d3c98",
  emerald: "#1e8449",
  ruby: "#a93226",
  sapphire: "#2471a3",
  steel: "#5d6d7e",
};

export function inkLabel(c: InkColor): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}
