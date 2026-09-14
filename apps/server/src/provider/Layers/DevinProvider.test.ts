// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";

import {
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  parseDevinAuthStatusOutput,
  parseDevinModelsJsonOutput,
} from "./DevinProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_AUTH_OUTPUT = [
  "Logged in (via Devin).",
  "",
  "Credentials:",
  "  File:              /home/user/.local/share/devin/credentials.toml",
  "",
].join("\n");

const LOGGED_OUT_AUTH_OUTPUT = [
  "Not logged in.",
  "  Credentials path: /home/user/.local/share/devin/credentials.toml",
  "Run `devin auth login` to authenticate.",
  "",
].join("\n");

// Reduced but faithful slice of `devin models list --format json`.
const MODELS_JSON_OUTPUT = JSON.stringify({
  families: [
    {
      family_label: "SWE-2",
      family_uid: "swe-2",
      slug: "swe-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High" },
        { model_uid: "swe-2-medium", label: "SWE-2 Medium" },
      ],
    },
    {
      family_label: "Adaptive",
      family_uid: "Adaptive",
      slug: "Adaptive",
      variants: [{ model_uid: "adaptive", label: "Adaptive" }],
    },
  ],
});

describe("parseDevinAuthStatusOutput", () => {
  it("detects a logged-in CLI", () => {
    expect(parseDevinAuthStatusOutput(LOGGED_IN_AUTH_OUTPUT)).toBe(true);
  });

  it("detects a logged-out CLI even though it exits 0", () => {
    expect(parseDevinAuthStatusOutput(LOGGED_OUT_AUTH_OUTPUT)).toBe(false);
  });

  it("returns unknown for unrecognized output", () => {
    expect(parseDevinAuthStatusOutput("devin 3000.10.21\n")).toBeNull();
  });
});

describe("parseDevinModelsJsonOutput", () => {
  it("flattens family variants into discovered models and marks adaptive default", () => {
    const models = parseDevinModelsJsonOutput(MODELS_JSON_OUTPUT);
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["swe-2-high", "SWE-2 High", false],
      ["swe-2-medium", "SWE-2 Medium", false],
      ["adaptive", "Adaptive", true],
    ]);
    expect(models.every((model) => !model.isCustom)).toBe(true);
  });

  it("dedupes repeated model ids and falls back to the slug for a missing label", () => {
    const models = parseDevinModelsJsonOutput(
      JSON.stringify({
        families: [
          { family_uid: "a", variants: [{ model_uid: "m-1" }] },
          { family_uid: "b", variants: [{ model_uid: "m-1" }, { model_uid: "m-2" }] },
        ],
      }),
    );
    expect(models.map((model) => model.slug)).toEqual(["m-1", "m-2"]);
    expect(models[0]?.name).toBe("m-1");
  });

  it("returns an empty catalog for invalid JSON or a missing families key", () => {
    expect(parseDevinModelsJsonOutput("not json")).toEqual([]);
    expect(parseDevinModelsJsonOutput("{}")).toEqual([]);
  });
});

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
      // Devin cannot rewind a native session — clients must not offer it
      // even while the provider is disabled.
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );

  it.effect("returns a disabled snapshot by default — Devin is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Devin");
      expect(snapshot.badgeLabel).toBe("Early Access");
    }),
  );
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken devin install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-version-" });
          const devinPath = writeFakeCli({
            directory: dir,
            name: "devin",
            source: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `process.stderr.write(${JSON.stringify(`${secretStderr}\n`)});`,
              "process.exit(2);",
              "",
            ].join("\n"),
          });

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Devin CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  // A stand-in for the Devin CLI: `--version`, `auth status`, and
  // `models list --format json` print canned output, and `acp` execs the
  // mock ACP agent so `initialize` completes a real handshake.
  const writeFakeDevinCli = (input: {
    readonly authOutput: string;
    readonly modelsOutput?: string | undefined;
    readonly acp: boolean;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-probe-" });
      const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
      return writeFakeCli({
        directory: dir,
        name: "devin",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("devin 3000.10.21 (611c1cba)\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "auth" && process.argv[3] === "status") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(`${input.authOutput}\n`)});`,
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "models") {',
          ...(input.modelsOutput === undefined
            ? ["  process.exit(4);"]
            : [
                // @effect-diagnostics-next-line preferSchemaOverJson:off
                `  process.stdout.write(${JSON.stringify(`${input.modelsOutput}\n`)});`,
                "  process.exit(0);",
              ]),
          "}",
          'if (process.argv[2] !== "acp") process.exit(1);',
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      });
    });

  it.effect("reports unauthenticated from `devin auth status` without probing ACP", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_OUT_AUTH_OUTPUT,
            modelsOutput: MODELS_JSON_OUTPUT,
            acp: true,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("devin auth login");
      expect(snapshot.version).toBe("3000.10.21");
    }),
  );

  it.effect("reports ready with discovered models when logged in and ACP initializes", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_AUTH_OUTPUT,
            modelsOutput: MODELS_JSON_OUTPUT,
            acp: true,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("3000.10.21");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Devin account",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "swe-2-high",
        "swe-2-medium",
        "adaptive",
      ]);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );

  // Client-facing snapshots must not carry host-local detail: the configured
  // binary path and any ACP transport state stay server-side, and the resume
  // cursor is an opaque id-only cursor. Settings clients may see the binary
  // path through the settings contract like every other provider.
  it.effect("does not embed the configured binary path in the provider snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const devinPath = yield* writeFakeDevinCli({
          authOutput: LOGGED_IN_AUTH_OUTPUT,
          modelsOutput: MODELS_JSON_OUTPUT,
          acp: true,
        });
        const snapshot = yield* checkDevinProviderStatus(
          decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
        );
        expect(snapshot.status).toBe("ready");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.stringify(snapshot)).not.toContain(devinPath);
      }),
    ),
  );

  it.effect("fails when `devin acp` cannot initialize even though auth is fine", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_AUTH_OUTPUT,
            modelsOutput: MODELS_JSON_OUTPUT,
            acp: false,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.message).toContain("devin acp");
    }),
  );

  it.effect("degrades to a warning when model discovery fails on a healthy CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: LOGGED_IN_AUTH_OUTPUT,
            modelsOutput: undefined,
            acp: true,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.message).toContain("model discovery failed");
      expect(snapshot.models).toEqual([]);
    }),
  );

  it.effect("still reports ready when auth status is unparseable but ACP works", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const devinPath = yield* writeFakeDevinCli({
            authOutput: "unexpected output",
            modelsOutput: MODELS_JSON_OUTPUT,
            acp: true,
          });
          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );
});
