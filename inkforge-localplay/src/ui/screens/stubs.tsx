/**
 * Routable stubs for screens delivered in later work packages. Each is a
 * placeholder so navigation (spec §11) is exercisable; replaced as WPs land.
 */
function Stub({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
      <p className="text-sm text-slate-400">
        Placeholder — implemented in <span className="text-ink-sapphire">{phase}</span>.
      </p>
    </div>
  );
}

export const LocalPlayScreen = () => <Stub title="Local Play" phase="P3" />;
export const StatsScreen = () => <Stub title="Stats" phase="P3 · WP3.6" />;
export const ReplaysScreen = () => <Stub title="Replays" phase="P3 · WP3.5" />;
