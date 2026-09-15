/**
 * DevinAdapter — Devin CLI (`devin acp`) via ACP.
 *
 * Devin sessions expose a negotiated `model` config option; discovered
 * model selections are applied through `session/set_config_option` at
 * start and on each turn. Image attachments are sent as ACP image parts
 * when the CLI advertises `promptCapabilities.image`; generic files
 * reach Devin through the path line ProviderService puts in the prompt,
 * which resolves inside the attachment store declared to `devin acp` as
 * an additional workspace directory.
 * `devin acp` exposes no per-spawn permission flags, so T3
 * runtime modes map onto Devin's session modes through the negotiated
 * `mode` config option and `session/request_permission` forwarding.
 */
import {
  ApprovalRequestId,
  type DevinSettings,
  EventId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { type DevinAcpRuntime, makeDevinAcpRuntime } from "../acp/DevinAcpSupport.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_RESUME_VERSION = 1 as const;
// Devin's ACP session modes (verified against `devin acp` session/new):
// `accept-edits` ("Code"), `smart` ("Smart"), `ask` ("Ask"), `plan`
// ("Plan"), `bypass` ("Bypass Permissions"). The negotiated `mode` config
// option applies them to the active session.
const DEVIN_PLAN_MODE_ALIASES = ["plan", "architect"];
const DEVIN_SUPERVISED_MODE_ALIASES = ["ask", "supervised"];
const DEVIN_IMPLEMENT_MODE_ALIASES = ["accept-edits", "code", "agent", "default"];
const DEVIN_AUTO_MODE_ALIASES = ["smart", "auto"];
const DEVIN_FULL_ACCESS_MODE_ALIASES = ["bypass", "full access", "dangerous"];

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface DevinAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the built-in instance id (`devin`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver, matching CursorAdapter's
   * semantics: production instances bind settings at construction; tests set
   * a resolver so `ServerSettingsService` mutations (e.g. pointing
   * `binaryPath` at a mock ACP agent) take effect on the next session.
   */
  readonly resolveSettings?: Effect.Effect<DevinSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface DevinSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: DevinAcpRuntime;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  readonly supportsImages: boolean;
  /** Last model selection bound to this session; re-applied each turn so a
   * family slug keeps resolving against the live catalog. */
  modelSelection: ModelSelection | undefined;
  /** Set when the ACP transport dies on its own; the stop settles the
   * session as an error exit rather than a graceful one. */
  disconnectReason: string | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDevinResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DEVIN_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], DEVIN_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, DEVIN_PLAN_MODE_ALIASES)?.id;
  }

  switch (input.runtimeMode) {
    case "approval-required":
      // Supervised promises T3 asks before commands and file changes.
      // `accept-edits` would silently approve edits, and no more permissive
      // fallback is honest — only Devin's read-only `ask` mode qualifies.
      // An undefined result fails the turn instead of degrading into a
      // mode that approves work the user never saw.
      return findModeByAliases(modeState.availableModes, DEVIN_SUPERVISED_MODE_ALIASES)?.id;
    case "auto-accept-edits":
      return (
        findModeByAliases(modeState.availableModes, DEVIN_IMPLEMENT_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
    case "auto":
      return (
        findModeByAliases(modeState.availableModes, DEVIN_AUTO_MODE_ALIASES)?.id ??
        findModeByAliases(modeState.availableModes, DEVIN_IMPLEMENT_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    case "full-access":
      return (
        findModeByAliases(modeState.availableModes, DEVIN_FULL_ACCESS_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    default:
      return (
        findModeByAliases(modeState.availableModes, DEVIN_IMPLEMENT_MODE_ALIASES)?.id ??
        modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
        modeState.currentModeId
      );
  }
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: DevinAcpRuntime;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection: ModelSelection | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
  readonly missingModeError: (runtimeMode: RuntimeMode) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const appliedModel =
      input.modelSelection !== undefined
        ? yield* input.runtime.applyModel(input.modelSelection).pipe(
            Effect.mapError((cause) =>
              input.mapError({
                cause,
                method: "session/set_config_option",
              }),
            ),
          )
        : undefined;

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      if (input.interactionMode !== "plan" && input.runtimeMode === "approval-required") {
        return yield* Effect.fail(input.missingModeError(input.runtimeMode));
      }
      return appliedModel;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
    return appliedModel;
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

export function makeDevinAdapter(devinSettings: DevinSettings, options?: DevinAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("devin");
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    // Owns fibers that must outlive an individual session scope — e.g. the
    // disconnect settlement, which closes the session scope it runs from.
    const adapterScope = yield* Scope.Scope;
    const sessions = new Map<ThreadId, DevinSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Devin runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Devin ACP extension event.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: DevinSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DevinSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    // Single-owner turn settlement: emits `turn.completed` at most once for
    // a bound turn, and always while holding the thread lock so a session
    // stop cannot interleave `session.exited` between the ownership claim
    // and the event.
    const finishTurn = (
      ctx: DevinSessionContext,
      turnId: TurnId,
      payload: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"],
    ) =>
      withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          if (ctx.activeTurnId !== turnId) return;
          ctx.activeTurnId = undefined;
          ctx.session = {
            ...ctx.session,
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
          };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
          });
        }),
      );

    // Callers must hold `withThreadLock(ctx.threadId)`: the turn claim and
    // the terminal events below are the stop side of the settlement race
    // described on finishTurn.
    const stopSessionInternal = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        const unsettledTurnId = ctx.activeTurnId;
        ctx.activeTurnId = undefined;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        const disconnectReason = ctx.disconnectReason;
        ctx.session = {
          ...ctx.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };
        if (unsettledTurnId !== undefined) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: unsettledTurnId,
            payload:
              disconnectReason !== undefined
                ? { state: "failed", errorMessage: disconnectReason }
                : { state: "cancelled", stopReason: "cancelled" },
          });
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload:
            disconnectReason !== undefined
              ? { exitKind: "error" as const, reason: disconnectReason }
              : { exitKind: "graceful" as const },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: DevinSessionContext;

          const resumeSessionId = parseDevinResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const effectiveDevinSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : devinSettings;

          const acp = yield* makeDevinAcpRuntime({
            devinSettings: effectiveDevinSettings,
            ...(options?.environment !== undefined ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            // The attachment store lives outside the project cwd. Declaring
            // it as a workspace root keeps the ProviderService path line
            // dereferenceable in Devin modes that restrict filesystem
            // access outside the workspace (same as Antigravity).
            additionalDirectories: [serverConfig.attachmentsDir],
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    params,
                    "acp.jsonrpc",
                  );
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  return {
                    outcome:
                      resolved === "cancel"
                        ? ({ outcome: "cancelled" } as const)
                        : {
                            outcome: "selected" as const,
                            optionId: acpPermissionOutcome(resolved),
                          },
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const devinModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

          const appliedModel = yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: devinModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            missingModeError: (runtimeMode) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/set_mode",
                detail: `Devin does not advertise a session mode that can honor '${runtimeMode}'.`,
              }),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(appliedModel !== undefined ? { model: appliedModel } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DEVIN_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            supportsImages:
              started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
            modelSelection: devinModelSelection,
            disconnectReason: undefined,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                }
                // Drop agent events that arrive after the transport died or
                // the session was stopped.
                if (ctx.stopped || ctx.disconnectReason !== undefined) return;
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "ConnectionTerminated":
                    // Set before the fork so `startSession`'s post-drain
                    // check sees the terminal state deterministically. The
                    // forked stop takes the thread lock like every other
                    // settlement path.
                    ctx.disconnectReason ??=
                      event.error.message || "Devin ACP connection terminated.";
                    yield* withThreadLock(ctx.threadId, stopSessionInternal(ctx)).pipe(
                      Effect.forkIn(adapterScope),
                    );
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Devin runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber, so the
            // consumer outlives `startSession` (same rationale as
            // CursorAdapter).
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Devin ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          // The agent can die between `session/new` and now (e.g. an
          // immediate crash after handshake). Drain queued notifications so
          // a pending ConnectionTerminated is applied, then fail the start
          // instead of reporting a healthy session.
          yield* acp.drainEvents;
          if (ctx.stopped || ctx.disconnectReason !== undefined) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
              cause: new Error(
                ctx.disconnectReason ?? "Devin ACP connection terminated during session startup.",
              ),
            });
          }

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // Devin does not promise safe live steering, so concurrent
        // `session/prompt` calls are not allowed. The admission check and
        // the in-flight count share the thread lock, so two racing sendTurns
        // can never both be admitted; the loser fails fast before anything
        // reaches ACP. Queued mid-turn messages are a later milestone.
        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            if (ctx.promptsInFlight > 0) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail:
                  "Devin is still working on the active turn; wait for it to finish or interrupt it before sending another message.",
              });
            }
            ctx.promptsInFlight += 1;
          }),
        );
        const turnId = TurnId.make(yield* randomUUIDv4);
        let turnStarted = false;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const modelSelection = turnModelSelection ?? ctx.modelSelection;
          const appliedModel = yield* applyRequestedSessionConfiguration({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
            missingModeError: (runtimeMode) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/set_mode",
                detail: `Devin does not advertise a session mode that can honor '${runtimeMode}'.`,
              }),
          });
          // Bind the turn and emit `turn.started` under the thread lock so a
          // concurrent session stop either settles this turn after it is
          // visible, or rejects the start outright — never `turn.started`
          // after `session.exited` or a completed-without-started pair.
          yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              if (ctx.stopped) {
                return yield* new ProviderAdapterSessionClosedError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                });
              }
              ctx.activeTurnId = turnId;
              ctx.lastPlanFingerprint = undefined;
              // `applyModel` resolved the selection to the exact catalog id —
              // that is the model the session is actually running.
              ctx.session = {
                ...ctx.session,
                ...(appliedModel !== undefined ? { model: appliedModel } : {}),
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
              };
              if (turnModelSelection) {
                ctx.modelSelection = turnModelSelection;
              }
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: appliedModel !== undefined ? { model: appliedModel } : {},
              });
              turnStarted = true;
            }),
          );

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          const imageAttachments = (input.attachments ?? []).filter(
            (attachment) => attachment.type === "image",
          );
          if (imageAttachments.length > 0 && !ctx.supportsImages) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: "The installed Devin CLI does not support image attachments.",
            });
          }
          for (const attachment of imageAttachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          const rawPrompt = input.input?.trim() ?? "";
          if (rawPrompt) {
            promptParts.push({ type: "text", text: rawPrompt });
          }
          // Generic files reach Devin through the path line ProviderService
          // puts in the prompt text, matching Cursor and Grok.

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          // ACP has no system-message field; keep runtime context separate from the user's text.
          const result = yield* ctx.acp
            .prompt({
              prompt: [
                ...promptParts,
                {
                  type: "text",
                  text: buildRuntimeInstructions({ harness: "Devin" }),
                },
              ],
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          yield* ctx.acp.drainEvents;

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }

          if (ctx.promptsInFlight === 1) {
            yield* finishTurn(ctx, turnId, {
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason ?? null,
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          // A `turn.started` event was already emitted once the turn id was
          // bound, so any later failure (including the transport dying
          // mid-prompt) must settle the turn unless the session stop already
          // claimed it.
          Effect.tapError((cause) =>
            !turnStarted
              ? Effect.void
              : finishTurn(ctx, turnId, { state: "failed", errorMessage: cause.message }),
          ),
          Effect.onInterrupt(() =>
            !turnStarted
              ? Effect.void
              : Effect.gen(function* () {
                  yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
                  yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
                  yield* Effect.ignore(ctx.acp.cancel);
                  yield* finishTurn(ctx, turnId, {
                    state: "cancelled",
                    stopReason: "cancelled",
                  });
                }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
              if (ctx.promptsInFlight === 0 && ctx.activeTurnId === turnId) {
                ctx.activeTurnId = undefined;
                ctx.session = { ...ctx.session, activeTurnId: undefined };
              }
            }),
          ),
        );
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      _threadId,
      _numTurns,
    ) =>
      // Devin cannot rewind its native session, so trimming only the
      // adapter's in-memory turn list would desync the transcript from the
      // agent's history.
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Devin does not support conversation rewind. Start a new thread instead.",
        }),
      );

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(
        sessions.values(),
        (ctx) => withThreadLock(ctx.threadId, stopSessionInternal(ctx)),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions.values(),
        (ctx) => withThreadLock(ctx.threadId, stopSessionInternal(ctx)),
        { discard: true },
      ).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Devin session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "slash-command", command: "/compact" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
