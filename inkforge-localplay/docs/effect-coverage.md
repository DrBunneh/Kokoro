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

## Deferred (still surface as Manual-Mode prompts, never silently no-op)
These need heavier engine work; uncovered on_play/quest/challenge/banish text
still pops a prompt so play continues:
- **Turn-phase triggers**: `start_of_turn` / `end_of_turn` aren't fired yet, so
  Beast, Elinor, Namaari's start-of-turn half, Cinderella - Dream don't auto-fire.
- **Condition predicates**: "if you played a Princess", "if 2+ cards discarded",
  "if no damage", "first turn" — these on_play cards surface manually.
- **Triggered statics**: "whenever you play a song/action", "whenever you draw",
  "whenever this is challenged", "whenever an item is banished" (Maui Wayfinding,
  The Muses, Prince John, Cursed Merfolk, Archimedes' 2nd, Royal Guard, Ariel-Sonic).
- **Self-cost reduction**: Olaf, Liquidator, Tramp, Grandmother Willow, LeFou,
  Belle-Apprentice (banish own item to play free).
- **Conditional draw / count-lore**: Rapunzel (draw per damage removed),
  Mulan (lore = strength).
- **Combat/keyword statics not in the keyword engine**: Dale (challenge uses {W}),
  Lilo (first-hit immunity), Demona "can't ready", Vanish, Boost, Snow Fort buffs.
