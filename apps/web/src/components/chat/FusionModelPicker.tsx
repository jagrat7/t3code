import { useId, useState } from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CheckIcon } from "lucide-react";
import type { ProviderOptionSelection } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { DevinIcon } from "../Icons";
import { findFusionLeadPairing, fusionOptionsForModel } from "./fusionModelPicker";
import { getModelVendorIcon, type ModelEsque } from "./providerIconUtils";

/** Lead and sidekick lists side by side; each pick applies the pairing immediately. */
export function FusionModelPicker(props: {
  models: ReadonlyArray<ModelEsque>;
  model: string;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  onSelect: (model: string, options?: ReadonlyArray<ProviderOptionSelection>) => void;
}) {
  const [selectedSlug, setSelectedSlug] = useState(() =>
    props.models.some((model) => model.slug === props.model) ? props.model : props.models[0]?.slug,
  );
  const pairing = props.models.find((model) => model.slug === selectedSlug)?.fusion;

  const selectPairing = (model: ModelEsque | undefined) => {
    if (!model) return;
    setSelectedSlug(model.slug);
    props.onSelect(model.slug, fusionOptionsForModel(model, props.modelOptions));
  };
  const leads = [
    ...new Map(
      props.models.flatMap((model) =>
        model.fusion ? [[model.fusion.lead.id, model.fusion.lead.name] as const] : [],
      ),
    ),
  ].map(([value, label]) => ({ value, label }));
  const sidekicks = props.models.flatMap((model) =>
    model.fusion && model.fusion.lead.id === pairing?.lead.id
      ? [{ value: model.slug, label: model.fusion.sidekick.name }]
      : [],
  );

  return (
    <div className="flex max-h-86.5 w-max max-w-[calc(100vw-2rem)] flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-2 text-xs">
        <DevinIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium">Fusion</span>
      </div>
      {selectedSlug && pairing ? (
        <div className="flex min-h-0">
          <FusionColumn
            label="Lead"
            options={leads}
            value={pairing.lead.id}
            onValueChange={(leadId) =>
              selectPairing(findFusionLeadPairing(props.models, leadId, pairing.sidekick.id))
            }
          />
          <FusionColumn
            label="Sidekick"
            className="border-l border-border/70"
            options={sidekicks}
            value={selectedSlug}
            onValueChange={(slug) =>
              selectPairing(props.models.find((model) => model.slug === slug))
            }
          />
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">No Fusion pairings available</p>
      )}
    </div>
  );
}

function FusionColumn(props: {
  label: string;
  className?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const labelId = useId();
  return (
    <div className={cn("flex max-w-64 min-w-0 flex-col p-1", props.className)}>
      <div id={labelId} className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
        {props.label}
      </div>
      <RadioGroup
        aria-labelledby={labelId}
        value={props.value}
        onValueChange={props.onValueChange}
        className="min-h-0 overflow-y-auto"
      >
        {props.options.map((option) => {
          const VendorIcon = getModelVendorIcon(option.label);
          return (
            <Radio.Root
              key={option.value}
              value={option.value}
              className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-foreground outline-none transition-[background-color] hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset data-checked:bg-foreground/[0.08]"
            >
              {VendorIcon ? (
                <VendorIcon className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <span className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <Radio.Indicator className="flex shrink-0">
                <CheckIcon className="size-3.5" aria-hidden="true" />
              </Radio.Indicator>
            </Radio.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}
