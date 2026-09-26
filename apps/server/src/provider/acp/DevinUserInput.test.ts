import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import type { ProviderUserInputAnswers } from "@t3tools/contracts";
import type { ElicitationRequest } from "effect-acp/schema";
import { makeDevinAnswerParser, devinQuestions } from "./DevinUserInput.ts";

const form = {
  sessionId: "session",
  mode: "form",
  message: "Configure the deployment",
  requestedSchema: {
    type: "object",
    required: ["region", "replicas", "confirm"],
    properties: {
      region: { type: "string", oneOf: [{ const: "us-east", title: "US East" }] },
      replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 5 },
      confirm: { type: "boolean" },
      services: {
        type: "array",
        items: { type: "string", enum: ["web", "api"] },
        minItems: 1,
        maxItems: 2,
      },
      notes: { type: "string" },
    },
  },
} satisfies ElicitationRequest;

const parseAnswers = makeDevinAnswerParser(form);
const validAnswers = { region: "us-east", replicas: "3", confirm: "false" };

describe("Devin structured questions", () => {
  it("preserves wire values while displaying human-readable choices", () => {
    const questions = devinQuestions(form);
    expect(questions[0]).toMatchObject({
      options: [{ label: "US East", value: "us-east" }],
      allowCustomAnswer: false,
    });
    expect(questions[1]).toMatchObject({ question: "Replicas", allowCustomAnswer: true });
    expect(questions[2]?.options.map((option) => option.value)).toEqual(["true", "false"]);
    expect(questions[3]).toMatchObject({ multiSelect: true });
  });

  it("converts client text answers to ACP primitives and keeps multiple selections", () => {
    expect(
      parseAnswers({
        region: "us-east",
        replicas: "3",
        confirm: "false",
        services: ["web", "api"],
      }),
    ).toEqual(
      Result.succeed({
        action: {
          action: "accept",
          content: { region: "us-east", replicas: 3, confirm: false, services: ["web", "api"] },
        },
      }),
    );
  });

  it("treats empty answers as cancellation", () => {
    expect(parseAnswers({})).toEqual(Result.succeed({ action: { action: "cancel" } }));
  });

  const invalidAnswers: ReadonlyArray<readonly [string, ProviderUserInputAnswers]> = [
    ["missing required field", { region: "us-east" }],
    ["empty required field", { ...validAnswers, replicas: "" }],
    ["fractional integer", { ...validAnswers, replicas: "1.5" }],
    ["nonfinite number", { ...validAnswers, replicas: "Infinity" }],
    ["invalid number", { ...validAnswers, replicas: "NaN" }],
    ["blank numeric input", { ...validAnswers, replicas: "  " }],
    ["below minimum", { ...validAnswers, replicas: 0 }],
    ["above maximum", { ...validAnswers, replicas: "100" }],
    ["unoffered titled choice", { ...validAnswers, region: "other" }],
    ["wrong boolean type", { ...validAnswers, confirm: 0 }],
    ["too few selections", { ...validAnswers, services: [] }],
    ["too many selections", { ...validAnswers, services: ["web", "api", "web"] }],
    ["unoffered selection", { ...validAnswers, services: ["worker"] }],
    ["wrong selection type", { ...validAnswers, services: [true] }],
  ];
  it.each(invalidAnswers)("rejects %s", (_label, answers) => {
    expect(Result.isFailure(parseAnswers(answers))).toBe(true);
  });

  it("names the invalid field and accepts corrected answers and inclusive limits", () => {
    const invalid = parseAnswers({ ...validAnswers, replicas: "100" });
    expect(Result.isFailure(invalid) && invalid.failure.startsWith("Replicas:")).toBe(true);
    for (const replicas of ["1", 5]) {
      expect(Result.isSuccess(parseAnswers({ ...validAnswers, replicas, notes: "" }))).toBe(true);
    }
  });

  it("enforces untitled choices, titled multi-selects, and decimal bounds", () => {
    const parse = makeDevinAnswerParser({
      ...form,
      requestedSchema: {
        properties: {
          region: { type: "string", enum: ["us", "eu"] },
          services: {
            type: "array",
            items: { anyOf: [{ const: "api", title: "API" }] },
            minItems: 1,
            maxItems: 1,
          },
          ratio: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    });
    expect(parse({ region: "us", services: ["api"], ratio: "0.5" })).toEqual(
      Result.succeed({
        action: { action: "accept", content: { region: "us", services: ["api"], ratio: 0.5 } },
      }),
    );
    for (const answer of [
      { region: "asia" },
      { services: ["web"] },
      { ratio: 1.01 },
      { ratio: -0.1 },
    ]) {
      expect(Result.isFailure(parse(answer))).toBe(true);
    }
  });

  it("enforces text lengths and patterns without trimming valid text", () => {
    const parse = makeDevinAnswerParser({
      ...form,
      requestedSchema: {
        properties: {
          code: { type: "string", minLength: 2, maxLength: 4, pattern: "^[A-Z]+$" },
          notes: { type: "string" },
        },
      },
    });
    expect(parse({ code: "OK", notes: " keep spaces " })).toEqual(
      Result.succeed({
        action: { action: "accept", content: { code: "OK", notes: " keep spaces " } },
      }),
    );
    for (const code of ["A", "ABCDE", "ab"]) expect(Result.isFailure(parse({ code }))).toBe(true);
  });

  it("does not crash when the agent supplies an invalid pattern", () => {
    const parse = makeDevinAnswerParser({
      ...form,
      requestedSchema: { properties: { code: { type: "string", pattern: "[" } } },
    });
    expect(Result.isFailure(parse({ code: "anything" }))).toBe(true);
  });
});
