/**
 * Low-level zone mutators shared by the reducer and the effect interpreter
 * (kept separate to avoid a circular import). Pure helpers that mutate a draft.
 */
import type { CardInstance, GameState, PlayerId, PlayerState } from "./state";
import { makeLog, type LogEntry } from "./replay";

export type Zone = "hand" | "field" | "items" | "inkwell" | "discard" | "deck";

/** Draw `n` from the top of a player's deck; returns false if they decked out. */
export function drawCards(p: PlayerState, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const card = p.deck.shift();
    if (!card) return false;
    p.hand.push(card);
  }
  return true;
}

/** Banish a card from a player's field/items to discard (with any tucked cards). */
export function banishCard(p: PlayerState, card: CardInstance, logs: LogEntry[], turnNumber: number): void {
  const fi = p.field.indexOf(card);
  if (fi >= 0) p.field.splice(fi, 1);
  else {
    const ii = p.items.indexOf(card);
    if (ii >= 0) p.items.splice(ii, 1);
  }
  if (card.cardsUnder.length) {
    p.discard.push(...card.cardsUnder);
    p.discardedThisTurn = (p.discardedThisTurn ?? 0) + card.cardsUnder.length;
    card.cardsUnder = [];
  }
  card.damage = 0;
  card.exerted = false;
  card.justPlayed = false;
  card.appliedEffects = [];
  p.discard.push(card);
  p.discardedThisTurn = (p.discardedThisTurn ?? 0) + 1;
  logs.push(makeLog({ turnNumber, player: null, type: "CARD_DESTROYED", message: `${card.printed.fullName} was banished`, cardRefs: [{ id: card.printed.id, name: card.printed.fullName }] }));
}

export interface Located {
  card: CardInstance;
  owner: PlayerId;
  zone: Zone;
}

/** Find a card instance anywhere in the game. */
export function findInstance(state: GameState, instanceId: string): Located | undefined {
  const zones: Zone[] = ["field", "hand", "items", "inkwell", "discard", "deck"];
  for (const owner of [1, 2] as PlayerId[]) {
    for (const zone of zones) {
      const card = state.players[owner][zone].find((c) => c.instanceId === instanceId);
      if (card) return { card, owner, zone };
    }
  }
  return undefined;
}
