import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  DevinIcon,
  GrokIcon,
  Icon,
  OpenAI,
  OpenCodeIcon,
  ZaiIcon,
} from "../Icons";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("devin")]: DevinIcon,
};

// Fusion lists models from several vendors under one provider, so each
// entry is marked by the vendor its display name starts with.
const MODEL_VENDOR_ICONS: ReadonlyArray<readonly [RegExp, Icon]> = [
  [/^claude\b/i, ClaudeAI],
  [/^gpt\b|^o\d/i, OpenAI],
  [/^grok\b/i, GrokIcon],
  [/^swe\b/i, DevinIcon],
  [/^glm\b/i, ZaiIcon],
];

export function getModelVendorIcon(name: string): Icon | null {
  return MODEL_VENDOR_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

export type ModelEsque = {
  isFusionGroup?: boolean;
  fusion?: ServerProviderModel["fusion"];
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
  capabilities?: ModelCapabilities | null | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
