import type { ProviderOptionSelection } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getFusionSelectionSummary,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
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

/** Keep the selected lead traits when switching pairings, using only choices the new lead offers. */
export function fusionOptionWithSelections(
  model: ModelOption,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ModelOption {
  if (!model.fusion || !model.capabilities) return model;
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({ caps: model.capabilities, selections }),
    selections,
  );
  const selection = options
    ? { ...model.selection, options }
    : { instanceId: model.selection.instanceId, model: model.selection.model };
  return {
    ...model,
    subtitle: getFusionSelectionSummary({
      fusion: model.fusion,
      capabilities: model.capabilities,
      selections: options,
    }),
    selection,
  };
}
