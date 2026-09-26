import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type {
  ElicitationRequest,
  ElicitationResponse,
  ElicitationContentValue,
} from "effect-acp/schema";

type Form = Extract<ElicitationRequest, { mode: "form" }>;

/** ACP form fields use the same question UI as the other providers. */
export function devinQuestions(request: Form): ReadonlyArray<UserInputQuestion> {
  return Object.entries(request.requestedSchema.properties ?? {}).map(([id, field]) => {
    const choices =
      field.type === "string"
        ? (field.oneOf ?? field.enum?.map((value) => ({ const: value, title: value })) ?? [])
        : field.type === "array"
          ? "anyOf" in field.items
            ? field.items.anyOf
            : field.items.enum.map((value) => ({ const: value, title: value }))
          : field.type === "boolean"
            ? [
                { const: "true", title: "Yes" },
                { const: "false", title: "No" },
              ]
            : [];
    return {
      id,
      header: field.title?.trim() || id,
      question: field.description?.trim() || field.title?.trim() || request.message,
      options: choices.map((choice) => ({
        label: choice.title || choice.const,
        value: choice.const,
        description: "",
      })),
      allowCustomAnswer: choices.length === 0,
      multiSelect: field.type === "array",
    };
  });
}

/** Restore the primitive types ACP expects from the client's text answers. */
export function devinAnswers(
  request: Form,
  answers: ProviderUserInputAnswers,
): ElicitationResponse {
  if (Object.keys(answers).length === 0) return { action: { action: "cancel" } };
  const content: Record<string, ElicitationContentValue> = {};
  for (const [id, field] of Object.entries(request.requestedSchema.properties ?? {})) {
    const value = answers[id];
    if (value === undefined || value === "") {
      if (request.requestedSchema.required?.includes(id)) return { action: { action: "cancel" } };
      continue;
    }
    if (field.type === "string" && typeof value === "string") content[id] = value;
    else if (
      field.type === "boolean" &&
      (typeof value === "boolean" || value === "true" || value === "false")
    )
      content[id] = value === true || value === "true";
    else if (
      (field.type === "number" || field.type === "integer") &&
      (typeof value === "number" || typeof value === "string")
    ) {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number)))
        return { action: { action: "cancel" } };
      content[id] = number;
    } else if (
      field.type === "array" &&
      Array.isArray(value) &&
      value.every((entry): entry is string => typeof entry === "string")
    )
      content[id] = value;
    else return { action: { action: "cancel" } };
  }
  return { action: { action: "accept", content } };
}
