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
import { effectiveWillpower } from "../keywords";
import type { CardType } from "@/data/card-types";

export type Trigger =
  | "on_play"
  | "on_quest"
  | "on_challenge"
  | "on_banish"
  | "start_of_turn"
  | "end_of_turn"
  | "activated";

export type Scope = "any" | "ally" | "enemy";
export type Who = "self" | "opponent";

/** Restricts which characters are a legal target (e.g. "with 3 {S} or less"). */
export interface TargetFilter {
  maxStrength?: number;
  minStrength?: number;
  maxCost?: number;
  subtype?: string;
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
  // Banish every character (Be Prepared) — or a scoped subset.
  | { do: "banishAll"; scope?: Scope }
  // Choose a card from your own hand (suspends for a hand tap):
  | { do: "chooseFromHand"; as: string; text?: string; optional?: boolean }
  // Move a bound (hand) card into the inkwell / discard:
  | { do: "toInkwell"; from: string; exerted?: boolean }
  | { do: "discardCard"; from: string }
  // Damage:
  | { do: "dealDamage"; to: string; amount: number }
  | { do: "removeDamage"; to: string; amount: number }
  // Movement / removal:
  | { do: "banish"; to: string }
  | { do: "returnToHand"; to: string }
  // Stats (until end of turn unless duration given):
  | { do: "buff" | "debuff"; to: string; strength?: number; willpower?: number; lore?: number; duration?: "end_of_turn" | "permanent" }
  | { do: "ready" | "exert"; to: string }
  // Cards / lore:
  | { do: "draw"; player?: Who; amount?: number }
  | { do: "discard"; player?: Who; amount?: number }
  | { do: "gainLore" | "loseLore"; player?: Who; amount?: number };

export interface EffectDef {
  trigger: Trigger;
  steps: Step[];
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
  /** What the resolver picks: a board character, a hand card, a Yes/No, or a revealed deck card. */
  pick: "character" | "hand" | "confirm" | "deck";
  /** For pick === "deck": the revealed card instanceIds to show face-up. */
  reveal?: string[];
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

function applyStep(state: GameState, step: Step, ctx: EffectContext, logs: LogEntry[]): void {
  switch (step.do) {
    case "dealDamage": {
      const t = resolveTarget(state, ctx, step.to);
      if (!t) return;
      t.damage += step.amount;
      const loc = findInstance(state, t.instanceId);
      if (loc && t.damage >= effectiveWillpower(t)) {
        banishCard(state.players[loc.owner], t, logs, state.turnNumber);
        ctx.banished?.push({ card: t, owner: loc.owner });
      }
      break;
    }
    case "removeDamage": {
      const t = resolveTarget(state, ctx, step.to);
      if (t) t.damage = Math.max(0, t.damage - step.amount);
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
      t.appliedEffects.push({
        source: ctx.source.instanceId,
        strength: step.strength != null ? s * step.strength : undefined,
        willpower: step.willpower != null ? s * step.willpower : undefined,
        lore: step.lore != null ? s * step.lore : undefined,
        duration: step.duration ?? "end_of_turn",
      });
      break;
    }
    case "ready": { const t = resolveTarget(state, ctx, step.to); if (t) t.exerted = false; break; }
    case "exert": { const t = resolveTarget(state, ctx, step.to); if (t) t.exerted = true; break; }
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
      }
      break;
    }
    case "banishAll": {
      const scope = step.scope ?? "any";
      for (const owner of [1, 2] as PlayerId[]) {
        if (scope === "ally" && owner !== ctx.controller) continue;
        if (scope === "enemy" && owner === ctx.controller) continue;
        const chars = state.players[owner].field.filter((c) => c.printed.type === "character");
        for (const c of chars) {
          banishCard(state.players[owner], c, logs, state.turnNumber);
          ctx.banished?.push({ card: c, owner });
        }
      }
      break;
    }
    case "draw": {
      const p = state.players[player(ctx, step.player)];
      drawCards(p, step.amount ?? 1);
      logs.push(makeLog({ turnNumber: state.turnNumber, player: player(ctx, step.player), type: "CARD_DRAWN", message: `Draw ${step.amount ?? 1}` }));
      break;
    }
    case "discard": {
      const p = state.players[player(ctx, step.player)];
      for (let i = 0; i < (step.amount ?? 1); i++) { const c = p.hand.pop(); if (c) p.discard.push(c); }
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
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: step.optional ?? false, pick: "hand" };
    }
    if (step.do === "mayConfirm") {
      // A confirmed "Yes" injects a sentinel; consume it and run on. A fresh
      // arrival suspends for the Yes/No choice.
      if (pending != null) { pending = undefined; continue; }
      return { steps: steps.slice(i), scope: "any", text: step.text, optional: true, pick: "confirm" };
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
