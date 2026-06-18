# Effect coverage & build plan

Processed from the opponent-cards list (set of decks seen across ~20 opponents).
`freq` = `times_seen` from that list (how many opponents ran the card) — a rough
priority signal. This tracks what the composable effect DSL already does vs. the
mechanics still to build.

## Status legend
- ✅ **done** — resolves automatically via the DSL today.
- 🟡 **data-only** — covered by existing primitives; just needs a `card-effects.json` entry.
- 🔧 **needs mechanic** — requires a new DSL step / engine hook (listed below).
- ⬛ **manual** — surfaces a Manual-Mode prompt for now (visible, player applies it).

Anything not in the DSL still **surfaces a manual prompt** (it never silently no-ops).

---

## Existing primitives
`chooseCharacter` (scope + filter: maxStrength/minStrength/maxCost/subtype),
`chooseFromHand`, `toInkwell`, `discardCard`, `mayConfirm` (Yes/No),
`lookAtTop` (scry → hand / bottom / inkwell), `banishAll`, `dealDamage`,
`removeDamage`, `banish`, `returnToHand`, `buff`/`debuff` (str/will/lore,
end_of_turn|permanent), `ready`/`exert`, `draw`, `discard`, `gainLore`/`loseLore`.
Activated abilities (`{E}` / ink / "Banish this") via `ACTIVATE_ABILITY`.
Triggers fired: `on_play`, `on_quest`, `on_challenge`, `on_banish`.

---

## Shipped so far
- ✅ **Scry** (`lookAtTop`) incl. filter / optional / keepUpTo — Develop Your Brain,
  Vision of the Future, How Far I'll Go, Kida (Path Revealed), Ariel‑Spectacular
  (Musical Debut), Nani, Look at This Family.
- ✅ **Cost reduction** (`grantDiscount`) — Aurora (Royal Welcome), Akood et Emuti.
- ✅ **AoE & count-based** (`dealDamageAll`/`buffAll`/`debuffAll`/`amountPer`) —
  Strength of a Raging Fire, Tinker Bell (Rock the Boat), Cri‑Kee, Kida‑Protector.
- ✅ **Forced discard** (`chooseFromHand from:opponent` + `opponentDiscard`) —
  Ursula‑Deceiver, The Bare Necessities, You Have Forgotten Me.
- ✅ Earlier: banishAll, filtered banish (Brawl / World's Greatest), targeted
  damage/heal/buff/debuff, return-to-hand, draw/lore, activated abilities,
  on_play/on_quest/on_challenge/on_banish triggers, may-confirm, choose-from-hand→inkwell.

Still **manual** within the above buckets: "their choice" *filtered* discards
(Mowgli), random discard, discard-your-own-hand (Doc / A Whole New World),
So Be It's item-banish half, self-cost reduction (Olaf / Liquidator / Tramp).

## Mechanics still to build (priority order)

### 1. 🔧 Forced discard / hand disruption — *core done; tails remain*
Done: caster-picks-from-opponent (filtered), each-opponent-discards-N.
Remaining: random discard, discard-your-own-hand+draw, "their choice" with a
type filter, reveal-only, discard-triggered draws (Prince John).
Needs: opponent-choice discard, "reveal hand & you pick what they discard"
(filtered by type), random discard, discard-your-own-hand, draw-then-discard.
In PvP the opponent must make the choice (cross-player prompt); in hot-seat it's
the same device. Hidden-info (revealing hands) also lands here.
- Ursula - Deceiver (8) — reveal hand, discard a song of your choice
- The Bare Necessities (6) — reveal hand, discard a non-character of your choice
- Pull the Lever! (3, mode) / Sudden Chill (1) / You Have Forgotten Me (3, discard 2)
- Mowgli - Man Cub (1), Chip (1), Doc (1, discard hand→draw 2), Bobby (1), So Cheesy
- Namaari (3, draw+discard), Angel (1, discard→deal 2), A Whole New World (1, discard hand draw 7)
- We Don't Talk About Bruno (4, return + random discard)
- Triggered off discards: Prince John (2, draw per opp discard), Cursed Merfolk (1)

### 2. 🔧 Cost reduction ("pay N less for next …")
Needs: a turn-scoped cost modifier (optionally filtered by type/subtype), applied
to the next/all matching plays this turn.
- Aurora - Holding Court (7), Akood et Emuti (6), Tramp (2), Grandmother Willow (1),
  Smooth the Way, Olaf "About Time", Liquidator "Underdog" (from our deck)

### 3. 🔧 Filtered / multi-keep scry (extend `lookAtTop`)
Needs: `filter` (type/cost/subtype), `optional` keep, `keepUpTo: N`.
- Ariel - Spectacular Singer (7) — top 4, may reveal a **song** to hand
- Nani - Stage Manager (1) — top 4, may reveal a **character ≤2 cost**
- Look at This Family (1) — top 5, reveal **up to 2 characters**

### 4. 🔧 AoE & count-based damage / buffs
Needs: `dealDamageAll(scope)`, `buffAll(scope)`, count-based amount
(`amount: { perCharacter: "ally"|"enemy" }`), duration `until_start_next_turn`.
- Strength of a Raging Fire (6) — damage = your character count
- Tinker Bell (1) — 1 damage to each opposing character
- Cri-Kee (2, +3 your others), So Be It (1, +1 your chars), Painting (done as 2-target),
  Kida - Protector (2, all −3), He Hurled (1, subtype buff), Tramp (2, +1 per other char)

### 5. 🔧 Keyword grants (this turn / lasting)
Needs: `grantKeyword(target, keyword, value?, duration)` + keyword engine reads it.
- Merlin - Crab (3, Challenger +3), Louis (1, Reckless), Vitalisphere (Rush, done as buff),
  Iago/Sven/Elsa (Evasive/Rush bundles), White-Rabbit-style

### 6. 🔧 Exert / lockout control
- Elsa - Fifth Spirit (3) — exert chosen opposing (≈ chooseCharacter enemy + exert)
- Demona (1) — exert all opposing + draw-to-3 → `exertAll` + `drawTo(n)`
- Pete - Games Referee (6) / Keep the Ancient Ways (1) — opponents can't play actions/items (turn lockout flag)

### 7. 🔧 Zone control: to inkwell / bottom of deck
- Hades - Infernal Schemer (1) — put opposing char into their inkwell
- Under the Sea (2) — put all opposing chars ≤2 ⛉ on bottom of deck
- Wrong Lever! (1) — bounce to bottom of deck

### 8. 🔧 Return / play from discard
- Merlin's Carpetbag, Tamatoa (return items), Maui (return action), Wrong Lever (return Pull the Lever!)
- Tamatoa "I'm Beautiful" — play an item for free

### 9. 🔧 Move damage counters
- Cheshire Cat (1), Belle - Accomplished Mystic (1) — move up to N damage between characters

### 10. 🔧 Banish item (chosen)
- Archimedes (1), Wasabi (1), So Be It (1), Belle - Apprentice (1, banish own to play free)

### 11. 🔧 Modal "choose one"
- Pull the Lever! (3), Wrong Lever! (1) — a mode-selection prompt before resolving

### 12. 🔧 Turn-phase & conditional triggers
Needs: `start_of_turn` / `end_of_turn` firing + condition predicates
("if you played a Princess this turn", "if 2+ cards discarded this turn",
"once during your turn", "if no damage").
- Beast (7), Elinor (2), Demona, Namaari (start of turn), Cinderella - Dream (our deck), Leviathan (our deck)

### 13. 🔧 Conditional-draw / draw-to-N combos
- Rapunzel (6) — draw 1 per damage removed; Demona — draw to 3; Dumbo (3) — draw+lore (activated, partly works)

### 14. ⬛ Static passives / keyword engine
Resist, Evasive, Ward, Bodyguard, Challenger, Singer, Rush, Reckless, Support,
Boost, Vanish, Shift (incl. "Shift: discard an action"), "during challenges use
{W} not {S}" (Dale), "can't ready" (Demona/Stone by Day). Mostly engine/keyword
work, lower automation priority — these mostly already function as keywords or
are passive math.

---

## Recommended build order
1. **Filtered/multi-keep scry** (#3) — small extension of a primitive that exists; unlocks 3 cards incl. the freq-7 Ariel.
2. **Cost reduction** (#2) — one turn-scoped modifier; high frequency (Aurora 7, Akood 6).
3. **AoE/count damage & buffs** (#4) — unlocks Strength of a Raging Fire (6) and several buffs.
4. **Forced discard** (#1) — biggest bucket but needs cross-player prompts; do after the cross-player prompt plumbing is proven.
5. Then keyword grants (#5), exert/lockout (#6), zone control (#7), the rest.
