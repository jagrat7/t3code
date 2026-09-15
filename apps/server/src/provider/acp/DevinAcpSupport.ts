/**
 * Devin ACP launch support.
 *
 * `devin acp` runs the Devin CLI as an Agent Client Protocol server over
 * stdio. The ACP server self-authenticates from stored CLI credentials
 * (`devin auth login`); answering `authenticate` with the advertised
 * `devin-browser` method launches an interactive PKCE browser flow even
 * when credentials exist, so no `authMethodId` is passed and the request
 * is never sent. Sign-in stays owned by `devin auth login` — T3 Code
 * never opens a browser or collects API keys for Devin.
 */
import { type DevinSettings, ModelSelection } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { DevinModelCatalog, resolveDevinModel } from "./DevinModels.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    ...(environment !== undefined ? { env: environment } : {}),
  };
}

const decodeDevinModelCatalog = Schema.decodeEffect(DevinModelCatalog);
const isAcpError = Schema.is(EffectAcpErrors.AcpError);
const sameSelection = Schema.toEquivalence(ModelSelection);

/** Use the same executable and environment for health checks and actual sessions. */
export const runDevinCommand = Effect.fn("runDevinCommand")(function* (
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const command = devinSettings?.binaryPath || "devin";
  const resolved = yield* resolveSpawnCommand(
    command,
    args,
    environment === undefined ? {} : { env: environment },
  );
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(resolved.command, resolved.args, {
      ...(environment === undefined ? {} : { env: environment }),
      shell: resolved.shell,
      ...(cwd !== undefined ? { cwd } : {}),
    }),
  );
});

/** This command waits for fresh account models; ACP initially returns its disk cache. */
const readDevinModelCatalog = Effect.fn("readDevinModelCatalog")(function* (
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  environment: NodeJS.ProcessEnv | undefined,
) {
  const result = yield* runDevinCommand(devinSettings, environment, [
    "models",
    "list",
    "--format",
    "json",
  ]);
  if (result.code !== 0) {
    return yield* EffectAcpErrors.AcpRequestError.internalError(
      "Devin CLI could not list available models. Run `devin models list` on this environment.",
    );
  }
  return yield* decodeDevinModelCatalog(result.stdout).pipe(
    Effect.mapError(() =>
      EffectAcpErrors.AcpRequestError.internalError(
        "Devin CLI returned an unrecognized model catalog.",
      ),
    ),
  );
});

export type DevinAcpRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"] & {
  /**
   * Applies a model selection (family slug plus option choices) by resolving
   * it against this account's live `devin models list` catalog to the exact
   * `model_uid` Devin advertises. Returns the applied model id, or the
   * session's current model when no selection is given.
   */
  readonly applyModel: (
    selection?: ModelSelection,
  ) => Effect.Effect<string | undefined, EffectAcpErrors.AcpError>;
};

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<DevinAcpRuntime, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        // ACP's cached model choices can omit valid Fusion IDs indefinitely.
        // The fresh CLI catalog resolves selections; Devin's setter remains
        // authoritative for availability.
        modelValidation: "agent",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );

    const getCatalog = readDevinModelCatalog(input.devinSettings, input.environment).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      Effect.timeout("10 seconds"),
      Effect.mapError((cause): EffectAcpErrors.AcpError =>
        cause._tag === "TimeoutError"
          ? EffectAcpErrors.AcpRequestError.internalError(
              "Devin CLI timed out listing models. Run `devin models list` on this environment.",
            )
          : isAcpError(cause)
            ? cause
            : EffectAcpErrors.AcpRequestError.internalError(
                `Devin CLI could not list available models (${cause._tag}). Run \`devin models list\` on this environment.`,
              ),
      ),
    );
    const setModel = (modelId: string) =>
      runtime.start().pipe(
        Effect.andThen(runtime.setModel(modelId)),
        Effect.mapError((cause) =>
          cause.message.includes("Could not determine pairing")
            ? EffectAcpErrors.AcpRequestError.invalidParams(
                "Devin CLI could not resolve this Fusion pairing. Update the configured Devin CLI, then start a new thread to use the updated runtime.",
              )
            : cause,
        ),
      );
    let previousSelection: ModelSelection | undefined;
    let previousModel: string | undefined;
    return {
      ...runtime,
      setModel,
      applyModel: Effect.fn("DevinAcpRuntime.applyModel")(function* (selection?: ModelSelection) {
        const config = (yield* runtime.getConfigOptions).find((option) => option.id === "model");
        const current = config?.type === "select" ? config.currentValue : undefined;
        if (!selection) return current;
        if (
          previousSelection &&
          sameSelection(selection, previousSelection) &&
          current === previousModel
        )
          return current;
        const model = resolveDevinModel(yield* getCatalog, selection);
        if (!model)
          return yield* EffectAcpErrors.AcpRequestError.invalidParams(
            `Devin does not offer the selected thinking, speed, and context combination for ${selection.model}. Refresh provider status and choose an available combination.`,
          );
        if (model !== current) yield* setModel(model);
        previousSelection = selection;
        previousModel = model;
        return model;
      }),
    };
  });
