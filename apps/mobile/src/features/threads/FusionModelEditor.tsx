import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { ModelOption } from "../../lib/modelOptions";
import type { ProviderOptionSelection } from "@t3tools/contracts";
import { fusionLeadPairing, fusionOptionWithSelections } from "./fusion-model-options";

export function FusionModelEditor(props: {
  readonly models: ReadonlyArray<ModelOption>;
  readonly initialKey: string;
  readonly initialOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly onSelect: (model: ModelOption) => void;
}) {
  const [selectedKey, setSelectedKey] = useState(props.initialKey);
  const [editing, setEditing] = useState<"lead" | "sidekick" | null>(null);
  const available = props.models.filter((model) => model.fusion && !model.isUnavailable);
  const selectedModel = available.find((model) => model.key === selectedKey) ?? available[0];
  const selected = selectedModel
    ? fusionOptionWithSelections(selectedModel, props.initialOptions)
    : undefined;
  if (!selected?.fusion) {
    return <Text className="p-4 text-foreground-muted">No Fusion pairings available.</Text>;
  }
  const pairing = selected.fusion;
  const choices = editing
    ? [
        ...new Map(
          available
            .filter((model) => editing === "lead" || model.fusion?.lead.id === pairing.lead.id)
            .map((model) => [model.fusion?.[editing].id, model]),
        ).values(),
      ]
    : [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 py-6"
    >
      <View className="gap-2">
        <Text className="text-base text-foreground-muted">{selected.providerLabel}</Text>
        <Text className="text-sm text-foreground-muted">
          Choose a lead model and a sidekick to work together.
        </Text>
        <Text className="text-sm text-foreground">{selected.subtitle}</Text>
      </View>
      <View className="gap-4">
        {(["lead", "sidekick"] as const).map((role) => (
          <View key={role} className="gap-2">
            <Text className="text-sm font-t3-medium text-foreground-muted">
              {role === "lead" ? "Lead" : "Sidekick"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${role === "lead" ? "Lead" : "Sidekick"}: ${pairing[role].name}`}
              accessibilityState={{ expanded: editing === role }}
              onPress={() => setEditing(editing === role ? null : role)}
              className="min-h-14 flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3 active:bg-subtle"
            >
              <View
                className={
                  role === "lead"
                    ? "size-2 rounded-full bg-blue-400"
                    : "size-2 rounded-full bg-emerald-400"
                }
              />
              <Text className="flex-1 text-base font-t3-medium text-foreground">
                {pairing[role].name}
              </Text>
              <SymbolView
                name={editing === role ? "chevron.up" : "chevron.down"}
                size={14}
                tintColorClassName="accent-icon"
              />
            </Pressable>
            {editing === role ? (
              <View className="overflow-hidden rounded-2xl bg-card">
                {choices.map((model) => (
                  <Pressable
                    key={model.key}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: model.fusion?.[role].id === pairing[role].id }}
                    onPress={() => {
                      const next =
                        role === "lead"
                          ? fusionLeadPairing(available, selected, model.fusion?.lead.id ?? "")
                          : model;
                      if (next) setSelectedKey(next.key);
                      setEditing(null);
                    }}
                    className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
                  >
                    <Text className="flex-1 text-base text-foreground">
                      {model.fusion?.[role].name}
                    </Text>
                    {model.fusion?.[role].id === pairing[role].id ? (
                      <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
                    ) : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => props.onSelect(selected)}
        className="min-h-12 items-center justify-center rounded-2xl bg-primary px-4 py-3 active:opacity-70"
      >
        <Text className="text-base font-t3-medium text-primary-foreground">Use Fusion</Text>
      </Pressable>
    </ScrollView>
  );
}
