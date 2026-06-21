# Inkwell — offline Lorcana duel simulator (handoff)

Fully-offline mobile Lorcana duel simulator (PWA → Android via Capacitor 8).
The rules engine is pure TypeScript (no React/DOM/network/persistence imports).

## Setup
```bash
npm install
npm run test        # vitest — 162 tests
npm run typecheck   # tsc -b --noEmit
npm run dev         # Vite dev server
npm run build       # tsc -b && vite build
```

## Where things live
- `src/engine/` — pure rules engine.
  - `actions.ts` — the reducer (`reduce`/`applyAction`): turn structure, play,
    quest, challenge, abilities, the "bag" (pending prompts), locations.
  - `effects/dsl.ts` — the composable effect DSL: `Step[]` primitives, the
    `runSteps` interpreter (suspends on choices, resumes via RESPOND_TO_PROMPT),
    triggers, conditions.
  - `effects/card-effects.json` — per-ability effect definitions (keyed by the
    ability slug; actions/songs with no named ability use `slugify(fullName)`).
  - `effects/card-statics.json` — continuous/passive modifiers.
  - `continuous.ts` — the static-effect layer (`statMods`).
  - `keywords.ts` — effective stat helpers (fold printed + applied + continuous).
- `src/data/cards.generated.json` — full card DB (built from set CSVs).
- `src/ui/` — React UI (hot-seat + LAN PvP boards).
- `scripts/coverage.cjs` — coverage report: `node scripts/coverage.cjs <cards.csv>`
  cross-references a `name,effect` CSV against the DB + the covered slug sets.
- `docs/effects-build-plan.md` — the build plan / coverage history.

## Effect coverage status (as of this export)
Across the processed sets: original 256-card batch 100%; Set 12 ~99%; Set 11
~86%; Set 9 ~85% (≈96% overall). The remaining cards each need a distinct
bespoke mechanic — see `docs/effects-build-plan.md` and the chat handoff notes.
The biggest single unlock left is making `runSteps` able to recursively
re-resolve another card's effect (for song-replay / reveal-and-play cards).

## How to add a card's effect
1. Find its ability slug (run the coverage script, or `slugify(name)` =
   `name.toLowerCase().replace(/[^a-z0-9]+/g,"")`).
2. Add an entry to `card-effects.json` (triggered/activated) or
   `card-statics.json` (continuous), composed from existing `Step`/`StaticDef`
   primitives in `dsl.ts` / `continuous.ts`.
3. If no primitive fits, add one to the DSL + a test, then wire the JSON.
4. `npm run typecheck && npm run test` before committing.
