# Kokoro — Lorcana Offline Duel Simulator: Implementation Plan

**Status:** Planning (spec reviewed, environment validated)
**Source spec:** `lorcanaduelsimspec.md` (P0→P3, automation tier T2)
**This document:** a build-ready work-package breakdown with dependencies, acceptance
criteria, and the environment-specific decisions agreed during spec review.

---

## 0. Decisions locked during spec review

| # | Question | Decision |
|---|----------|----------|
| 1 | Relationship to existing **InkForge** (Cloudflare Workers inventory/ledger app already in this repo) | **New, separate codebase.** InkForge (`inkforge-backend/`, `inkforge-ui/`, `wrangler.jsonc`, its specs) is left **untouched**. The duel simulator lives in a new top-level **`inkforge-localplay/`** directory. |
| 2 | Source of truth for rules (`/mnt/skills/user/disney-lorcana/` is absent here) | **Rules file provided:** official Disney Lorcana Comprehensive Rules, effective **Feb 28 2025** (`/tmp` working copy; to be vendored into the repo). See Finding §1.6 re keyword coverage. Engine work (P1+) can proceed. |
| 3 | Immediate deliverable | Plan approved → **building P0.** |
| 4 | Card images (`cards.duels.ink` blocked here) | **Configurable image source + placeholder fallback.** Image base-URL is config-driven and swappable; up to **15** card images (a 4×15 test deck) are vendored into the repo for in-sandbox dev; real CDN fetch is verified on-device. |
| 5 | App directory name | **`inkforge-localplay/`** (a logo SVG will be supplied to replace the placeholder). |

### Environment facts (validated, not assumed)

- **Network policy is GitHub-only.** `codeload.github.com` and `raw.githubusercontent.com` → 200.
  `cards.duels.ink`, `api.lorcast.com`, `lorcana-api.com`, `dreamborn.ink` → **403**.
  → Card-DB ingest **works here**; live image fetch **does not**.
- **Card DB source confirmed reachable:** `great-illuminary/lorcana-data` →
  `data_existing/catalog/en/full.json` (~5.25 MB) via `raw.githubusercontent.com`.
- **Replay format confirmed against the supplied files:** `duels-replay-v1`
  (`baseSnapshot + frames[] + logs[]`) and `duels-match-replay-v1` (bo3) match Appendix A/B.

---

## 1. Findings from the real replay files that adjust the spec's data model

These are concrete deltas discovered by decoding the two uploaded replays. The engine and the
optional importer must account for them:

1. **`victoryReason` has more values than the spec enum.** Spec §4.2 lists `lore | concession |
   deckout`; real data also contains **`pregame_timeout`** (and `TIMER_*` log types exist).
   → Internal union stays `'lore' | 'concession' | 'deckout'`; the **importer** widens to a
   tolerant `string` and maps unknowns to a `'timeout' | 'other'` bucket. A friendly offline app
   has no clock, so we never *emit* timeouts.
2. **Replay `decklist` is a flat `string[]` of 60 card ids** (with repeats, in deck order), not the
   `{id, count}[]` of our `Deck` model (§5.3). → Provide `flatten(deck)` / `collapse(ids)` helpers
   at the engine↔deck boundary.
3. **`logs[]` entries carry an optional `data` object** (e.g. `{ mulliganCount }`) and use
   `{card:N}` placeholders resolved against `cardRefs[]`. → Extend `LogEntry` with `data?` and a
   template-render helper.
4. **`baseSnapshot` carries extra keys** not in the spec (`rematchEnabled`, `isMatchmaking`,
   `playerRanks`). → Tolerate/ignore on import; do not model them.
5. **`CardInstance` in real data has extra printed fields** (`rarity`, `tcgplayer`, `foil`,
   `flavorText`, `name`/`title` split). → Keep our denormalised subset (§4.2) but the ingest
   normaliser should not choke on extras.
6. **The provided rules file (Feb 28 2025 CR) predates 3 keywords in the spec's T2 list.** It
   defines 12 keywords (Bodyguard, Challenger, Evasive, Reckless, Resist, Rush, Shift, Singer,
   Sing Together, Support, Vanish, Ward — §10.2–10.13) but **not Alert, Boost, or Underdog**.
   → P1 keyword work implements the 12 authoritatively from the CR; Alert/Boost/Underdog are
   implemented from printed card reminder-text with Manual-Mode fallback unless an updated CR is
   supplied. (Non-blocking for P0.)

---

## 2. Repository layout

InkForge stays where it is. The new app is self-contained:

```
/  (repo root "Kokoro")
├── inkforge-backend/        # UNTOUCHED (existing)
├── inkforge-ui/             # UNTOUCHED (existing)
├── wrangler.jsonc           # UNTOUCHED (existing)
├── PLAN.md                  # this file
└── app/                     # NEW — the offline duel simulator
    ├── src/
    │   ├── engine/          # PURE: no React/DOM/network/persistence
    │   │   ├── state.ts     # GameState + CardInstance types
    │   │   ├── actions.ts   # action types + applyAction reducer
    │   │   ├── rng.ts       # seeded RNG stream (seedrandom + cursor)
    │   │   ├── rules/       # turn.ts play.ts challenge.ts quest.ts bag.ts keywords/*
    │   │   ├── effects/     # DSL interpreter + card-effects.json loader
    │   │   ├── replay.ts    # fold / record / undo / redo
    │   │   └── index.ts
    │   ├── data/
    │   │   ├── cards.ts     # bundled card DB access by id
    │   │   ├── decklist.ts  # parse/export text format
    │   │   └── images.ts    # CardImage cache service (configurable source)
    │   ├── state/           # Zustand stores + Dexie persistence
    │   ├── net/             # Transport iface; hotseat.ts; webrtc.ts; signalling/qr.ts
    │   ├── ui/              # screens + components (mirror spec §11)
    │   └── app/             # routing, shell, PWA registration
    ├── scripts/build-card-db.ts   # ingest full.json → bundled JSON
    ├── assets/cards/              # vendored test images (dev only)
    ├── tests/engine/             # Vitest — the critical surface
    └── android/                  # Capacitor (P2+)
```

**Hard rule (from spec §12):** `engine/` imports nothing from React, DOM, network, or persistence.
Pure `(state, action) → { nextState, frames, logs }`, fully testable in Node.

---

## 3. Tech stack (per spec §3, confirmed)

TypeScript (strict) · Vite · React 18 · Tailwind + shadcn/ui · Zustand · React Router ·
`rfc6902` for JSON Patch (pick one lib, use everywhere) · `seedrandom` · Dexie (IndexedDB) ·
`vite-plugin-pwa` (Workbox) · Capacitor (P2) · `qrcode` + barcode scanner (P3) ·
native `RTCPeerConnection`/`RTCDataChannel` (P3) · Vitest + Playwright.

**Runtime network policy:** zero cloud/analytics/remote API. Only ever the one-time image download.

---

## 4. Work packages

Each WP lists: **Deliverable · Key files · Depends on · Acceptance.** WPs within a phase are
ordered by dependency. The `[GATED]` tag means blocked on the rules file (decision #2).

### Phase P0 — Foundations + Mulligan (no rules dependency)

**WP0.1 — Project scaffold**
- Vite + React + TS(strict) + Tailwind + shadcn + Zustand + Router + Dexie + vite-plugin-pwa in `app/`.
- *Files:* `app/` config, base shell, lint/format, Vitest + Playwright harness.
- *Depends on:* —
- *Accept:* `dev`, `build`, `test` run; PWA installable; CI-green empty test suite.

**WP0.2 — Card DB ingest**
- `scripts/build-card-db.ts` pulls `full.json` from `raw.githubusercontent.com/great-illuminary/lorcana-data`,
  normalises to our `CardInstance` printed-subset, writes a **bundled** JSON keyed by `id="{set}-{number}"`.
  `data/cards.ts` loads it; no runtime metadata fetch.
- *Depends on:* WP0.1
- *Accept:* lookup by id (e.g. `6-124` → Maui) works offline; bundle committed/reproducible; size budget noted.

**WP0.3 — Image cache service (foundational)**
- `data/images.ts` `getImage(id, size)` → local blob URL. **Configurable base-URL** (default
  `cards.duels.ink`, overridable). Workbox runtime cache keyed on host. Deterministic placeholder
  (name + cost + colour) when missing/offline. `imagesCached`/"PvP-ready" computation. Vendored
  test images under `assets/cards/` for in-sandbox dev.
- *Depends on:* WP0.1, WP0.2
- *Accept:* with network off, missing image → placeholder (never broken img); "download for deck"
  affordance; in-sandbox dev shows vendored test art.

**WP0.4 — Deck model, decklist parse/export, persistence**
- `data/decklist.ts` tolerant parser (`{count} {fullName} ({set}-{number})`, curly quotes/whitespace;
  `(set-number)` authoritative) + exact-format exporter. `Deck` model + Dexie store. Validation
  (size, max-4, ink-colour count) warns, never blocks. `flatten/collapse` helpers (Finding §1.2).
- *Depends on:* WP0.2
- *Accept:* parse the supplied decklist round-trips to identical text; illegal decks save with warning.

**WP0.5 — App shell + navigation**
- All screens routable (stubbed where later): Main menu, Decks, Deck builder, Decklists, Play menu,
  Mulligan, Local Play, Stats, Replays. Mobile-first, large tap targets. Bot opponent greyed/disabled.
- *Depends on:* WP0.1
- *Accept:* every route reachable; layout fits phone portrait.

**WP0.6 — Decks page** — pinned "New deck"; tiles `Name (Format)` + `Colour1|Colour2|Count|Inkable|Uninkable`. *Depends:* WP0.4/0.5. *Accept:* matches spec §11.2.

**WP0.7 — Deck builder** — Search tab (visual list from bundled DB; filter pips: colour/cost/type/keyword/format; double-tap add, max-4) + List tab; big Save. *Depends:* WP0.3/0.4/0.6. *Accept:* build a deck from the supplied decklist via UI.

**WP0.8 — Decklists page** — `Count|Inkable|Uninkable|Name`; `Set Default|Duplicate|Copy(as text)`; per-line `Cost|Name - Surname|Count` tinted by ink colour. *Depends:* WP0.4. *Accept:* "Copy as text" yields exact canonical format.

**WP0.9 — Mulligan page (standalone)** — draw 7, choose subset → bottom, redraw equal, one alteration; Play/Draw toggle; Leave; records keep/redraw stats (stat store stub). *Depends:* WP0.2/0.3/0.5. *Accept:* full mulligan loop offline; stats recorded.

> **P0 acceptance (spec §13):** create a deck from the supplied decklist, cache its images,
> run mulligans — all offline after first image fetch; runs as installable PWA.

### Phase P1 — Hot-seat duel + T2 engine `[GATED on rules file]`

**WP1.1 — Engine core & determinism** — `state.ts` (GameState/CardInstance/Prompt/LogEntry incl.
`data?` from Finding §1.3), `actions.ts` (`applyAction` reducer returning `{nextState, frames, logs}`,
rejecting illegal actions with no frames), `rng.ts` (seedrandom + `rngCursor`), `replay.ts`
(fold / record / undo (drop last frame-group) / redo). *Depends:* WP0.2. *Accept:* fold of
`baseSnapshot+frames` from the supplied replay reconstructs each step; undo/redo identical.

**WP1.2 — Turn structure** — ready/set/draw (first player skips first draw), main phase, end phase
(expire "until end of turn", end triggers). *Depends:* WP1.1. *Accept:* unit tests per `turn-and-actions.md`.

**WP1.3 — Turn actions** — ink (once/turn), play (cost payment, drying), quest, challenge
(declaration + simultaneous damage + banish at damage≥willpower), move to location, activate ability.
*Depends:* WP1.2. *Accept:* a scripted game exercises each action.

**WP1.4 — Keywords (all 15)** — Alert, Bodyguard, Boost, Challenger(+N stacks), Evasive, Reckless,
Resist, Rush, Shift, Singer, Sing Together, Support, Underdog, Vanish, Ward — as typed behaviour
hooks. **Shift** (stack via `cardsUnder`, inherits damage/effects, moves together) budgeted as hardest.
*Depends:* WP1.3. *Accept:* dedicated test per keyword incl. Shift stack leave-play.

**WP1.5 — The bag** — `pendingPrompts` push on trigger; active player orders/resolves; engine blocks
normal actions while non-empty; `RESPOND_TO_PROMPT`. *Depends:* WP1.3. *Accept:* multi-trigger
ordering test.

**WP1.6 — Effect DSL + Manual Mode** — JSON DSL (`op`s: draw/discard/gainLore/loseLore/dealDamage/
removeDamage/banish/returnToHand/buff/debuff/ready/exert/searchDeck/playForFree; triggers:
on_play/on_quest/on_challenge/on_banish/start_of_turn/end_of_turn/activated). `card-effects.json`
seeded for the supplied decklist's cards. Manual Mode: free zone moves, set damage/exert/lore/buffs,
"done" — every change emitted as frames. *Depends:* WP1.5. *Accept:* one DSL-automated trigger + one
Manual-Mode card both record as frames and replay identically.

**WP1.7 — Win/loss** — 20 lore instant win, deck-out loss, concession → `GAME_FINISH`. *Depends:* WP1.3. *Accept:* each path tested.

**WP1.8 — Hot-seat UI + transport** — `HotSeatTransport` (loopback), pass-and-play board, game log
from `logs`, undo/redo controls. *Depends:* WP1.1–1.7. *Accept:* **P1 spec acceptance** — complete legal
game with ≥1 challenge, ≥1 quest, ≥1 keyword interaction, ≥1 DSL trigger, ≥1 Manual-Mode card; undo
any action and replay identically; engine unit tests green.

### Phase P2 — Android APK + offline hardening

**WP2.1 — Capacitor Android** — wrap web app; signed debug/release APK; documented `npm run android:build` + sideloading guide.
**WP2.2 — Native persistence** — images → `Filesystem`; settings/decks/stats → Dexie + `Preferences` mirror; validate Dexie durability in WebView (Risk §6.6).
**WP2.3 — Offline hardening** — airplane-mode pass.
> **P2 acceptance:** install APK on clean device, airplane mode, deck-build → mulligan → full hot-seat duel, **zero network calls** (verified with monitor).

### Phase P3 — Local PvP + replays + stats

**WP3.1 — WebRtcTransport** — `RTCPeerConnection`/`RTCDataChannel` behind the `Transport` interface.
**WP3.2 — QR signalling + pairing wizard** — offer/answer SDP over QR (gzip+base64url, chunk/animated; trim to local ICE). *Prototype SDP-over-QR size early (Risk §14.2).*
**WP3.3 — Sync protocol** — `HELLO/ACTION/FRAMES/UNDO_REQUEST/UNDO_CONFIRM/PING`; host owns seed + deck orders; follower applies host frames verbatim; deterministic actions local-then-reconcile.
**WP3.4 — Hidden-info view layer** — devices hold full state; view refuses to render opponent hand/deck order.
**WP3.5 — Replays** — record `{baseSnapshot,frames,logs,decklist,winner,victoryReason,turnCount,playerNames}`; Replays page (≤20 tiles, upload, delete, double-tap watch); playback step/scrub.
**WP3.6 — Stats** — per player/deck, Win% OTP/OTD, mulligan-keep stats; derived from replays + lightweight results table.
**WP3.7 — (optional) duels.ink importer** — tolerant mapper handling Findings §1 (flat decklist, `data`, extra snapshot keys, `pregame_timeout`). Nice-to-have; not required to ship.
> **P3 acceptance:** two Android devices on a hotspot pair via QR with no internet, play a full duel,
> result records to stats, replay reconstructs correctly on both devices.

---

## 5. Dependency / sequencing summary

```
P0:  0.1 → 0.2 → {0.3, 0.4} → {0.6,0.7,0.8,0.9}   (0.5 parallel after 0.1)
P1:  [needs rules file] 1.1 → 1.2 → 1.3 → {1.4,1.5,1.7} → 1.6 → 1.8
P2:  P1 done → 2.1 → 2.2 → 2.3
P3:  P2 done → 3.1 → 3.2 → 3.3 → 3.4 → {3.5 → 3.6} ; 3.7 optional anytime after 1.1
```

Critical path runs through the **engine (WP1.1)** and the two hardest pieces called out by the spec —
**Shift (WP1.4)** and **the bag (WP1.5)** — which carry the most test budget.

---

## 6. Testing strategy

- **Engine is the critical surface** (Vitest, pure Node). Golden test: fold the supplied
  `duels-replay-v1` and assert reconstructed state at each `seq`.
- **Property tests** for determinism: same seed + same actions ⇒ identical frames/state.
- **Playwright** UI smoke for each screen and the P0/P2 acceptance flows.
- Per-keyword unit tests; bag-ordering tests; undo/redo round-trip tests.

---

## 7. Open items still needing your input (non-blocking for P0)

1. **Rules file delivery** — what form (the `disney-lorcana` skill tree, or a single CR PDF/MD)?
   Engine WPs start once it lands.
2. **App directory name** — plan assumes `app/`. Prefer something else (`duel/`, `kokoro/`)?
3. **Vendored test images** — OK to commit a small set (~10–20 webp) of the supplied decklist's cards
   into `assets/cards/` for in-sandbox dev? (Licensing note, Risk §14.4.)
4. **Decklist seed for `card-effects.json`** — confirm the supplied decklist is the seed set for P1
   DSL coverage (it is the deck embedded in the uploaded replay).
5. **Deck format/legality rules** — which format(s) to validate against (Core Constructed, Infinity)?
   Default is warn-not-block regardless.
```
