import type { ModelOption } from "../../lib/modelOptions";

/** Collapse only available pairings, keeping unavailable selections visible. */
export function collapseFusionOptions(
  models: ReadonlyArray<ModelOption>,
  isSelected: (model: ModelOption) => boolean,
) {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    if (!model.fusion || model.isUnavailable) return [model];
    if (seen.has(model.providerKey)) return [];
    seen.add(model.providerKey);
    return [
      models.find(
        (candidate) =>
          candidate.providerKey === model.providerKey &&
          candidate.fusion &&
          !candidate.isUnavailable &&
          isSelected(candidate),
      ) ?? model,
    ];
  });
}

export function fusionLeadPairing(
  models: ReadonlyArray<ModelOption>,
  current: ModelOption,
  leadId: string,
) {
  const candidates = models.filter(
    (model) =>
      model.providerKey === current.providerKey &&
      !model.isUnavailable &&
      model.fusion?.lead.id === leadId,
  );
  return (
    candidates.find((model) => model.fusion?.sidekick.id === current.fusion?.sidekick.id) ??
    candidates[0]
  );
}
