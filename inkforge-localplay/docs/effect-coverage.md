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


## Primitives now in the DSL
Targeting/choices: `chooseCharacter` (scope + maxStrength/minStrength/maxCost/subtype),
`chooseFromHand` (own or `from:opponent`, type filter), `chooseItem`, `mayConfirm`
(Yes/No), `modal` (choose one), `lookAtTop` (scry: filter/optional/keepUpTo →
hand/bottom/inkwell), `returnFromDiscard` (filtered discard picker).
Effects: `dealDamage`(+`amountPer`), `dealDamageAll`, `removeDamage`, `banish`,
`banishAll`, `returnToHand`, `buff`/`debuff`(+`amountPer`), `buffAll`/`debuffAll`,
`ready`/`exert`/`exertAll`, `grantKeyword`, `moveDamage`, `putToInkwell`, `toBottom`,
`toBottomAll`, `toInkwell`, `discardCard`, `discardHandDraw`, `opponentDiscard`
(filterable), `randomDiscard`, `draw`/`drawTo`, `gainLore`/`loseLore`,
`grantDiscount` (cost reduction), `grantExtraInk`, `lockout`.
Triggers fired: `on_play`, `on_quest`, `on_challenge`, `on_banish`, plus
`ACTIVATE_ABILITY` ({E}/ink/"Banish this").

## Covered from the opponent-card list
Roughly the whole list except the deferred categories below — every targeted
removal/heal/buff/debuff, AoE & count-based damage/buffs, scry (all variants),
cost reduction, forced discard (caster-choice + opponent-choice + random +
discard-your-hand), keyword grants, exert/exert-all, draw-to-N, move-damage,
banish-item, put-to-inkwell / bottom-of-deck (single + filtered-all), return
from discard, lockout, extra-ink, and modal "choose one".

## Now automated (added since)
- **Turn-phase triggers**: `start_of_turn` + `end_of_turn` fire (end-of-turn
  resolves before the turn passes) — Beast, Elinor, Namaari, Cinderella - Dream.
- **Condition gates** (`when`): playedType/Subtype, discardedAtLeast,
  selfUndamaged/Damaged, exertedAlliesAtLeast, haveCharacterNamed,
  firstTurnNotFirstPlayer — Leviathan, Cinderella, Beast, Liquidator, LeFou, Tramp.
- **Event-triggered statics**: `on_play_action` / `on_play_song` (Maui Wayfinding,
  The Muses) and `on_challenged` (Cursed Merfolk).
- **Self-cost reduction** (`cost` trigger, flat / per-action-in-discard / gated):
  Olaf, Liquidator, LeFou, Tramp.
- **Conditional draw / count-lore**: Rapunzel (`removeDamageDraw`), Mulan
  (`gainLoreByStrength`).

## Still deferred — passive/continuous (no Manual-Mode prompt; just unmodelled math)
These never pop a prompt (they classify as static), so they don't block "0 manual
mode"; they need a continuous-effects layer (stat recompute across permanents):
- **Continuous stat statics**: Snow Fort (+1 ⛉ to your characters), Namaari
  (+1 ⛉ per card in discard), Hades (+1 ◊ per Villain).
- **Combat/keyword statics not in the keyword engine**: Dale (challenge uses {W}),
  Lilo (first-hit immunity), Demona "can't ready", Vanish, Boost.

## Niche event triggers still unmodelled (classify static → no prompt)
"Whenever you draw" (Royal Guard, Diablo - Devoted Herald, Ariel - Ethereal),
"whenever an item is banished" (Archimedes' 2nd), "whenever your opponent
discards" (Prince John), "whenever this song deals…" (Ariel - Sonic Warrior),
Boost, "Once during your turn …" (Grandmother Willow), and Belle - Apprentice's
"banish your own item to play this free" (an alternate cost).
