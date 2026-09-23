import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export class ThreadSettleUnavailableError extends Schema.TaggedError<ThreadSettleUnavailableError>()(
  "ThreadSettleUnavailableError",
  {},
) {
  override get message(): string {
    return "This agent has no active turn to settle. Try again while its turn is running.";
  }
}

export class ThreadSettleFailedError extends Schema.TaggedError<ThreadSettleFailedError>()(
  "ThreadSettleFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not request thread settlement.";
  }
}

export const ThreadSettleToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ThreadSettleUnavailableError,
  ThreadSettleFailedError,
]);

export const SettleThreadResult = Schema.Struct({
  scheduled: Schema.Boolean,
});

const SettleThreadTool = Tool.make("settle_thread", {
  description:
    "Settle this T3 Code thread when the current agent turn finishes successfully. This moves it to the Settled section without deleting the conversation. A new turn can make it active again. Call this after finishing the requested work; the current turn is allowed to complete before settlement.",
  success: SettleThreadResult,
  failure: ThreadSettleToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    McpSessionRegistry.McpSessionRegistry,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "Settle thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(SettleThreadTool);
