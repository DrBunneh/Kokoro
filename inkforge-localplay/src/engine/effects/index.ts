/** Loads the seeded card-effects map (slug → EffectDef[]) for the DSL. */
import data from "./card-effects.json";
import type { CardEffects } from "./dsl";

const { $schema: _schema, ...rest } = data as Record<string, unknown>;

export const cardEffects: CardEffects = rest as CardEffects;
