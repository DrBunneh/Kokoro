const fs = require("fs");
const ROOT = "/home/user/Kokoro/inkforge-localplay";
const cards = require(ROOT + "/src/data/cards.generated.json");
const arr = Array.isArray(cards) ? cards : (cards.cards || Object.values(cards));
const byName = new Map(arr.map(c => [(c.fullName || c.name), c]));
const effects = JSON.parse(fs.readFileSync(ROOT + "/src/engine/effects/card-effects.json", "utf8"));
const statics = JSON.parse(fs.readFileSync(ROOT + "/src/engine/effects/card-statics.json", "utf8"));
const covered = new Set([...Object.keys(effects), ...Object.keys(statics)].filter(k => k !== "$schema"));
// keywords the engine already understands (parsed from abilities[]):
const KW = new Set(["evasive", "resist", "challenger", "bodyguard", "ward", "singer", "rush", "reckless", "support", "sing together", "shift"]);

const raw = fs.readFileSync("/root/.claude/uploads/1db81215-74d3-5e03-8100-fd206831eac8/e413cd59-cardlist_with_effects.csv", "utf8").split("\n").slice(1).filter(Boolean);
// name is column index 1 and contains no commas, so a simple split is safe for the name
const names = raw.map(l => l.split(",")[1]);

const done = [], partial = [], todo = [], missingDb = [];
for (const name of names) {
  const c = byName.get(name);
  if (!c) { missingDb.push(name); continue; }
  const sa = c.specialAbilities || [];
  const kws = (c.abilities || []).map(a => a.ability.replace(/[+0-9].*$/, "").trim().toLowerCase()).filter(Boolean);
  if (sa.length === 0) { done.push(name + (kws.length ? "  (kw: " + kws.join(",") + ")" : "  (vanilla)")); continue; }
  const slugs = sa.map(s => s.slug);
  const cov = slugs.filter(s => covered.has(s));
  const unc = sa.filter(s => !covered.has(s.slug));
  if (unc.length === 0) done.push(name);
  else if (cov.length > 0) partial.push({ name, missing: unc.map(s => s.slug + ": " + s.effect.replace(/\s+/g, " ").slice(0, 120)) });
  else todo.push({ name, missing: unc.map(s => s.slug + ": " + s.effect.replace(/\s+/g, " ").slice(0, 120)) });
}
let out = "";
out += "=== DONE (" + done.length + ") ===\n";
out += done.join("\n") + "\n";
out += "\n=== PARTIAL (" + partial.length + ") ===\n";
for (const p of partial) { out += "• " + p.name + "\n"; p.missing.forEach(m => out += "    " + m + "\n"); }
out += "\n=== TODO (" + todo.length + ") ===\n";
for (const t of todo) { out += "• " + t.name + "\n"; t.missing.forEach(m => out += "    " + m + "\n"); }
if (missingDb.length) out += "\n=== NOT IN DB (" + missingDb.length + ") ===\n" + missingDb.join("\n") + "\n";
fs.writeFileSync("/tmp/coverage-report.txt", out);
console.log(out);
