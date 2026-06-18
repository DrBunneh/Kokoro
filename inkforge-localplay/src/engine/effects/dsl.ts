/**
 * Composable effect DSL (spec §7, revised). An effect is an ordered list of
 * primitive **actions**; the interpreter runs them in sequence. A `choose…`
 * step that needs a target suspends the sequence (pushing a prompt); resuming
 * binds the chosen target into the context and continues. Most cards reuse a
 * small set of primitives, so coverage grows by data, not code.
 */
import { otherPlayer, type CardInstance, type GameState, type PlayerId } from "../state";
import { makeLog, type LogEntry } from "../replay";
import { banishCard, drawCards, findInstance } from "../zones";
import { effectiveStrength, effectiveWillpower, effectiveLore } from "../keywords";
import { Rng } from "../rng";
import { uid } from "@/lib/id";
import type { CardType } from "@/data/card-types";

export type Trigger =
  | "on_play"
  | "on_quest"
  | "on_challenge"
  | "on_banish"
  | "on_challenged" // when THIS character is challenged
  | "on_play_action" // whenever you play an action/song (for your other cards)
  | "on_play_song" // whenever you play a song specifically
  | "on_play_character" // whenever you play a character (for your other cards)
  | "on_item_banished" // whenever an item is banished, during your turn
  | "start_of_turn"
  | "end_of_turn"
  | "activated"
  | "cost"; // passive self-cost reduction, evaluated when this card is played

export type Scope = "any" | "ally" | "enemy";
export type Who = "self" | "opponent";

/** A predicate that gates whether an effect fires (Lorcana "if …" clauses). */
export interface Condition {
  /** You played a card of this type this turn. */
  playedType?: CardType;
  /** You played a character with this subtype this turn (e.g. "Princess"). */
  playedSubtype?: string;
  /** At least N cards were put into your discard this turn. */
  discardedAtLeast?: number;
  /** The source character has no damage. */
  selfUndamaged?: boolean;
  /** The source character has damage on it. */
  selfDamaged?: boolean;
  /** You have at least N exerted characters in play. */
  exertedAlliesAtLeast?: number;
  /** You have a character with this name in play. */
  haveCharacterNamed?: string;
  /** It's your first turn and you're not the first player. */
  firstTurnNotFirstPlayer?: boolean;
}

/** A magnitude that scales with the number of characters in a scope. */
export interface AmountPer {
  scope: Scope;
  excludeSelf?: boolean;
}

/** Restricts which characters are a legal target (e.g. "with 3 {S} or less"). */
export interface TargetFilter {
  maxStrength?: number;
  minStrength?: number;
  maxCost?: number;
  subtype?: string;
  /** Target must be exerted (Pocahontas — "another chosen exerted character"). */
  exerted?: boolean;
}

/** Restricts which revealed deck cards a scry may keep (e.g. "a song card"). */
export interface ScryFilter {
  cardType?: CardType;
  maxCost?: number;
  subtype?: string;
}

/** Does a revealed card satisfy a scry filter (used by the keep-picker)? */
export function scryMatch(card: import("@/data/card-types").PrintedCard, f?: ScryFilter): boolean {
  if (!f) return true;
  if (f.cardType && card.type !== f.cardType) return false;
  if (f.maxCost != null && card.cost > f.maxCost) return false;
  if (f.subtype && !card.subtypes.some((s) => s.toLowerCase() === f.subtype!.toLowerCase())) return false;
  return true;
}

/** A single primitive action. `to`/`target` reference a bound var name or "self". */
export type Step =
  // Targeting (suspends for a tap; binds the chosen instance to `as`):
  | { do: "chooseCharacter"; as: string; scope?: Scope; text?: string; optional?: boolean; filter?: TargetFilter }
  // Optional "may" gate — suspends for a Yes/No before the steps that follow:
  | { do: "mayConfirm"; text?: string }
  // Scry: reveal the top `count` of your deck, keep up to `keepUpTo` (default 1,
  // optionally filtered) in hand, send the rest to the bottom or inkwell. When
  // `optional`, the player may keep none.
  | { do: "lookAtTop"; count: number; rest?: "bottom" | "inkwellExerted"; filter?: ScryFilter; keepUpTo?: number; optional?: boolean; text?: string }
  // Banish every character (Be Prepared) — or a scoped subset, optionally
  // limited to damaged characters or those at/under a strength (Prince Phillip / Sisu).
  | { do: "banishAll"; scope?: Scope; damaged?: boolean; maxStrength?: number }
  // Put every matching character in scope on the bottom of their deck (Under the Sea).
  | { do: "toBottomAll"; scope?: Scope; maxStrength?: number }
  // Put every matching character into its owner's inkwell, exerted (Spooky Sight).
  | { do: "putToInkwellAll"; scope?: Scope; maxCost?: number }
  // "Choose one" of several sub-effects (Pull the Lever / Wrong Lever).
  | { do: "modal"; options: { label: string; steps: Step[] }[] }
  // "Pay N less for the next matching card you play this turn."
  | { do: "grantDiscount"; amount: number; cardType?: CardType; subtypes?: string[]; uses?: number }
  // Choose a card from a hand (your own, or an opponent's revealed hand):
  | { do: "chooseFromHand"; as: string; from?: "self" | "opponent"; cardType?: CardType; excludeCardType?: CardType; text?: string; optional?: boolean }
  // Each opponent chooses and discards `amount` cards from their own hand.
  | { do: "opponentDiscard"; amount: number; cardType?: CardType; excludeCardType?: CardType }
  // Grant the active player an extra ink this turn (Sail the Azurite Sea):
  | { do: "grantExtraInk"; amount?: number }
  // Move a bound (hand) card into the inkwell / discard:
  | { do: "toInkwell"; from: string; exerted?: boolean }
  | { do: "discardCard"; from: string }
  // Damage (amount may instead scale with a character count via amountPer):
  | { do: "dealDamage"; to: string; amount?: number; amountPer?: AmountPer }
  | { do: "removeDamage"; to: string; amount: number }
  // Remove up to `amount` damage from a target, then draw that many cards (Rapunzel):
  | { do: "removeDamageDraw"; to: string; amount: number }
  // Gain lore equal to the source's strength, optionally capped (Mulan):
  | { do: "gainLoreByStrength"; max?: number }
  // Gain lore equal to a bound character's stat (Pocahontas {L} / Go Go damage / Lucky Dime {L}):
  | { do: "gainLoreEqual"; from: string; stat: "lore" | "damage" | "strength" }
  // Area damage to every character in scope:
  | { do: "dealDamageAll"; scope?: Scope; amount: number }
  // Movement / removal:
  | { do: "banish"; to: string }
  | { do: "returnToHand"; to: string }
  // Stats (until end of turn unless duration given):
  | { do: "buff" | "debuff"; to: string; strength?: number; willpower?: number; lore?: number; duration?: "end_of_turn" | "permanent" | "untilNextTurn"; amountPer?: AmountPer }
  // Area stat change to every character in scope (optionally excluding the source):
  | { do: "buffAll" | "debuffAll"; scope?: Scope; strength?: number; willpower?: number; lore?: number; duration?: "end_of_turn" | "permanent" | "untilNextTurn"; excludeSelf?: boolean }
  | { do: "ready" | "exert"; to: string }
  // Exert every character in scope (Demona):
  | { do: "exertAll"; scope?: Scope }
  // Grant a keyword to a target for this turn / permanently:
  | { do: "grantKeyword"; to: string; keyword: string; value?: number; duration?: "end_of_turn" | "permanent" | "untilNextTurn" }
  // Move up to `amount` damage counters from one bound target to another:
  | { do: "moveDamage"; from: string; to: string; amount: number }
  // Zone control on a bound character:
  | { do: "putToInkwell"; to: string; exerted?: boolean } // into its owner's inkwell
  | { do: "toBottom"; to: string }                         // to the bottom of its owner's deck
  // Choose an item in play (suspends), then act on it (banish):
  | { do: "chooseItem"; as: string; scope?: Scope; text?: string; optional?: boolean }
  // Return card(s) from your discard to hand (suspends on a discard picker):
  | { do: "returnFromDiscard"; cardType?: CardType; maxCost?: number; keepUpTo?: number; optional?: boolean; text?: string }
  // Discard your whole hand, then draw `draw` cards (Doc / A Whole New World):
  | { do: "discardHandDraw"; player?: Who; draw: number }
  // Opponent discards `amount` random cards:
  | { do: "randomDiscard"; amount: number }
  // Opponents can't play actions (or items) until your next turn:
  | { do: "lockout"; items?: boolean }
  // Cards / lore ("each" draws for both players — Amethyst Chromicon / Donald):
  | { do: "draw"; player?: Who | "each"; amount?: number; amountPer?: AmountPer }
  | { do: "drawTo"; player?: Who; count: number }
  // Choose and discard from your own hand `amount` (or per-count) cards:
  | { do: "discardChoose"; amount?: number; amountPer?: AmountPer; text?: string }
  // Play the source card from your discard into play (Lilo - Escape Artist):
  | { do: "playFromDiscard"; exerted?: boolean }
  | { do: "discard"; player?: Who; amount?: number }
  | { do: "gainLore" | "loseLore"; player?: Who; amount?: number };

export interface EffectDef {
  trigger: Trigger;
  steps?: Step[];
  /** Optional gate: the effect only fires when this condition holds. */
  when?: Condition;
  /** For trigger "cost": flat ink reduction when playing this card. */
  reduce?: number;
  /** For trigger "cost": reduction that scales with a count. */
  reducePer?: "actionInDiscard" | "characterInPlay";
}

export type CardEffects = Record<string, EffectDef[]>;

export type AbilityKind = Trigger | "activated" | "static";

/**
 * Classify when an ability's printed text fires, so we only auto-resolve or
 * surface a Manual-Mode prompt on the matching event (not for every ability on
 * play). Activated abilities need an explicit activation; statics never prompt.
 */
export function classifyTrigger(effectText: string, cardType: CardType): AbilityKind {
  const t = effectText.trim().toLowerCase();
  if (/^when you play this/.test(t)) return "on_play";
  if (/^whenever this character quests/.test(t)) return "on_quest";
  if (/^whenever this character challenges/.test(t)) return "on_challenge";
  if (/^when this character is banished/.test(t)) return "on_banish";
  // Activated: a cost (exert/ink/"banish this") preceding an em dash.
  if (/^(\{e\}|\d+\s*\{[il]\}|banish this)[^—]*—/.test(t) || /^\{e\}/.test(t)) return "activated";
  // Free "Once during your turn, …" abilities are player-activated (once/turn).
  if (/^once (during|per) your turn/.test(t)) return "activated";
  // For actions/songs the whole text is the on-play effect.
  if (cardType === "song" || cardType === "action") return "on_play";
  return "static";
}

export interface EffectContext {
  controller: PlayerId;
  source: CardInstance;
  vars: Record<string, string>; // bound var name -> instanceId
  /** Cards banished while these steps ran, so on_banish triggers can fire after. */
  banished?: { card: CardInstance; owner: PlayerId }[];
}

/** A suspended sequence awaiting a target choice. Serialisable (frame-safe). */
export interface Suspension {
  steps: Step[]; // remaining, starting with the choose step
  scope: Scope;
  text?: string;
  optional: boolean;
  filter?: TargetFilter;
  /** What the resolver picks. */
  pick: "character" | "hand" | "confirm" | "deck" | "item" | "discard" | "mode";
  /** For pick === "deck"/"discard": the revealed card instanceIds to show face-up. */
  reveal?: string[];
  /** For pick === "hand": whose hand to choose from. */
  handOwner?: PlayerId;
  /** For pick === "mode": the option labels to choose between. */
  modes?: string[];
}

/** Does a hand card satisfy a chooseFromHand step's type filter? */
export function handCardMatches(card: CardInstance, step: Extract<Step, { do: "chooseFromHand" }>): boolean {
  if (step.cardType && card.printed.type !== step.cardType) return false;
  if (step.excludeCardType && card.printed.type === step.excludeCardType) return false;
  return true;
}

/**
 * Does a chosen character satisfy a choose step's scope + filter? Used by the
 * reducer to reject illegal targets when resuming a suspended effect.
 */
export function targetMatches(
  card: CardInstance,
  owner: PlayerId,
  controller: PlayerId,
  step: Extract<Step, { do: "chooseCharacter" }>,
  strength: number,
): boolean {
  if (card.printed.type !== "character") return false;
  const scope = step.scope ?? "any";
  if (scope === "ally" && owner !== controller) return false;
  if (scope === "enemy" && owner === controller) return false;
  const f = step.filter;
  if (f) {
    if (f.maxStrength != null && strength > f.maxStrength) return false;
    if (f.minStrength != null && strength < f.minStrength) return false;
    if (f.maxCost != null && card.printed.cost > f.maxCost) return false;
    if (f.subtype && !card.printed.subtypes.some((s) => s.toLowerCase() === f.subtype!.toLowerCase())) return false;
    if (f.exerted && !card.exerted) return false;
  }
  return true;
}

const player = (ctx: EffectContext, who: Who | undefined): PlayerId =>
  who === "opponent" ? otherPlayer(ctx.controller) : ctx.controller;

function resolveTarget(state: GameState, ctx: EffectContext, ref: string): CardInstance | undefined {
  if (ref === "self") return ctx.source;
  const id = ctx.vars[ref];
  return id ? findInstance(state, id)?.card : undefined;
}

/** Characters in play within a scope, relative to the controller. */
function charsInScope(state: GameState, controller: PlayerId, scope: Scope): CardInstance[] {
  const out: CardInstance[] = [];
  for (const owner of [1, 2] as PlayerId[]) {
    if (scope === "ally" && owner !== controller) continue;
    if (scope === "enemy" && owner === controller) continue;
    for (const c of state.players[owner].field) if (c.printed.type === "character") out.push(c);
  }
  return out;
}

/** Resolve a numeric magnitude that may scale with a character count. */
function dynAmount(state: GameState, ctx: EffectContext, base: number | undefined, per?: AmountPer): number {
  if (!per) return base ?? 0;
  let n = charsInScope(state, ctx.controller, per.scope).length;
  if (per.excludeSelf) n = Math.max(0, n - 1);
  return n;
}

/** Apply damage to a character, banishing it (and recording so) if it dies. */
function hit(state: GameState, ctx: EffectContext, t: CardInstance, amount: number, logs: LogEntry[]): void {
  t.damage += amount;
  const loc = findInstance(state, t.instanceId);
  if (loc && t.damage >= effectiveWillpower(state, t)) {
    banishCard(state.players[loc.owner], t, logs, state.turnNumber);
    ctx.banished?.push({ card: t, owner: loc.owner });
  }
}

function applyStep(state: GameState, step: Step, ctx: EffectContext, logs: LogEntry[]): void {
  switch (step.do) {
    case "dealDamage": {
      const t = resolveTarget(state, ctx, step.to);
      if (!t) return;
      hit(state, ctx, t, dynAmount(state, ctx, step.amount, step.amountPer), logs);
      break;
    }
    case "dealDamageAll": {
      const amount = step.amount;
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) hit(state, ctx, t, amount, logs);
      break;
    }
    case "removeDamage": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) t.damage = Math.max(0, t.damage - step.amount);
      break;
    }
    case "removeDamageDraw": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) {
        const removed = Math.min(step.amount, t.damage);
        t.damage -= removed;
        if (removed > 0) drawCards(state.players[ctx.controller], removed);
      }
      break;
    }
    case "gainLoreByStrength": {
      const amt = Math.min(effectiveStrength(state, ctx.source), step.max ?? Infinity);
      if (amt > 0) state.players[ctx.controller].lore += amt;
      break;
    }
    case "gainLoreEqual": {
      const t = resolveTarget(state, ctx, step.from);
      if (!t) return;
      const amt = step.stat === "damage" ? t.damage : step.stat === "strength" ? effectiveStrength(state, t) : effectiveLore(state, t);
      if (amt > 0) {
        state.players[ctx.controller].lore += amt;
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "LORE_GAINED", message: `Gain ${amt} lore`, data: { lore: state.players[ctx.controller].lore } }));
      }
      break;
    }
    case "banish": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        banishCard(state.players[loc.owner], t, logs, state.turnNumber);
        ctx.banished?.push({ card: t, owner: loc.owner });
      }
      break;
    }
    case "returnToHand": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = false; t.justPlayed = false; t.appliedEffects = [];
        state.players[loc.owner].hand.push(t);
      }
      break;
    }
    case "buff":
    case "debuff": {
      const t = resolveTarget(state, ctx, step.to);
      if (!t) return;
      const s = step.do === "debuff" ? -1 : 1;
      const mag = step.amountPer ? dynAmount(state, ctx, undefined, step.amountPer) : null;
      t.appliedEffects.push({
        source: ctx.source.instanceId,
        strength: mag != null ? s * mag : step.strength != null ? s * step.strength : undefined,
        willpower: step.willpower != null ? s * step.willpower : undefined,
        lore: step.lore != null ? s * step.lore : undefined,
        duration: step.duration ?? "end_of_turn",
        castBy: ctx.controller,
      });
      break;
    }
    case "buffAll":
    case "debuffAll": {
      const s = step.do === "debuffAll" ? -1 : 1;
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) {
        if (step.excludeSelf && t.instanceId === ctx.source.instanceId) continue;
        t.appliedEffects.push({
          source: ctx.source.instanceId,
          strength: step.strength != null ? s * step.strength : undefined,
          willpower: step.willpower != null ? s * step.willpower : undefined,
          lore: step.lore != null ? s * step.lore : undefined,
          duration: step.duration ?? "end_of_turn",
          castBy: ctx.controller,
        });
      }
      break;
    }
    case "ready": { const t = resolveTarget(state, ctx, step.to); if (t) t.exerted = false; break; }
    case "exert": { const t = resolveTarget(state, ctx, step.to); if (t) t.exerted = true; break; }
    case "exertAll": {
      for (const c of charsInScope(state, ctx.controller, step.scope ?? "any")) c.exerted = true;
      break;
    }
    case "grantKeyword": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) t.appliedEffects.push({ source: ctx.source.instanceId, keyword: step.keyword, keywordValue: step.value, duration: step.duration ?? "end_of_turn", castBy: ctx.controller });
      break;
    }
    case "moveDamage": {
      const from = resolveTarget(state, ctx, step.from);
      const to = resolveTarget(state, ctx, step.to);
      if (from && to) {
        const moved = Math.min(step.amount, from.damage);
        from.damage -= moved;
        to.damage += moved;
        const loc = findInstance(state, to.instanceId);
        if (loc && to.damage >= effectiveWillpower(state, to)) {
          banishCard(state.players[loc.owner], to, logs, state.turnNumber);
          ctx.banished?.push({ card: to, owner: loc.owner });
        }
      }
      break;
    }
    case "putToInkwell": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.justPlayed = true; t.exerted = step.exerted ?? false; t.appliedEffects = [];
        state.players[loc.owner].inkwell.push(t);
      }
      break;
    }
    case "toBottom": {
      const t = resolveTarget(state, ctx, step.to);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc) {
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = false; t.justPlayed = false; t.appliedEffects = [];
        state.players[loc.owner].deck.push(t);
      }
      break;
    }
    case "discardHandDraw": {
      const p = state.players[player(ctx, step.player)];
      const n = p.hand.length;
      p.discard.push(...p.hand.splice(0, n));
      p.discardedThisTurn = (p.discardedThisTurn ?? 0) + n;
      drawCards(p, step.draw);
      break;
    }
    case "randomDiscard": {
      const opp = state.players[otherPlayer(ctx.controller)];
      const rng = new Rng(state.rngSeed, state.rngCursor);
      for (let k = 0; k < step.amount && opp.hand.length > 0; k++) {
        const i = rng.int(opp.hand.length);
        opp.discard.push(opp.hand.splice(i, 1)[0]!);
        opp.discardedThisTurn = (opp.discardedThisTurn ?? 0) + 1;
      }
      state.rngCursor = rng.cursor;
      break;
    }
    case "lockout": {
      state.lockout = { caster: ctx.controller, items: step.items ?? false };
      break;
    }
    case "grantExtraInk": {
      state.players[ctx.controller].extraInk = (state.players[ctx.controller].extraInk ?? 0) + (step.amount ?? 1);
      break;
    }
    case "toBottomAll": {
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) {
        if (step.maxStrength != null && effectiveStrength(state, t) > step.maxStrength) continue;
        const loc = findInstance(state, t.instanceId);
        if (!loc) continue;
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = false; t.justPlayed = false; t.appliedEffects = [];
        state.players[loc.owner].deck.push(t);
      }
      break;
    }
    case "putToInkwellAll": {
      for (const t of charsInScope(state, ctx.controller, step.scope ?? "any")) {
        if (step.maxCost != null && t.printed.cost > step.maxCost) continue;
        const loc = findInstance(state, t.instanceId);
        if (!loc) continue;
        const arr = state.players[loc.owner][loc.zone];
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.damage = 0; t.exerted = true; t.justPlayed = true; t.appliedEffects = [];
        state.players[loc.owner].inkwell.push(t);
      }
      break;
    }
    case "toInkwell": {
      const t = resolveTarget(state, ctx, step.from);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc && loc.zone === "hand") {
        const arr = state.players[loc.owner].hand;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        t.exerted = step.exerted ?? false;
        t.justPlayed = true; // face-up until end of the turn it was added
        state.players[loc.owner].inkwell.push(t);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: loc.owner, type: "CARD_PUT_INTO_INKWELL", message: `Put ${t.printed.fullName} into inkwell`, cardRefs: [{ id: t.printed.id, name: t.printed.fullName }] }));
      }
      break;
    }
    case "discardCard": {
      const t = resolveTarget(state, ctx, step.from);
      const loc = t && findInstance(state, t.instanceId);
      if (t && loc && loc.zone === "hand") {
        const arr = state.players[loc.owner].hand;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
        state.players[loc.owner].discard.push(t);
        state.players[loc.owner].discardedThisTurn = (state.players[loc.owner].discardedThisTurn ?? 0) + 1;
      }
      break;
    }
    case "opponentDiscard": {
      // Push a prompt for the opponent to choose their own cards to discard.
      const opp = otherPlayer(ctx.controller);
      const n = Math.min(step.amount, state.players[opp].hand.length);
      if (n <= 0) break;
      const sub: Step[] = [];
      for (let k = 0; k < n; k++) sub.push({ do: "chooseFromHand", as: `d${k}`, from: "self", optional: true, cardType: step.cardType, excludeCardType: step.excludeCardType }, { do: "discardCard", from: `d${k}` });
      state.pendingPrompts.push({
        id: uid(),
        player: opp,
        controller: opp,
        sourceInstanceId: ctx.source.instanceId,
        kind: "discard",
        text: `Choose ${n} card${n > 1 ? "s" : ""} to discard`,
        auto: false,
        pick: "hand",
        handOwner: opp,
        resume: { steps: sub, vars: {} },
      });
      break;
    }
    case "grantDiscount": {
      (state.players[ctx.controller].discounts ??= []).push({
        amount: step.amount,
        cardType: step.cardType,
        subtypes: step.subtypes,
        uses: step.uses ?? 1,
      });
      logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "ABILITY_TRIGGERED", message: `Pay ${step.amount} less for the next ${step.cardType ?? "card"}` }));
      break;
    }
    case "banishAll": {
      const scope = step.scope ?? "any";
      for (const owner of [1, 2] as PlayerId[]) {
        if (scope === "ally" && owner !== ctx.controller) continue;
        if (scope === "enemy" && owner === ctx.controller) continue;
        const chars = state.players[owner].field.filter((c) => {
          if (c.printed.type !== "character") return false;
          if (step.damaged && c.damage <= 0) return false;
          if (step.maxStrength != null && effectiveStrength(state, c) > step.maxStrength) return false;
          return true;
        });
        for (const c of chars) {
          banishCard(state.players[owner], c, logs, state.turnNumber);
          ctx.banished?.push({ card: c, owner });
        }
      }
      break;
    }
    case "draw": {
      const n = step.amountPer ? dynAmount(state, ctx, step.amount, step.amountPer) : (step.amount ?? 1);
      if (n <= 0) break;
      const targets: PlayerId[] = step.player === "each" ? [ctx.controller, otherPlayer(ctx.controller)] : [player(ctx, step.player)];
      for (const pid of targets) {
        drawCards(state.players[pid], n);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: pid, type: "CARD_DRAWN", message: `Draw ${n}` }));
      }
      break;
    }
    case "playFromDiscard": {
      const src = ctx.source;
      const p = state.players[ctx.controller];
      const i = p.discard.indexOf(src);
      if (i >= 0) {
        p.discard.splice(i, 1);
        src.damage = 0; src.exerted = step.exerted ?? false; src.justPlayed = true; src.appliedEffects = [];
        p.field.push(src);
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_PLAYED", message: `Played ${src.printed.fullName} from discard`, cardRefs: [{ id: src.printed.id, name: src.printed.fullName }] }));
      }
      break;
    }
    case "drawTo": {
      const p = state.players[player(ctx, step.player)];
      if (p.hand.length < step.count) drawCards(p, step.count - p.hand.length);
      break;
    }
    case "discard": {
      const p = state.players[player(ctx, step.player)];
      for (let i = 0; i < (step.amount ?? 1); i++) { const c = p.hand.pop(); if (c) { p.discard.push(c); p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1; } }
      break;
    }
    case "gainLore": {
      const p = state.players[player(ctx, step.player)];
      p.lore += step.amount ?? 1;
      logs.push(makeLog({ turnNumber: state.turnNumber, player: player(ctx, step.player), type: "LORE_GAINED", message: `Gain ${step.amount ?? 1} lore`, data: { lore: p.lore } }));
      break;
    }
    case "loseLore": {
      const p = state.players[player(ctx, step.player)];
      p.lore = Math.max(0, p.lore - (step.amount ?? 1));
      break;
    }
  }
}

/**
 * Run steps in order. If a `chooseCharacter` step is reached with no target to
 * bind, return a Suspension (the caller pushes a prompt). `injected` binds the
 * leading choose step when resuming.
 */
export function runSteps(
  state: GameState,
  steps: Step[],
  ctx: EffectContext,
  logs: LogEntry[],
  injected?: string,
): Suspension | null {
  let pending = injected;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.do === "chooseCharacter") {
      if (pending != null) {
        ctx.vars[step.as] = pending;
        pending = undefined;
        continue;
      }
      return { steps: steps.slice(i), scope: step.scope ?? "any", text: step.text, optional: step.optional ?? false, filter: step.filter, pick: "character" };
    }
    if (step.do === "chooseFromHand") {
      if (pending != null) {
        ctx.vars[step.as] = pending;
        pending = undefined;
        continue;
      }
      const handOwner = step.from === "opponent" ? otherPlayer(ctx.controller) : ctx.controller;
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? false, pick: "hand", handOwner };
    }
    if (step.do === "modal") {
      if (pending != null) {
        const branch = step.options[parseInt(pending, 10)]?.steps ?? [];
        pending = undefined;
        const susp = runSteps(state, branch, ctx, logs);
        if (susp) return susp; // the chosen branch needs its own choice
        continue;
      }
      return { steps: steps.slice(i), scope: "any", optional: false, pick: "mode", modes: step.options.map((o) => o.label) };
    }
    if (step.do === "chooseItem") {
      if (pending != null) { ctx.vars[step.as] = pending; pending = undefined; continue; }
      return { steps: steps.slice(i), scope: step.scope ?? "any", text: step.text, optional: step.optional ?? false, pick: "item" };
    }
    if (step.do === "discardChoose") {
      const p = state.players[ctx.controller];
      const ns = "__dcRemain";
      if (pending != null) {
        let remain = parseInt(ctx.vars[ns] ?? "0", 10);
        const idx = p.hand.findIndex((c) => c.instanceId === pending);
        if (idx >= 0) {
          const card = p.hand.splice(idx, 1)[0]!;
          p.discard.push(card);
          p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1;
          remain -= 1;
          ctx.vars[ns] = String(remain);
        }
        if (remain > 0 && p.hand.length > 0) {
          pending = undefined;
          return { steps: steps.slice(i), scope: "any", text: `discard ${remain} more`, optional: false, pick: "hand", handOwner: ctx.controller };
        }
        delete ctx.vars[ns];
        continue;
      }
      const need = Math.min(step.amount ?? dynAmount(state, ctx, 0, step.amountPer), p.hand.length);
      if (need <= 0) continue;
      ctx.vars[ns] = String(need);
      return { steps: steps.slice(i), scope: "any", text: step.text ?? `discard ${need}`, optional: false, pick: "hand", handOwner: ctx.controller };
    }
    if (step.do === "mayConfirm") {
      // A confirmed "Yes" injects a sentinel; consume it and run on. A fresh
      // arrival suspends for the Yes/No choice.
      if (pending != null) { pending = undefined; continue; }
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "confirm" };
    }
    if (step.do === "returnFromDiscard") {
      const p = state.players[ctx.controller];
      const matches = (c: CardInstance) => (!step.cardType || c.printed.type === step.cardType) && (step.maxCost == null || c.printed.cost <= step.maxCost);
      const keepUpTo = step.keepUpTo ?? 1;
      const nsK = "__rfdKept";
      if (pending != null) {
        let kept = parseInt(ctx.vars[nsK] ?? "0", 10);
        if (pending !== "__rfdstop__") {
          const idx = p.discard.findIndex((c) => c.instanceId === pending && matches(c));
          if (idx >= 0) {
            const card = p.discard.splice(idx, 1)[0]!;
            card.damage = 0; card.exerted = false; card.justPlayed = false; card.appliedEffects = [];
            p.hand.push(card);
            kept += 1;
            ctx.vars[nsK] = String(kept);
          }
        }
        const remain = p.discard.some(matches);
        if (pending !== "__rfdstop__" && kept < keepUpTo && remain) {
          pending = undefined;
          return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "discard", reveal: p.discard.filter(matches).map((c) => c.instanceId) };
        }
        delete ctx.vars[nsK];
        continue;
      }
      const pool = p.discard.filter(matches);
      if (pool.length === 0) continue;
      ctx.vars[nsK] = "0";
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? false, pick: "discard", reveal: pool.map((c) => c.instanceId) };
    }
    if (step.do === "lookAtTop") {
      const p = state.players[ctx.controller];
      const keepUpTo = step.keepUpTo ?? 1;
      const nsK = "__scryKept", nsN = "__scryN";
      const moveRest = (windowLen: number) => {
        const rest = p.deck.splice(0, Math.max(0, windowLen));
        if ((step.rest ?? "bottom") === "inkwellExerted") {
          for (const c of rest) { c.exerted = true; c.justPlayed = true; p.inkwell.push(c); }
        } else {
          p.deck.push(...rest); // to the bottom, in revealed order
        }
      };
      if (pending != null) {
        let kept = parseInt(ctx.vars[nsK] ?? "0", 10);
        const n = parseInt(ctx.vars[nsN] ?? "0", 10); // originally revealed count
        if (pending !== "__scrystop__") {
          const windowLen = n - kept;
          const idx = p.deck.findIndex((c) => c.instanceId === pending);
          if (idx >= 0 && idx < windowLen && scryMatch(p.deck[idx]!.printed, step.filter)) {
            const card = p.deck.splice(idx, 1)[0]!;
            card.justPlayed = false; card.exerted = false; p.hand.push(card);
            kept += 1;
            ctx.vars[nsK] = String(kept);
          }
        }
        const windowLen = n - kept;
        const moreLegal = p.deck.slice(0, windowLen).some((c) => scryMatch(c.printed, step.filter));
        if (pending !== "__scrystop__" && kept < keepUpTo && windowLen > 0 && moreLegal) {
          pending = undefined;
          return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "deck", reveal: p.deck.slice(0, windowLen).map((c) => c.instanceId) };
        }
        moveRest(windowLen);
        delete ctx.vars[nsK]; delete ctx.vars[nsN];
        logs.push(makeLog({ turnNumber: state.turnNumber, player: ctx.controller, type: "CARD_DRAWN", message: `Scry: kept ${kept} of top ${n}` }));
        continue;
      }
      const top = p.deck.slice(0, step.count);
      if (top.length === 0) continue; // empty deck — nothing to look at
      ctx.vars[nsN] = String(top.length);
      ctx.vars[nsK] = "0";
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? false, pick: "deck", reveal: top.map((c) => c.instanceId) };
    }
    applyStep(state, step, ctx, logs);
  }
  return null;
}
