/**
 * Pure, environment-agnostic image helpers (spec §5.2). No DOM/network here so
 * URL building and the deterministic placeholder are unit-testable in Node.
 *
 * Image URL is fully derivable from card id:
 *   full:      {base}/full/{id}.webp
 *   thumbnail: {base}/thumbnail/{id}.webp
 * The base host is configurable/swappable so a blocked host degrades to the
 * placeholder rather than a broken image.
 */
import type { InkColor } from "./card-types";

export type ImageSize = "full" | "thumbnail";

export const DEFAULT_IMAGE_BASE = "https://cards.duels.ink/lorcana/en";

export function buildImageUrl(id: string, size: ImageSize, base = DEFAULT_IMAGE_BASE): string {
  return `${base.replace(/\/$/, "")}/${size}/${id}.webp`;
}

const INK_HEX: Record<InkColor, string> = {
  amber: "#b8860b",
  amethyst: "#7d3c98",
  emerald: "#1e8449",
  ruby: "#a93226",
  sapphire: "#2471a3",
  steel: "#5d6d7e",
};

export interface PlaceholderMeta {
  id: string;
  name?: string;
  cost?: number;
  colors?: InkColor[];
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * Deterministic placeholder (card name + cost + colour). Rendered as an inline
 * SVG data URL so it works fully offline and never shows a broken image.
 */
export function placeholderSvg(meta: PlaceholderMeta): string {
  const color = meta.colors?.[0] ? INK_HEX[meta.colors[0]] : "#334155";
  const name = escapeXml(meta.name ?? meta.id);
  const cost = meta.cost ?? "";
  // Simple, legible card-shaped placeholder; word-wrap handled by foreignObject-free
  // tspan splitting on spaces.
  const words = name.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > 16) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  const tspans = lines
    .slice(0, 4)
    .map((l, i) => `<tspan x="50%" dy="${i === 0 ? 0 : 18}">${l}</tspan>`)
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="419" viewBox="0 0 300 419">
<rect width="300" height="419" rx="18" fill="${color}"/>
<rect x="10" y="10" width="280" height="399" rx="12" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>
${cost !== "" ? `<circle cx="44" cy="44" r="26" fill="rgba(0,0,0,0.45)"/><text x="44" y="53" font-family="sans-serif" font-size="28" fill="#fff" text-anchor="middle">${cost}</text>` : ""}
<text x="50%" y="55%" font-family="sans-serif" font-size="16" font-weight="600" fill="#fff" text-anchor="middle">${tspans}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
