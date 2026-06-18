# Effects Build Plan — `e413cd59` card batch

Generated coverage (`scripts/coverage.cjs` against `cards.generated.json` +
`card-effects.json` + `card-statics.json`):

- **DONE: 123** — already covered by existing effect/static slugs, parsed
  keywords, or vanilla (no special ability).
- **PARTIAL: 4** — at least one ability covered, one still open.
- **TODO: 131** — no covered ability yet.
- "NOT IN DB (2)" in the raw report (`"Malicious`, `"Next Stop`) are CSV
  comma-in-name artifacts; both cards exist (`Malicious, Mean, and Scary`,
  `Next Stop, Olympus`) with synthetic-ability slugs.

Re-run any time: `node scripts/coverage.cjs` (writes `/tmp/coverage-report.txt`).

Each uncovered ability below is mapped to **existing primitives** (JSON-only) or
to a **new mechanic** with the engine change it needs. Cards are grouped by the
mechanic so we build by capability, not card-by-card.

---

## Wave 1 — JSON-only (existing primitives) ✅ buildable now

These need only new entries in `card-effects.json`/`card-statics.json`.

| Card / ability | Maps to |
| --- | --- |
| Hamm `loosechange`, Lantern `birthdaylights` | `activated` → `grantDiscount{character,1,uses:1}` |
| Sneezy `gesundheit`, Webby `contagiousenergy` | `on_play` → `chooseCharacter` + `buff{lore/strength:1,end_of_turn}` |
| Mulan-Disguised `wheredoisignin` | `on_play` → `draw 1` + `discardChoose 1` |
| Gaetan `unearth` | `on_quest` → `draw 2` + `discardChoose 2` |
| Sisu-Daring `bringontheheat`, Headless `leavesnotrace` | `on_play` → `chooseCharacter{enemy,maxStrength}` + `banish` |
| Benja `wehaveachoice`, Clarabelle `butterfingers`* | `on_play` → `mayConfirm` + `chooseItem{enemy}` + `banish` |
| Isis `chillout` | `on_play` → `chooseCharacter{enemy}` + `exert` |
| Scar `begrateful` | static `yoursSubtype{Ally, strength:1}` |
| Yzma `feelthepower` | `activated` → `drawTo 3` |
| Lilo-Uproar `raaawr` | `on_play` → `chooseCharacter` + `ready` (+ can't-quest flag → Wave 4) |
| Diablo-Stone `cruelintent`* | self static gated by Villain-in-play → Wave 3 |

\* Clarabelle/Diablo have a second clause handled in a later wave.

## Wave 2 — small new primitives (high leverage)

### 2a. `duration: "untilNextTurn"` on buff/debuff/grantKeyword
Stat/keyword change that lasts until the start of the caster's next turn.
- Rhino `tinyhowl` (enemy −1{S}), Jasmine `justwhatyouneed` (ally Resist+1),
  John Silver `pickyourfights` (enemy Reckless), Mrs. Incredible
  `flexiblethinking` (self Evasive — modal), Fortisphere `extractofsteel`
  (ally Bodyguard).

### 2b. `banishAll` filters: `damaged`, `maxStrength`
- Prince Phillip `swiftandsure` (all damaged opposing), Sisu-Empowered
  `igotthis` (all opposing ≤2{S}).

### 2c. each-player draw (`player:"each"` on draw)
- Amethyst Chromicon `amethystlight`, Donald `allowme`.

### 2d. `gainLoreEqual` — gain lore = a chosen target's {L} or damage
- Pocahontas `whatismypath` (chosen exerted char {L}), Lucky Dime `numberone`
  (your char {L}), Go Go `stopwhining` (damage on chosen opposing).

### 2e. self "enters play" flags via `on_play`
- Mulan-Injured `battlewound` (`dealDamage self 2`), Mickey-Expedition
  `longjourney` / Hidden Trap `almostready` / Great Stone `asleep` (enter
  exerted → `exert self` on play). Inkwell/Inkrunner `preflightcheck`,
  Fortisphere `resourceful`, Maurice items "draw on play".

## Wave 3 — conditional & scaling statics

### 3a. scaling self/team statics: `perOther`, `perOtherSubtype`, `perItem`, `perCardUnder`
- Mr. Incredible `alwaysunited` (+2{S} per other char), Alien `weareone`
  (+1{S} per other Toy), Tamatoa-Shiny `glam` (+1{L} per item),
  Genie-Magical `increasingwisdom` / Hercules-Spectral `superhumanstrength` /
  Flynn `illtakethat` / Scrooge-Ghostly `countingcoins` (per card under →
  needs Wave 5 shift-stack).

### 3b. gated statics: `whileOtherCharsAtLeast`, `whileNoHand`, `whileSelfUndamaged`, `whileControllerHasSubtype`
- Piglet `andimthecaptain` (2+ other → +2{L}), Angel-Experiment `untouchable`
  (no hand → Resist+2), Rhino-Power `epicballofawesome` (undamaged → Resist+2),
  Diablo-Stone `cruelintent` (Villain in play → +2{S}/+1{L}).

### 3c. new scopes: `yoursColor`, team keyword grants
- Mickey-Amber `leadingtheway` (+2{W} other Amber), Peter Pan `flyofcourse`
  (your Evasive chars gain Rush), Ranger Plane `airsupport` (your chars gain
  Support), Scar `stickwithme`.

### 3d. self-flag statics: `cantChallenge`, `cantQuest`, `questAnyTime`, `enterExerted`
- Chief Powhatan `standshisground`, Dash `recordtime`, RC `lowbatteries`.

## Wave 4 — new triggers

- `on_play_cheap` ("pay ≤N to play a card/character/non-character"): Jessie
  `yodelayheehoo`, Buzz-OnTheWay `secretmission`/`worldsgreatesttoy`, Babyhead
  `tightenthebolts`, Calhoun? no.
- `on_draw`: Royal Guard `heavilyarmed`, Diablo-Devoted `circlefarandwide`.
- `on_ally_banished` ("your other char banished"): Babyhead `replacementparts`,
  Sid `doubleprizes`, Pluto-Steel `winnertakeall`, Calhoun `levelup`,
  Robin-Champion `skilledcombatant`.
- `on_leave_play` (generalize on_banish to bounce/ink too): Olaf `secondchance`,
  Merlin `hereicome`/`hoppityhip`, Will o' the Wisp `comeonout`,
  Snow White `neverforgotten`.
- `on_song_sung` (this char sings): Ursula-Deceiver-of-All `whatadeal`.
- `on_inkwell_added`: Sapphire Coil `brilliantshine`.
- conditional self discount with `when` + flat `reduce`: Bullseye `letsride`,
  Next Stop Olympus, Wind-Up Frog `addedtraction`, Bouncing Ducky `rejectedtoys`
  (`reducePer` new keys: `toyInDiscard`).

## Wave 5 — structural (largest)

- **Shift-stack "cards under"**: make Shift actually stack the shifted-over card
  underneath; expose `cardsUnder(card)` for `perCardUnder` statics and
  "put a card under / look at cards under" effects (Cheshire, Ariel-Ethereal,
  Pete-Ghost, Scrooge's Counting House location).
- **Locations**: Casa Madrigal, The Library, Seven Dwarfs' Mine, Scrooge's
  Counting House — need a location zone + "move character here" + "while here"
  triggers. Currently no location play surface.
- **Play-a-card-for-free / alternate play costs**: Lady-Family `someonetocarefor`,
  Woody-Jungle `letsgetmovin`, Tamatoa `imbeautifulbaby`, Belle-Apprentice
  `whatamess`, Scrooge-Miser `putittogooduse`, Hand-in-the-Box `springloaded`,
  Lilo-Uproar `stompintime`, Pleakley `reportingforduty` (put char into inkwell).
- **Stat floor** ("can't be reduced below printed"): Elisa `foreverstrong`.
- **Damage-redirect/prevent**: Lilo-Bundled `extralayers`, Hercules-Mighty
  `evervigilant`/`evervaliant` (can't be dealt damage unless challenged).

---

Implementation proceeds Wave 1 → 5, JSON + tests committed per wave. Waves 1–4
reuse the composable DSL; Wave 5 items need new engine zones/structures and are
scheduled last.

---

## Progress

- **Waves 1–3** built: untilNextTurn duration, banishAll filters, gainLoreEqual,
  each-player draw, exerted/damaged target filters, scaling/gated statics
  (perOther/perOtherSubtype/perItem, whileNoHand/whileSelfUndamaged/
  whileOtherCharsAtLeast/whileControllerHasSubtype, yoursColor, excludeSelf).
- **Wave 4** built: triggers on_play_cheap, on_challenge_banish; on_banish reuse
  for "leaves play" (Merlin, Olaf); conditions lastPlayedType/
  lastPlayedNonCharacter/otherCharsAtLeast.
- **Wave 5a** built: returnSelfToHand step; combat flags standshisground
  (can't challenge) and recordtime (quest while drying); conditions
  opponentHasExerted/haveSubtypeAny/lastPlayedSubtype/onlyYourTurn/
  onlyOpponentTurn; ~25 more cards wired. Behavioral flag slugs
  (stonebyday/spikesuit) marked covered.

- **Waves 5c–5e** built: targetHasKeyword statics (Peter Pan), buffBySourceStat
  (Zipper), tiered end-of-turn (Maximus), on_ally_challenged with pre-bound
  `challenger` (Tiana, Merida-Gifted), name-filtered discard return (Merida-
  Formidable), on_play_item trigger covering item watchers (Maurice's Workshop),
  plus activated buffs (Medallion Weights, Ice Block).

- **Waves 6–11** built: play-for-free engine (`playFree`), conditional free
  play + quest-lock (Lilo), damage-prevention layer + strength floor (Hercules,
  Lilo-Bundled, Elisa), controller-wide banish/inkwell watches (Sid, Babyhead,
  Emerald, Sapphire Coil), once-per-turn triggers, location start-of-turn lore,
  challenge-ready (Cinderella), inkwell ramp (Webby), scry-to-inkwell (Kida),
  draw-to-match (Clarabelle), plus Tigger/Woody-Leader approximations.

Running total for this batch: **DONE 217, PARTIAL 24, TODO 17.**

### The remaining 17 — blocked on UI surfaces or an interpreter refactor
These can't be done cleanly with the current pure-interpreter + no-location-UI
architecture; each needs one of the following first:

- **Location movement + "while here" (UI)**: The Library `lostinabook`, Casa
  Madrigal `healinghome`, Seven Dwarfs' Mine `mountaindefense`. (Locations now
  generate lore; they just can't host characters yet.)
- **`on_draw` / opponent-discard watches (interpreter refactor)**: Royal Guard
  `heavilyarmed`, Diablo-Devoted `circlefarandwide`, Prince John `isentenceyou`.
  Firing these requires threading the effects table into `runSteps` so draws/
  discards *inside* an effect can fire further triggers.
- **Alternate play cost with a player choice (UI)**: Belle-Apprentice
  `whatamess`, Hand-in-the-Box `springloaded`, RC `lowbatteries` (pay-to-act),
  Moana `ancestrallegacy` (ink from discard).
- **Reveal-and-branch / opponent decisions**: Daisy `bigprize`, Hades
  `whatdyasay`, Jack-Jack `weirdthingsarehappening`.
- **Shift "put a card under" + dynamic-count scry**: Cheshire `itsloadsoffun`,
  Pete-Ghost `forebodingglance`.
- **Re-resolve a song from discard**: Ursula `whatadeal`.
- **Multi-pick discard-to-bottom + buff**: Roller Bob `timetomove`.

### Still TODO (need structural work — Wave 5b/5c)
- **Cards-under (Shift stack)**: increasingwisdom, superhumanstrength,
  illtakethat, countingcoins, goodbusiness, forebodingglance, commandperformance,
  itsloadsoffun. (Shift must tuck the shifted-over card; expose cardsUnder.)
- **Locations zone + "while here" / "move here"**: The Library, Casa Madrigal,
  Seven Dwarfs' Mine, Scrooge's Counting House.
- **Play-a-card-for-free / alternate cost**: someonetocarefor, letsgohome,
  whatamess, springloaded, stompintime, raaawr (needs can't-quest flag),
  letsgetmovin, splenderifficbounce.
- **Can't-be-damaged / damage-prevent / stat-floor**: evervigilant, evervaliant,
  extralayers, foreverstrong.
- **Conditional self cost-reduction (when + flat reduce)**: letsride, addedtraction,
  rejectedtoys, nextstopolympus.
- **High-frequency event triggers**: on_draw (heavilyarmed, circlefarandwide),
  opponent-discard watch (isentenceyou), inkwell-added (brilliantshine),
  song-resing (whatadeal), controller-wide on_challenged (specialreservation,
  fierceprotection), action-damage (steadyaim), play-item (lookingforthis).
- **Misc multi-step**: whatdyasay, icantakeit, worksmarter, keytothepuzzle,
  buzzingenthusiasm, royallybigrewards, dusktodawn, keepinstep, flexiblethinking,
  weirdthingsarehappening, mountaindefense, playtimesover, timetomove, repurposed,
  fullquiver, healinghome, ancestrallegacy, thesingingsword, bigprize.
