const fs = require("fs");
const ROOT = "/home/user/Kokoro/inkforge-localplay";
const cards = require(ROOT + "/src/data/cards.generated.json");
const arr = Array.isArray(cards) ? cards : (cards.cards || Object.values(cards));
const byName = new Map(arr.map((c) => [(c.fullName || c.name), c]));
const effects = JSON.parse(fs.readFileSync(ROOT + "/src/engine/effects/card-effects.json", "utf8"));
const statics = JSON.parse(fs.readFileSync(ROOT + "/src/engine/effects/card-statics.json", "utf8"));
const covered = new Set([...Object.keys(effects), ...Object.keys(statics)].filter((k) => k !== "$schema"));

// slugify mirrors build-card-db (for actions/songs with no named ability).
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// CSV path + name column: arg 2 = path (default the original batch); name column
// auto-detected from the header.
const csvPath = process.argv[2] || "/root/.claude/uploads/1db81215-74d3-5e03-8100-fd206831eac8/e413cd59-cardlist_with_effects.csv";
const rawLines = fs.readFileSync(csvPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
const header = rawLines[0].split(",");
const nameCol = header.findIndex((h) => h.trim().toLowerCase() === "name");
const rows = rawLines.slice(1);

// Parse just the name field, honoring quoted commas.
function parseName(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { fields.push(cur); cur = ""; continue; }
    cur += ch;
  }
  fields.push(cur);
  return (fields[nameCol] || "").trim();
}

const names = rows.map(parseName).filter(Boolean);
const done = [], partial = [], todo = [], missingDb = [];
for (const name of names) {
  const c = byName.get(name);
  if (!c) { missingDb.push(name); continue; }
  const sa = c.specialAbilities || [];
  const kws = (c.abilities || []).map((a) => a.ability.replace(/[+0-9].*$/, "").trim().toLowerCase()).filter(Boolean);
  if (sa.length === 0) {
    // action/song with no named ability → synthetic slug, or vanilla/keyword card.
    const syn = slugify(c.fullName);
    if (covered.has(syn)) done.push(name);
    else if ((c.type === "action" || c.type === "song")) todo.push({ name, missing: [syn + ": (synthetic on-play effect)"] });
    else done.push(name + (kws.length ? "  (kw: " + kws.join(",") + ")" : "  (vanilla)"));
    continue;
  }
  const cov = sa.map((s) => s.slug).filter((s) => covered.has(s));
  const unc = sa.filter((s) => !covered.has(s.slug));
  if (unc.length === 0) done.push(name);
  else if (cov.length > 0) partial.push({ name, missing: unc.map((s) => s.slug + ": " + s.effect.replace(/\s+/g, " ").slice(0, 120)) });
  else todo.push({ name, missing: unc.map((s) => s.slug + ": " + s.effect.replace(/\s+/g, " ").slice(0, 120)) });
}
let out = "";
out += "=== DONE (" + done.length + ") ===\n" + done.join("\n") + "\n";
out += "\n=== PARTIAL (" + partial.length + ") ===\n";
for (const p of partial) { out += "• " + p.name + "\n"; p.missing.forEach((m) => out += "    " + m + "\n"); }
out += "\n=== TODO (" + todo.length + ") ===\n";
for (const t of todo) { out += "• " + t.name + "\n"; t.missing.forEach((m) => out += "    " + m + "\n"); }
if (missingDb.length) out += "\n=== NOT IN DB (" + missingDb.length + ") ===\n" + missingDb.join("\n") + "\n";
fs.writeFileSync("/tmp/coverage-report.txt", out);
console.log(out);
