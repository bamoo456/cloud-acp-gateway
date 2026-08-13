import type { ConfigOption, Model } from "../types.ts";

// What is answering, on what model, at what thinking level. Every field is
// read back from what the agent itself reported — never a string this client
// invented. The mockup's "opus-5" / "think:high" are placeholders, not copy
// (docs/ui-refactor-plan.md §2.2).

const keyOf = (o: ConfigOption) => `${o.category || ""} ${o.id} ${o.name}`.toLowerCase();

export const isModelOption = (o: ConfigOption) => keyOf(o).includes("model");

// The same two keywords ActionMenu's configRank already ranks reasoning options
// by, so the dock and the settings sheet can never disagree about which option
// is the thinking level.
export const isEffortOption = (o: ConfigOption) => {
  const k = keyOf(o);
  return k.includes("reason") || k.includes("thought");
};

// The label an option currently reads as. Falls back to the raw value: an agent
// may report a currentValue that isn't in its own options list (a model change
// can clamp it), and showing the raw value beats showing nothing.
export const currentChoice = (o: ConfigOption) =>
  o.options.find((x) => x.value === o.currentValue)?.name || o.currentValue;

export interface EngineReadout {
  /** null when the agent exposes no model at all. */
  model: { name: string; option: ConfigOption | null } | null;
  /** null when the agent has no thinking level — opencode reports none, and the
   *  segment must then disappear rather than render a "—" placeholder. */
  effort: { name: string; option: ConfigOption } | null;
}

export function engineReadout(
  configOptions: ConfigOption[],
  models: Model[],
  modelId?: string | null,
): EngineReadout {
  const modelOption = configOptions.find(isModelOption) ?? null;
  const effortOption = configOptions.find(isEffortOption) ?? null;
  const fromModels = models.find((m) => m.modelId === modelId)?.name;
  const modelName = modelOption ? currentChoice(modelOption) : fromModels;
  return {
    model: modelName ? { name: modelName, option: modelOption } : null,
    effort: effortOption ? { name: currentChoice(effortOption), option: effortOption } : null,
  };
}
