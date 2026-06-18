/**
 * Declarative Effect DSL (spec §7.1). A small JSON dialect describing common
 * card effects, attached to cards by `specialAbilities[].slug`. DSL-covered
 * effects resolve automatically; anything uncovered falls back to Manual Mode.
 */
import { otherPlayer, type CardInstance, type GameState, type PlayerId } from "../state";
import { makeLog, type LogEntry } from "../replay";
import { banishCard, drawCards, findInstance } from "../zones";
import { effectiveWillpower } from "../keywords";

export type Trigger =
  | "on_play"
  | "on_quest"
  | "on_challenge"
  | "on_banish"
  | "start_of_turn"
  | "end_of_turn"
  | "activated";

export type TargetSpec = "self_card" | "chosen_character" | "chosen_enemy" | "chosen_ally";

export interface EffectOp {
  op:
    | "draw"
    | "discard"
    | "gainLore"
    | "loseLore"
    | "dealDamage"
    | "removeDamage"
    | "banish"
    | "returnToHand"
    | "buff"
    | "debuff"
    | "ready"
    | "exert";
  player?: "self" | "opponent";
  amount?: number;
  target?: TargetSpec;
  strength?: number;
  willpower?: number;
  lore?: number;
  duration?: "end_of_turn" | "permanent";
}

export interface EffectDef {
  trigger: Trigger;
  effects: EffectOp[];
}

export type CardEffects = Record<string, EffectDef[]>;

/** True if any op in a def requires the player to choose a target. */
export function defNeedsChoice(def: EffectDef): boolean {
  return def.effects.some((op) => op.target != null && op.target !== "self_card");
}

export interface EffectContext {
  controller: PlayerId;
  source: CardInstance;
  /** Resolved target instance id for choice ops. */
  chosenInstanceId?: string;
}

function resolvePlayer(controller: PlayerId, who: EffectOp["player"]): PlayerId {
  return who === "opponent" ? otherPlayer(controller) : controller;
}

/** Apply a single DSL op to the draft state. */
export function applyEffectOp(
  state: GameState,
  op: EffectOp,
  ctx: EffectContext,
  logs: LogEntry[],
): void {
  const controller = ctx.controller;
  const p = state.players[resolvePlayer(controller, op.player)];
  const amount = op.amount ?? 1;

  const target = (): CardInstance | undefined => {
    if (op.target === "self_card") return ctx.source;
    if (ctx.chosenInstanceId) return findInstance(state, ctx.chosenInstanceId)?.card;
    return undefined;
  };

  switch (op.op) {
    case "draw":
      drawCards(p, amount);
      logs.push(makeLog({ turnNumber: state.turnNumber, player: resolvePlayer(controller, op.player), type: "CARD_DRAWN", message: `Draw ${amount}` }));
      break;
    case "discard":
      for (let i = 0; i < amount; i++) {
        const c = p.hand.pop();
        if (c) p.discard.push(c);
      }
      break;
    case "gainLore":
      p.lore += amount;
      logs.push(makeLog({ turnNumber: state.turnNumber, player: resolvePlayer(controller, op.player), type: "LORE_GAINED", message: `Gain ${amount} lore`, data: { lore: p.lore } }));
      break;
    case "loseLore":
      p.lore = Math.max(0, p.lore - amount);
      break;
    case "dealDamage": {
      const t = target();
      if (t) {
        t.damage += amount;
        const loc = findInstance(state, t.instanceId)!;
        if (t.damage >= effectiveWillpower(t)) banishCard(state.players[loc.owner], t, logs, state.turnNumber);
      }
      break;
    }
    case "removeDamage": {
      const t = target();
      if (t) t.damage = Math.max(0, t.damage - amount);
      break;
    }
    case "banish": {
      const t = target();
      if (t) {
        const loc = findInstance(state, t.instanceId)!;
        banishCard(state.players[loc.owner], t, logs, state.turnNumber);
      }
      break;
    }
    case "returnToHand": {
      const t = target();
      if (t) {
        const loc = findInstance(state, t.instanceId);
        if (loc) {
          const arr = state.players[loc.owner][loc.zone];
          const i = arr.indexOf(t);
          if (i >= 0) arr.splice(i, 1);
          t.damage = 0;
          t.exerted = false;
          t.justPlayed = false;
          t.appliedEffects = [];
          state.players[loc.owner].hand.push(t);
        }
      }
      break;
    }
    case "buff":
    case "debuff": {
      const t = target();
      if (t) {
        const sign = op.op === "debuff" ? -1 : 1;
        t.appliedEffects.push({
          source: ctx.source.instanceId,
          strength: op.strength != null ? sign * op.strength : undefined,
          willpower: op.willpower != null ? sign * op.willpower : undefined,
          lore: op.lore != null ? sign * op.lore : undefined,
          duration: op.duration ?? "end_of_turn",
        });
      }
      break;
    }
    case "ready": {
      const t = target();
      if (t) t.exerted = false;
      break;
    }
    case "exert": {
      const t = target();
      if (t) t.exerted = true;
      break;
    }
  }
}
