import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  collapseFusionModelsForSettings,
  groupModelsForDisplay,
  nextHiddenModelsForBulkToggle,
} from "./ProviderModelsSection";

function model(slug: string, isCustom = false): ServerProviderModel {
  return { slug, name: slug, isCustom, capabilities: null };
}

describe("groupModelsForDisplay", () => {
  it("lists favorites first, then visible models in user order, then hidden ones", () => {
    const models = [model("a"), model("b"), model("c"), model("d"), model("custom", true)];

    const display = groupModelsForDisplay(models, {
      favoriteModels: new Set(["c"]),
      hiddenModels: new Set(["a", "custom"]),
      modelOrder: ["d", "b"],
    });

    // A custom model is never hidden, even if its slug is in the hidden set.
    expect(display.map((entry) => entry.slug)).toEqual(["c", "d", "b", "custom", "a"]);
  });
});

describe("collapseFusionModelsForSettings", () => {
  it("shows one Fusion row while retaining ordinary models", () => {
    const base = { isCustom: false, capabilities: null };
    const fusion = {
      lead: { id: "opus", name: "Opus" },
      sidekick: { id: "swe", name: "SWE" },
    };
    expect(
      collapseFusionModelsForSettings([
        { ...base, slug: "swe", name: "SWE" },
        { ...base, slug: "fusion/opus/swe", name: "Fusion (Opus + SWE)", fusion },
        {
          ...base,
          slug: "fusion/opus/glm",
          name: "Fusion (Opus + GLM)",
          fusion: { ...fusion, sidekick: { id: "glm", name: "GLM" } },
        },
      ]).map((model) => [model.slug, model.name]),
    ).toEqual([
      ["swe", "SWE"],
      ["fusion/opus/swe", "Fusion"],
    ]);
  });
});

describe("nextHiddenModelsForBulkToggle", () => {
  it("hides every built-in model without hiding custom models", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a"])).toEqual(["a", "b"]);
  });

  it("shows every built-in model while preserving unrelated hidden entries", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a", "b", "legacy", "custom"])).toEqual([
      "legacy",
      "custom",
    ]);
  });
});
