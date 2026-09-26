import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type {
  ElicitationRequest,
  ElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
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

function answerSchema(field: ElicitationPropertySchema) {
  switch (field.type) {
    case "string": {
      let schema = Schema.String;
      for (const choices of [field.enum, field.oneOf?.map((option) => option.const)]) {
        if (choices != null)
          schema = schema.check(
            Schema.makeFilter((value) => choices.includes(value) || "Choose an offered value."),
          );
      }
      if (field.minLength != null) schema = schema.check(Schema.isMinLength(field.minLength));
      if (field.maxLength != null) schema = schema.check(Schema.isMaxLength(field.maxLength));
      if (field.pattern != null) {
        try {
          schema = schema.check(Schema.isPattern(new RegExp(field.pattern)));
        } catch {
          schema = schema.check(
            Schema.makeFilter(() => "Devin supplied an invalid answer pattern."),
          );
        }
      }
      return schema;
    }
    case "number":
    case "integer": {
      let schema = Schema.Number.check(Schema.isFinite());
      if (field.type === "integer") schema = schema.check(Schema.isInt());
      if (field.minimum != null)
        schema = schema.check(Schema.isGreaterThanOrEqualTo(field.minimum));
      if (field.maximum != null) schema = schema.check(Schema.isLessThanOrEqualTo(field.maximum));
      return schema;
    }
    case "boolean":
      return Schema.Boolean;
    case "array": {
      const choices =
        "anyOf" in field.items ? field.items.anyOf.map((option) => option.const) : field.items.enum;
      let schema = Schema.Array(
        Schema.String.check(
          Schema.makeFilter((value) => choices.includes(value) || "Choose an offered value."),
        ),
      );
      if (field.minItems != null) schema = schema.check(Schema.isMinLength(field.minItems));
      if (field.maxItems != null) schema = schema.check(Schema.isMaxLength(field.maxItems));
      return schema;
    }
  }
}

/** Compile the requested field constraints once; invalid answers can be corrected in the same form. */
export function makeDevinAnswerParser(request: Form) {
  const fields = Object.entries(request.requestedSchema.properties ?? {}).map(([id, field]) => ({
    id,
    field,
    required: request.requestedSchema.required?.includes(id) === true,
    decode: Schema.decodeUnknownResult(answerSchema(field)),
  }));
  return (answers: ProviderUserInputAnswers): Result.Result<ElicitationResponse, string> => {
    // Empty answers are the shared client/provider cancellation signal.
    if (Object.keys(answers).length === 0) return Result.succeed({ action: { action: "cancel" } });
    const content: Record<string, ElicitationContentValue> = {};
    for (const { id, field, required, decode } of fields) {
      let value = answers[id];
      const label = field.title?.trim() || id;
      if (value === undefined || value === "") {
        if (required) return Result.fail(`${label}: an answer is required.`);
        continue;
      }
      if (
        (field.type === "number" || field.type === "integer") &&
        typeof value === "string" &&
        value.trim() !== ""
      )
        value = Number(value);
      if (field.type === "boolean" && (value === "true" || value === "false"))
        value = value === "true";
      const result = decode(value);
      if (Result.isFailure(result)) return Result.fail(`${label}: ${result.failure.message}`);
      content[id] = result.success;
    }
    return Result.succeed({ action: { action: "accept", content } });
  };
}
