import {
  type DevinSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeDevinAcpRuntime } from "../acp/DevinAcpSupport.ts";

export const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  // Hidden for now: a later milestone can expose Plan mode through the
  // existing ACP session-mode path once sessions exist.
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `initialize` is a single local round trip, so this is generous even on slow machines.
const DEVIN_ACP_INITIALIZE_TIMEOUT_MS = 8_000;

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

const DevinModelsListOutput = Schema.Struct({
  families: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        family_label: Schema.optionalKey(Schema.String),
        family_uid: Schema.optionalKey(Schema.String),
        slug: Schema.optionalKey(Schema.String),
        variants: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              model_uid: Schema.optionalKey(Schema.String),
              label: Schema.optionalKey(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeDevinModelsListOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(DevinModelsListOutput),
);

/**
 * `devin models list --format json` groups selectable models into families;
 * every variant's `model_uid` is an id `devin acp` accepts. `adaptive` is
 * Devin's own default selection, so it carries the default marker.
 */
export function parseDevinModelsJsonOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const decoded = decodeDevinModelsListOutput(output);
  if (Option.isNone(decoded)) {
    return [];
  }
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const family of decoded.value.families ?? []) {
    for (const variant of family.variants ?? []) {
      const slug = variant.model_uid?.trim();
      if (!slug || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      models.push({
        slug,
        name: variant.label?.trim() || slug,
        isCustom: false,
        ...(slug === "adaptive" ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }
  return models;
}

/**
 * `devin auth status` exits 0 both logged in and out, so the verdict comes
 * from the banner line: "Logged in (via Devin)." vs "Not logged in.".
 */
export function parseDevinAuthStatusOutput(output: string): boolean | null {
  if (/\bnot logged in\b/i.test(output)) return false;
  if (/\blogged in\b/i.test(output)) return true;
  return null;
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Spawns `devin acp` and runs only `initialize`. This never calls
 * `authenticate` or `session/new`, so it cannot open a browser login or
 * write a session into Devin's session store — it only proves the CLI
 * speaks the ACP handshake sessions are built on.
 */
const probeDevinAcpInitialize = (devinSettings: DevinSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    return yield* acp.initialize();
  }).pipe(Effect.scoped);

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  // `devin auth status` reads the CLI's own credential store; sign-in stays
  // owned by `devin auth login`.
  const authResult = yield* runDevinCliCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const authOutput =
    Result.isSuccess(authResult) &&
    Option.isSome(authResult.success) &&
    authResult.success.value.code === 0
      ? `${authResult.success.value.stdout}\n${authResult.success.value.stderr}`
      : undefined;
  const authenticated = authOutput === undefined ? null : parseDevinAuthStatusOutput(authOutput);
  const auth: ServerProviderAuth =
    authenticated === true
      ? { status: "authenticated", type: "cached_token", label: "Devin account" }
      : authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      },
    });
  }

  // Sessions are built on `devin acp`, so a failed initialize is a hard
  // failure rather than a degraded model list.
  const acpExit = yield* probeDevinAcpInitialize(devinSettings, environment).pipe(
    Effect.timeoutOption(DEVIN_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Devin ACP initialize probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message:
          "Devin CLI is installed but `devin acp` failed to initialize, so sessions cannot start.",
      },
    });
  }

  // `devin models list` needs the CLI's login state, so it only runs after
  // the auth verdict. A discovery failure keeps the provider usable with an
  // empty catalog rather than failing the whole probe.
  const modelsResult = yield* runDevinCliCommand(
    devinSettings,
    ["models", "list", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value.stdout
      : undefined;
  const models = modelsOutput === undefined ? [] : parseDevinModelsJsonOutput(modelsOutput);
  if (modelsOutput === undefined) {
    yield* Effect.logWarning("Devin CLI model listing failed or timed out.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    // `/compact` is a documented prompt-level Devin command (added for ACP
    // clients); the adapter wires it as slash-command compaction.
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: modelsOutput === undefined ? "warning" : "ready",
      auth,
      ...(modelsOutput === undefined
        ? { message: "Devin CLI is installed but model discovery failed." }
        : {}),
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );
};
