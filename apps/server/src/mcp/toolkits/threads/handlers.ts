import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { ThreadSettleFailedError, ThreadSettleUnavailableError, ThreadsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;

  return ThreadsToolkit.of({
    settle_thread: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("threads");
        const thread = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(Effect.mapError((cause) => new ThreadSettleFailedError({ cause })));
        if (
          Option.isNone(thread) ||
          thread.value.archivedAt !== null ||
          thread.value.session?.status !== "running" ||
          thread.value.session.activeTurnId === null ||
          (thread.value.session.providerInstanceId !== undefined &&
            thread.value.session.providerInstanceId !== scope.providerInstanceId)
        ) {
          return yield* new ThreadSettleUnavailableError({});
        }
        yield* registry.requestSettleAfterTurn(scope.threadId, thread.value.session.activeTurnId);
        return { scheduled: true };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
