import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ModelOption } from "../../lib/modelOptions";
import {
  collapseFusionOptions,
  fusionLeadPairing,
  fusionOptionWithSelections,
} from "./fusion-model-options";

function pairing(provider: string, lead: string, sidekick: string): ModelOption {
  return {
    key: `${provider}:${lead}:${sidekick}`,
    providerKey: provider,
    providerDriver: "devin",
    providerLabel: provider,
    label: "Fusion",
    subtitle: `${lead} + ${sidekick}`,
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make(provider),
      model: `${lead}:${sidekick}`,
    },
    fusion: { lead: { id: lead, name: lead }, sidekick: { id: sidekick, name: sidekick } },
  };
}

describe("mobile Fusion pairing selection", () => {
  it("keeps the selected pairing per account and unavailable selections visible", () => {
    const first = pairing("a", "lead", "one");
    const selected = pairing("a", "lead", "two");
    const otherAccount = pairing("b", "lead", "two");
    const unavailable = { ...pairing("a", "removed", "one"), isUnavailable: true };
    expect(
      collapseFusionOptions([first, selected, otherAccount, unavailable], (m) => m === selected),
    ).toEqual([selected, otherAccount, unavailable]);
  });

  it("carries supported traits to a new pairing and updates its summary", () => {
    const model = {
      ...pairing("a", "Opus", "SWE"),
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Thinking level",
            type: "select" as const,
            currentValue: "medium",
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
          { id: "fastMode", label: "Fast mode", type: "boolean" as const, currentValue: false },
        ],
      },
    };
    const next = fusionOptionWithSelections(model, [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
      { id: "contextWindow", value: "removed" },
    ]);
    expect(next.selection.options).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    expect(next.subtitle).toBe("Opus + SWE · High · Fast");
  });

  it("preserves the sidekick when changing leads, falling back only to an offered pairing", () => {
    const current = pairing("a", "old", "two");
    const first = pairing("a", "new", "one");
    const matching = pairing("a", "new", "two");
    expect(fusionLeadPairing([first, matching], current, "new")).toBe(matching);
    expect(fusionLeadPairing([first, { ...matching, isUnavailable: true }], current, "new")).toBe(
      first,
    );
    expect(fusionLeadPairing([pairing("b", "new", "two")], current, "new")).toBeUndefined();
  });
});
