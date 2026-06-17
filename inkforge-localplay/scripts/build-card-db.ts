/**
 * Build-time card DB ingest (spec §5.1).
 *
 * Pulls the Ravensburger catalog from `great-illuminary/lorcana-data`
 * (`data_existing/catalog/en/full.json`, reachable via raw.githubusercontent),
 * normalises it to the printed-card subset the app needs, and writes a bundled
 * JSON to `src/data/cards.generated.json`. No card metadata is fetched at runtime.
 *
 * Run: `npm run build-card-db`  (override source with CARD_DATA_URL=...)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  CardDatabase,
  CardType,
  InkColor,
  PrintedCard,
  SpecialAbility,
} from "../src/data/card-types.ts";

const DEFAULT_SOURCE =
  "https://raw.githubusercontent.com/great-illuminary/lorcana-data/main/data_existing/catalog/en/full.json";

const SOURCE = process.env.CARD_DATA_URL ?? DEFAULT_SOURCE;

interface RawCard {
  name: string;
  subtitle?: string;
  card_identifier: string;
  magic_ink_colors?: string[];
  ink_cost?: number;
  ink_convertible?: boolean;
  strength?: number | null;
  willpower?: number | null;
  quest_value?: number | null;
  move_cost?: number | null;
  abilities?: string[];
  subtypes?: string[];
  rules_text?: string;
  rarity?: string;
}

/** "124/204 EN 6" -> { setNum: 6, cardNum: 124 }. */
function parseIdentifier(identifier: string): { setNum: number; cardNum: number } | null {
  const m = identifier.match(/^\s*(\d+)\s*\/\s*\d+\s*EN\s*(\d+)/i);
  if (!m) return null;
  return { cardNum: Number(m[1]), setNum: Number(m[2]) };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Clean catalog markup: `<Keyword>` markers, `\Name\` markers, stray backslashes. */
function cleanRulesText(raw: string): string {
  return raw
    .replace(/[<>]/g, "")
    .replace(/\\/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Parse named (non-keyword) abilities from rules text. The catalog wraps named
 * ability titles in backslashes: `\Wayfinding\ Whenever you play an action...`.
 */
function parseSpecialAbilities(raw: string): SpecialAbility[] {
  const out: SpecialAbility[] = [];
  const re = /\\([^\\]+?)\\\s*/g;
  const anchors: { name: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    anchors.push({ name: match[1]!.trim(), start: match.index, end: re.lastIndex });
  }
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const sliceEnd = i + 1 < anchors.length ? anchors[i + 1]!.start : raw.length;
    const effect = cleanRulesText(raw.slice(a.end, sliceEnd));
    if (!a.name) continue;
    out.push({ name: a.name, slug: slugify(a.name), effect });
  }
  return out;
}

function normalize(raw: RawCard, type: CardType): PrintedCard | null {
  const ids = parseIdentifier(raw.card_identifier);
  if (!ids) return null;
  const id = `${ids.setNum}-${ids.cardNum}`;
  const title = raw.subtitle?.trim() || undefined;
  const colors = (raw.magic_ink_colors ?? []).map((c) => c.toLowerCase() as InkColor);
  const rulesRaw = raw.rules_text ?? "";

  const card: PrintedCard = {
    id,
    name: raw.name,
    fullName: title ? `${raw.name} - ${title}` : raw.name,
    type,
    colors,
    cost: raw.ink_cost ?? 0,
    inkable: raw.ink_convertible ?? false,
    abilities: (raw.abilities ?? []).map((ability) => ({ ability })),
    specialAbilities: parseSpecialAbilities(rulesRaw),
    subtypes: raw.subtypes ?? [],
    rulesText: cleanRulesText(rulesRaw),
    rarity: (raw.rarity ?? "").toLowerCase(),
    setNum: ids.setNum,
    cardNum: ids.cardNum,
  };
  if (title) card.title = title;
  if (raw.strength != null) card.strength = raw.strength;
  if (raw.willpower != null) card.willpower = raw.willpower;
  if (raw.quest_value != null) card.lore = raw.quest_value;
  if (raw.move_cost != null) card.moveCost = raw.move_cost;
  return card;
}

async function main(): Promise<void> {
  process.stdout.write(`Fetching catalog: ${SOURCE}\n`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const catalog = (await res.json()) as {
    catalog_hash?: string;
    cards: { characters?: RawCard[]; actions?: RawCard[]; items?: RawCard[]; locations?: RawCard[] };
  };

  const byId = new Map<string, PrintedCard>();
  const add = (list: RawCard[] | undefined, base: CardType) => {
    for (const raw of list ?? []) {
      const isSong = base === "action" && (raw.subtypes ?? []).includes("Song");
      const card = normalize(raw, isSong ? "song" : base);
      if (card && !byId.has(card.id)) byId.set(card.id, card);
    }
  };
  add(catalog.cards.characters, "character");
  add(catalog.cards.actions, "action");
  add(catalog.cards.items, "item");
  add(catalog.cards.locations, "location");

  const cards = [...byId.values()].sort((a, b) =>
    a.setNum !== b.setNum ? a.setNum - b.setNum : a.cardNum - b.cardNum,
  );

  const db: CardDatabase = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    catalogHash: catalog.catalog_hash,
    count: cards.length,
    cards,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, "../src/data/cards.generated.json");
  writeFileSync(outPath, JSON.stringify(db) + "\n");
  process.stdout.write(`Wrote ${cards.length} cards → ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`build-card-db failed: ${String(err)}\n`);
  process.exit(1);
});
