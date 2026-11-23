import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { nextQueuedRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const delegatedCompletion = {
  generation: 1,
  parentRunId: "run:parent",
  taskIds: ["task:child"],
};

describe("queued run delivery order", () => {
  it("delivers completions and queued messages in request order, keeping manual queue order", () => {
    const projection = {
      messages: [
        { id: "message:old" },
        { id: "message:moved" },
        { id: "message:earlier-completion", delegatedCompletion },
        { id: "message:later-completion", delegatedCompletion },
      ],
      runs: [
        {
          id: "run:old",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:old",
        },
        {
          id: "run:moved",
          ordinal: 4,
          queuePosition: 1,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:moved",
        },
        {
          id: "run:earlier-completion",
          ordinal: 2,
          queuePosition: 3,
          requestedAt: at("09:59:00"),
          status: "queued",
          userMessageId: "message:earlier-completion",
        },
        {
          id: "run:later-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:later-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:earlier-completion",
      "run:moved",
      "run:old",
      "run:later-completion",
    ]);
  });

  it("passes a message being edited only for a subagent result", () => {
    const run = (key: string, time: string, extra: object = {}) => ({
      id: `run:${key}`,
      ordinal: 1,
      requestedAt: at(time),
      status: "queued",
      userMessageId: `message:${key}`,
      ...extra,
    });
    const edited = run("edited", "10:00:00", { editHeldUntil: at("10:05:00") });
    const projection = (...runs: ReadonlyArray<object>) =>
      ({
        messages: [
          { id: "message:edited" },
          { id: "message:later" },
          { id: "message:completion", delegatedCompletion },
        ],
        runs,
      }) as never;

    expect(nextQueuedRun(projection(edited, run("later", "10:01:00")))).toBeUndefined();
    expect(nextQueuedRun(projection(edited, run("completion", "10:02:00")))?.id).toBe(
      "run:completion",
    );
  });
});
