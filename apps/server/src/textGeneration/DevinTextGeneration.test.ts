// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { DevinSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeDevinTextGeneration } from "./DevinTextGeneration.ts";
import { execScriptSource, writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const DevinTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpDevinWrapper(dir: string, env: Record<string, string>): string {
  return writeFakeCli({
    directory: NodePath.join(dir, "bin"),
    name: "devin",
    env,
    source: [
      // `applyModel` resolves selections against `devin models list` before
      // the ACP session is asked to switch. The fake CLI answers from
      // `T3_DEVIN_MODELS_JSON` or one family per `T3_ACP_MODEL_IDS` entry.
      'if (process.argv[2] === "models") {',
      "  const catalog = process.env.T3_DEVIN_MODELS_JSON ?? JSON.stringify({",
      '    families: (process.env.T3_ACP_MODEL_IDS ?? "adaptive")',
      '      .split(",")',
      "      .filter(Boolean)",
      "      .map((id) => ({",
      "        slug: id,",
      "        family_label: id,",
      "        variants: [{ model_uid: id, label: id }],",
      "      })),",
      "  });",
      '  process.stdout.write(catalog + "\\n");',
      "  process.exit(0);",
      "}",
      execScriptSource({
        scriptPath: mockAgentPath,
        expectedArgs: ["acp"],
      }),
    ].join("\n"),
  });
}

function withFakeAcpDevin<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpDevinWrapper(tempDir, env);
    const config = decodeDevinSettings({ binaryPath });
    const textGeneration = yield* makeDevinTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(DevinTextGenerationTestLayer)("DevinTextGeneration", (it) => {
  it.effect("uses ACP with disabled tool capabilities and forwards the requested model", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpDevin(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Devin provider",
          body: "Wire up the ACP runtime and headless text generation path.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/devin",
            stagedSummary: "M apps/server/src/provider/Drivers/DevinDriver.ts",
            stagedPatch: "diff --git a/.../DevinDriver.ts b/.../DevinDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "composer-2"),
          });

          expect(generated.subject).toBe("Add Devin provider");
          expect(generated.body).toBe("Wire up the ACP runtime and headless text generation path.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "composer-2",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("switches a non-read-only session into ask mode before prompting", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpDevin(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_MODE_IDS: "code,ask",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Read-only mode" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "prove the safe mode wins",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "default"),
          });

          const requests = readJsonRpcRequests(requestLogPath);
          const modeIndex = requests.findIndex(
            (request) =>
              request.method === "session/set_config_option" &&
              request.params?.configId === "mode" &&
              request.params?.value === "ask",
          );
          const promptIndex = requests.findIndex((request) => request.method === "session/prompt");
          expect(modeIndex).toBeGreaterThanOrEqual(0);
          expect(promptIndex).toBeGreaterThan(modeIndex);
        }),
    );
  });

  it.effect("fails with TextGenerationError when no read-only mode is advertised", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-devin-text-log-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpDevin(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_MODE_IDS: "code",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "never reached" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "default"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("read-only");
          expect(
            readJsonRpcRequests(requestLogPath).some(
              (request) => request.method === "session/prompt",
            ),
          ).toBe(false);
        }),
    );
  });

  it.effect("extracts the JSON object when Devin wraps it in conversational text", () =>
    withFakeAcpDevin(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "default"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("surfaces an unadvertised model selection as a text generation error", () =>
    withFakeAcpDevin(
      {
        // Agent-side validation: the account only advertises `adaptive`.
        T3_ACP_MODEL_IDS: "adaptive",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up devin",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("devin"),
                "missing-devin-model",
              ),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("Devin ACP model");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpDevin(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "default"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeAcpDevin(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "feat(devin): wire up text generation",
          body: "## Summary\n- Add the shared ACP text-generation path for Devin.\n- Apply the selected model through `session/set_config_option`.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/devin-provider",
            commitSummary: "feat: add devin provider",
            diffSummary: "M apps/server/src/provider/Drivers/DevinDriver.ts",
            diffPatch: "diff --git a/.../DevinDriver.ts b/.../DevinDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "default"),
          });

          expect(generated.title).toBe("feat(devin): wire up text generation");
          expect(generated.body).toContain("`session/set_config_option`");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAcpDevin(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("devin"), "default"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );
});
