/**
 * Shared board presentational pieces used by both the hot-seat and networked
 * boards: the inkwell pool, the items strip, and a small ability helper. Keeping
 * them here keeps the two boards visually consistent.
 */
import { CardThumb } from "@/ui/components/CardThumb";
import { classifyTrigger } from "@/engine/effects/dsl";
import { cn } from "@/lib/cn";
import type { CardInstance, GameState, PlayerId } from "@/engine/state";

/** The card's first activated ({E}/ink/banish-cost) ability, if any. */
export function activatedAbility(card: CardInstance) {
  return card.printed.specialAbilities.find((a) => classifyTrigger(a.effect, card.printed.type) === "activated");
}

/**
 * Inkwell as a shared card pool. Freshly-inked cards (justPlayed) are face-up
 * to both players until the end of the turn they're played; then card backs.
 */
export function InkPool({ player, mine }: { player: GameState["players"][PlayerId]; mine?: boolean }) {
  const ink = player.inkwell;
  return (
    <div className="flex items-center justify-center gap-0.5">
      <span className="mr-1 w-16 shrink-0 text-right text-[10px] text-slate-500">
        {mine ? "your" : "their"} ink {ink.filter((c) => !c.exerted).length}/{ink.length}
      </span>
      <div className="flex flex-wrap items-center gap-0.5">
        {ink.length === 0 && <span className="text-[10px] text-slate-600">—</span>}
        {ink.map((c) => (
          <div key={c.instanceId} className={cn("h-9 w-6 overflow-hidden rounded-sm border border-white/15", c.exerted && "rotate-12 opacity-40")}>
            {c.justPlayed ? (
              <CardThumb card={c.printed} className="h-full w-full rounded-none" />
            ) : (
              <div className="h-full w-full bg-gradient-to-br from-indigo-700 to-slate-900" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Items / locations in play. Shown as a thin strip on the owner's board. */
export function ItemRow({ items, enemy, selectedId, onItemTap }: { items: CardInstance[]; enemy?: boolean; selectedId?: string | null; onItemTap: (c: CardInstance) => void }) {
  if (items.length === 0) return null;
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto rounded-lg px-1 py-0.5", enemy ? "bg-rose-500/5" : "bg-amber-500/5")}>
      <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-500">items</span>
      {items.map((c) => (
        <button
          key={c.instanceId}
          onClick={() => onItemTap(c)}
          className={cn(
            "relative w-12 shrink-0 rounded transition",
            c.exerted && "rotate-6 opacity-80",
            selectedId === c.instanceId && "ring-2 ring-ink-amethyst",
            activatedAbility(c) && "ring-1 ring-violet-300/40",
          )}
        >
          <CardThumb card={c.printed} />
          {c.damage > 0 && <span className="absolute right-0 top-0 rounded-bl bg-rose-600 px-1 text-[10px] font-bold text-white">{c.damage}</span>}
        </button>
      ))}
    </div>
  );
}
