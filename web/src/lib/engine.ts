import type { ConfigOption, Mode, Model } from "../types.ts";

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

// How much the agent may do without asking. The approval keywords are the ones
// ActionMenu's configRank already groups by (codex reports "Approval Preset"),
// plus "mode" as a whole word — claude reports the same setting as an option
// simply named "Mode", and matching it loosely would swallow "Model", whose
// name contains these four letters.
export const isModeOption = (o: ConfigOption) => {
  const k = keyOf(o);
  return /\bmode\b/.test(k) || k.includes("approval") || k.includes("permission") || k.includes("sandbox");
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
  /** The permission mode. `option` is null when the agent reports it through
   *  session modes (claude) rather than as a config option (codex). */
  mode: { name: string; option: ConfigOption | null } | null;
}

// "last ran on opus[1m] · high" — the model and thinking level a saved
// conversation was using, for the note that offers to resume it. "" when the
// gateway recorded neither.
//
// Raw values, not display names: the names live in the agent's own option list,
// which an unresumed session has none of — and a client that cold-started straight
// into a saved conversation has never seen one either, so there is nothing to
// translate against in the case this exists for. Inside a sentence a raw value
// reads fine, which is why this is a note and not a chip.
export function lastRanOn(controls: Record<string, string> | undefined): string {
  if (!controls) return "";
  const at = (match: (id: string) => boolean) =>
    Object.entries(controls).find(([id]) => match(id.toLowerCase()))?.[1];
  const model = at((id) => id.includes("model"));
  const effort = at((id) => id.includes("reason") || id.includes("thought") || id.includes("effort"));
  const parts = [model, effort].filter(Boolean);
  return parts.length ? "last ran on " + parts.join(" · ") : "";
}

// What a saved conversation the agent hasn't resumed yet reads as: nothing.
// configOptions/models/modes are store-global and only refreshed by session/new
// or session/load, so they still describe the last LIVE session — showing them
// on a view-only session both mislabels it and offers switches that fail
// ("Session not found"), since the agent holds no such session yet.
export const EMPTY_READOUT: EngineReadout = { model: null, effort: null, mode: null };

export function engineReadout(
  configOptions: ConfigOption[],
  models: Model[],
  modelId?: string | null,
  modes: Mode[] = [],
  modeId?: string | null,
): EngineReadout {
  const modelOption = configOptions.find(isModelOption) ?? null;
  const effortOption = configOptions.find(isEffortOption) ?? null;
  // Never the model option, whichever way an agent spells the two.
  const modeOption = configOptions.find((o) => o !== modelOption && isModeOption(o)) ?? null;
  const fromModels = models.find((m) => m.modelId === modelId)?.name;
  const modelName = modelOption ? currentChoice(modelOption) : fromModels;
  const modeName = modeOption ? currentChoice(modeOption) : modes.find((m) => m.id === modeId)?.name;
  return {
    model: modelName ? { name: modelName, option: modelOption } : null,
    effort: effortOption ? { name: currentChoice(effortOption), option: effortOption } : null,
    mode: modeName ? { name: modeName, option: modeOption } : null,
  };
}
