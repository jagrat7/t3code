import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const instanceId = ProviderInstanceId.make("codex");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "session-1",
  providerInstanceId: instanceId,
  capabilities: new Set(["threads"]),
  issuedAt: 1,
};

const runningThread: OrchestrationThreadShell = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: {
    threadId,
    status: "running",
    providerName: "codex",
    providerInstanceId: instanceId,
    runtimeMode: "full-access",
    activeTurnId: turnId,
    lastError: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  latestUserMessageAt: "2026-09-01T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  thread: OrchestrationThreadShell | null = runningThread,
) {
  const requests = yield* Ref.make<ReadonlyArray<{ threadId: ThreadId; turnId: TurnId }>>([]);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(id === threadId ? Option.fromNullishOr(thread) : Option.none()),
    }),
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      requestSettleAfterTurn: (id, turn) =>
        Ref.update(requests, (entries) => [...entries, { threadId: id, turnId: turn }]),
    }),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (scope: McpInvocationContext.McpInvocationScope = invocation) =>
    toolkit.handle("settle_thread", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(dependencies),
    );
  return { requests, call };
});

describe("settle thread toolkit", () => {
  it.effect("schedules settlement for the calling agent's active turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call()).toEqual({ scheduled: true });
      expect(yield* Ref.get(harness.requests)).toEqual([{ threadId, turnId }]);
    }),
  );

  it.effect("rejects missing capability and an idle or mismatched session", () =>
    Effect.gen(function* () {
      const denied = yield* makeHarness();
      const capabilityError = yield* denied
        .call({ ...invocation, capabilities: new Set() })
        .pipe(Effect.flip);
      expect(capabilityError).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "threads",
      });
      expect(yield* Ref.get(denied.requests)).toEqual([]);

      for (const thread of [
        { ...runningThread, session: { ...runningThread.session!, status: "ready" as const } },
        {
          ...runningThread,
          session: {
            ...runningThread.session!,
            providerInstanceId: ProviderInstanceId.make("claude"),
          },
        },
        { ...runningThread, archivedAt: "2026-09-01T00:00:00.000Z" },
      ]) {
        const harness = yield* makeHarness(thread);
        const error = yield* harness.call().pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ThreadSettleUnavailableError" });
        expect(yield* Ref.get(harness.requests)).toEqual([]);
      }
    }),
  );
});
