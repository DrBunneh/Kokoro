import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/cn";
import { UpdateButton } from "@/ui/components/UpdateButton";

/** Main menu (spec §11.1): logo + 2×2 grid Decks | Play / Stats | Replays. */
export function MainMenu() {
  const navigate = useNavigate();
  const tiles: Array<{ label: string; to: string }> = [
    { label: "Decks", to: "/decks" },
    { label: "Play", to: "/play" },
    { label: "Stats", to: "/stats" },
    { label: "Replays", to: "/replays" },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center py-8">
        <div className="text-4xl font-bold tracking-tight text-slate-100">Inkwell</div>
        <p className="mt-1 text-xs text-slate-500">Offline Lorcana duel simulator</p>
      </div>
      <div className="grid grid-cols-2 gap-3 pb-6">
        {tiles.map((t) => (
          <button
            key={t.to}
            type="button"
            onClick={() => navigate(t.to)}
            className={cn(
              "min-h-tap aspect-square rounded-2xl border border-white/10",
              "bg-white/5 text-lg font-semibold text-slate-100 active:bg-white/10",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="pb-4">
        <UpdateButton />
      </div>
    </div>
  );
}
