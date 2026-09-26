import { describe, expect, it } from "vite-plus/test";
import type { ElicitationRequest } from "effect-acp/schema";
import { devinAnswers, devinQuestions } from "./DevinUserInput.ts";

const form = {
  sessionId: "session",
  mode: "form",
  message: "Configure the deployment",
  requestedSchema: {
    type: "object",
    required: ["region", "replicas", "confirm"],
    properties: {
      region: { type: "string", oneOf: [{ const: "us-east", title: "US East" }] },
      replicas: { type: "integer", title: "Replicas" },
      confirm: { type: "boolean" },
      services: { type: "array", items: { type: "string", enum: ["web", "api"] } },
      notes: { type: "string" },
    },
  },
} satisfies ElicitationRequest;

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
      devinAnswers(form, {
        region: "us-east",
        replicas: "3",
        confirm: "false",
        services: ["web", "api"],
      }),
    ).toEqual({
      action: {
        action: "accept",
        content: { region: "us-east", replicas: 3, confirm: false, services: ["web", "api"] },
      },
    });
  });

  it("cancels empty, incomplete, or malformed answers", () => {
    for (const answers of [
      {},
      { region: "us-east" },
      { region: "us-east", replicas: "1.5", confirm: "true" },
      { region: "us-east", replicas: "NaN", confirm: "true" },
    ]) {
      expect(devinAnswers(form, answers)).toEqual({ action: { action: "cancel" } });
    }
  });
});
