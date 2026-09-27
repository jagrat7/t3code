import type { ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import type { DevinModelCatalog } from "./DevinModels.ts";

/** Native family IDs and config values are independent of model display labels. */
export const applyDevinNativeModelSelection = Effect.fn("applyDevinNativeModelSelection")(
  function* (input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel" | "setConfigOption"
    >;
    readonly selection: ModelSelection;
    readonly getCatalog: Effect.Effect<typeof DevinModelCatalog.Type, AcpErrors.AcpError>;
  }) {
    const { runtime, selection } = input;
    // Saved IDs and implicit defaults still need the catalog's compatibility
    // translation. Explicit native choices do not depend on display labels.
    if (
      !selection.options?.length ||
      selection.options.some((option) => option.id === "contextWindow")
    )
      return Option.none<string>();
    const before = yield* runtime.getConfigOptions;
    const modelOption = before.find((option) => option.id === "model");
    if (modelOption?.type !== "select") return Option.none<string>();
    const offered = collectSessionConfigOptionValues(modelOption);
    let modelId: string | undefined;
    if (offered.includes(selection.model)) {
      modelId = selection.model;
    } else {
      const catalog = yield* input.getCatalog;
      const family = catalog.families.find(
        (family) =>
          family.slug !== "fusion" &&
          (family.slug === selection.model || family.aliases?.includes(selection.model)),
      );
      if (!family) return Option.none<string>();
      const candidates = family.variants.filter((variant) => offered.includes(variant.model_uid));
      // A family picker advertises one representative. Multiple entries are
      // legacy variants whose exact IDs must still be resolved by the catalog.
      if (candidates.length !== 1) return Option.none<string>();
      modelId = candidates[0]?.model_uid;
    }
    if (!modelId) return Option.none<string>();
    yield* runtime.setModel(modelId);
    const controls = yield* runtime.getConfigOptions;
    if (!controls.some((option) => option.id === "thought_level" || option.id === "speed"))
      return Option.none<string>();

    const updates: Array<{ id: string; value: string | boolean }> = [];
    for (const selected of selection.options ?? []) {
      const id =
        selected.id === "reasoningEffort"
          ? "thought_level"
          : selected.id === "fastMode"
            ? "speed"
            : selected.id;
      const value =
        selected.id === "fastMode" && typeof selected.value === "boolean"
          ? selected.value
            ? "fast"
            : "standard"
          : selected.value;
      const option = controls.find(
        (option) => option.id === id && option.id !== "model" && option.id !== "mode",
      );
      // Models without a speed control run at standard speed.
      if (!option && selected.id === "fastMode" && selected.value === false) continue;
      if (
        (selected.id === "fastMode" && typeof selected.value !== "boolean") ||
        !option ||
        (option.type === "select"
          ? typeof value !== "string" || !collectSessionConfigOptionValues(option).includes(value)
          : typeof value !== "boolean")
      ) {
        return yield* AcpErrors.AcpRequestError.invalidParams(
          `Devin does not offer the selected ${selected.id} value for ${selection.model}. Refresh provider status and choose an available option.`,
        );
      }
      updates.push({ id, value });
    }
    // Validate the whole selection before applying any individual option.
    for (const update of updates) yield* runtime.setConfigOption(update.id, update.value);
    return Option.some(modelId);
  },
);
