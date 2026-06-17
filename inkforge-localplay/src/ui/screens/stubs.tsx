/**
 * Routable stubs for screens delivered after this work package. Each is a
 * placeholder so navigation (spec §11) is exercisable from the first build;
 * they are replaced as their work packages land.
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

export const DecksScreen = () => <Stub title="Decks" phase="P0 · WP0.6" />;
export const DeckBuilderScreen = () => <Stub title="Deck builder" phase="P0 · WP0.7" />;
export const DecklistsScreen = () => <Stub title="Decklists" phase="P0 · WP0.8" />;
export const PlayMenuScreen = () => <Stub title="Play" phase="P0 · WP0.5" />;
export const MulliganScreen = () => <Stub title="Mulligan" phase="P0 · WP0.9" />;
export const LocalPlayScreen = () => <Stub title="Local Play" phase="P3" />;
export const StatsScreen = () => <Stub title="Stats" phase="P3 · WP3.6" />;
export const ReplaysScreen = () => <Stub title="Replays" phase="P3 · WP3.5" />;
