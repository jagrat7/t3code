// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";

import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = (value: unknown): string => {
  const result = encodeUnknownJsonStringExit(value);
  return Exit.isSuccess(result) ? result.value : "";
};

type DevinAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

// Test-local service tag so the rest of the file can keep using `yield* DevinAdapter`.
class DevinAdapter extends Context.Service<DevinAdapter, DevinAdapterShape>()(
  "t3/provider/Layers/DevinAdapter.test/DevinAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
// Stopping a session kills the agent with SIGTERM; Windows terminates the
// process instead, so the mock never sees a signal to log.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
async function makeMockAgentWrapper(
  extraEnv?: Record<string, string>,
  options?: { initialDelaySeconds?: number },
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: extraEnv ?? {},
    source: execScriptSource({
      scriptPath: mockAgentPath,
      ...(options?.initialDelaySeconds === undefined
        ? {}
        : { delayMs: Math.round(options.initialDelaySeconds * 1000) }),
    }),
  });
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-probe-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
  });
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFileContent(filePath: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await NodeFSP.readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await NodeTimersPromises.setTimeout(1);
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

function waitForJsonLogMatch(
  filePath: string,
  predicate: (entry: Record<string, unknown>) => boolean,
  attempts = 40,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requests = yield* Effect.promise(() => readJsonLines(filePath));
      if (requests.some(predicate)) {
        return requests;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.promise(() => readJsonLines(filePath));
  });
}

// Tests mutate `ServerSettingsService` mid-flight (e.g. setting
// `providers.devin.binaryPath` to a mock ACP wrapper). The adapter
// captures `devinSettings` once at construction, so without a resolver
// the mutation is invisible — sessions would spawn the constructor's
// (empty) binary path. Wiring `resolveSettings` through
// `ServerSettingsService.getSettings` makes each session read the latest
// snapshot, matching the old "always read live" behavior that these
// tests assumed.
const makeResolveDevinSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.devin),
      Effect.orDie,
    ),
  );
});

const devinAdapterTestLayer = it.layer(
  Layer.effect(
    DevinAdapter,
    Effect.gen(function* () {
      const devinConfig = decodeDevinSettings({});
      const resolveSettings = yield* makeResolveDevinSettings;
      return yield* makeDevinAdapter(devinConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-devin-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

devinAdapterTestLayer("DevinAdapter", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "default" },
      });

      assert.equal(session.provider, "devin");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("never sends authenticate to a CLI-authenticated Devin agent", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-no-auth-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-auth-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // session/new follows authenticate in start order, so once it is
      // logged an authenticate request would already be on the wire.
      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/new",
      );
      assert.isTrue(requests.some((entry) => entry.method === "initialize"));
      assert.isFalse(requests.some((entry) => entry.method === "authenticate"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes a persisted Devin session through session/load", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-resume-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "devin-session-to-resume" },
      });

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/load",
      );
      const loadRequests = requests.filter((entry) => entry.method === "session/load");
      assert.equal(loadRequests.length, 1);
      const params = loadRequests[0]?.params as Record<string, unknown> | undefined;
      assert.equal(params?.sessionId, "devin-session-to-resume");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps app plan mode onto Devin's ACP session mode", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-plan-mode-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-plan-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });

      const isModeUpdate = (entry: Record<string, unknown>) => {
        if (entry.method !== "session/set_config_option") {
          return false;
        }
        const params = entry.params as Record<string, unknown> | undefined;
        return params?.configId === "mode";
      };
      const requests = yield* waitForJsonLogMatch(requestLogPath, isModeUpdate);
      const modeValues = requests
        .filter(isModeUpdate)
        .map((entry) => (entry.params as Record<string, unknown>).value);
      // The mock advertises ask/architect/code; Devin's plan aliases map to
      // "architect" here (real `devin acp` exposes a literal "plan" mode).
      assert.include(modeValues, "architect");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends runtime instructions as a separate prompt block", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-prompt-shape-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-prompt-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "hello devin",
        attachments: [],
      });

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/prompt",
      );
      const promptRequests = requests.filter((entry) => entry.method === "session/prompt");
      assert.deepStrictEqual(
        promptRequests.map(
          (request) => (request.params as Record<string, unknown> | undefined)?.prompt,
        ),
        [
          [
            { type: "text", text: "hello devin" },
            { type: "text", text: buildRuntimeInstructions({ harness: "Devin" }) },
          ],
        ],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a sendTurn while a Devin turn is in flight without reaching ACP", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-no-steer-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-nosteer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      // Keep the first prompt in flight long enough for the second sendTurn
      // to race it.
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_PROMPT_DELAY_MS: "1500" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run 5 commands",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      // Poll until the first prompt is in flight — sendTurn binds the active
      // turn id before prompting. The mock agent runs on the real clock, so
      // each TestClock.adjust just provides the scheduler hops for its stdio
      // responses to land.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = yield* adapter.listSessions();
          const session = sessions.find((entry) => entry.threadId === threadId);
          if (session?.activeTurnId !== undefined) {
            return;
          }
          yield* TestClock.adjust("10 millis");
        }
        throw new Error("Timed out waiting for the first prompt to be in flight.");
      });

      const rejection = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          attachments: [],
        })
        .pipe(Effect.flip);
      assert.equal(rejection._tag, "ProviderAdapterRequestError");

      const firstTurn = yield* Fiber.join(firstTurnFiber);

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/prompt",
      );
      const promptRequests = requests.filter((entry) => entry.method === "session/prompt");
      // The rejected sendTurn never reached ACP.
      assert.equal(promptRequests.length, 1);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      assert.equal(session?.activeTurnId, undefined);
      assert.isDefined(firstTurn.turnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves Devin permission requests in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-full-access-approvals");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-full-access-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "run a tool call",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.isFalse(runtimeEvents.some((event) => event.type === "request.opened"));

      const isSelectedPermissionResponse = (entry: Record<string, unknown>) =>
        !("method" in entry) &&
        typeof entry.result === "object" &&
        entry.result !== null &&
        "outcome" in entry.result &&
        typeof entry.result.outcome === "object" &&
        entry.result.outcome !== null &&
        "outcome" in entry.result.outcome &&
        entry.result.outcome.outcome === "selected";
      const permissionResponses = yield* waitForJsonLogMatch(
        requestLogPath,
        isSelectedPermissionResponse,
      );
      assert.isTrue(permissionResponses.some(isSelectedPermissionResponse));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("leaves Devin permission requests to the user in auto mode", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-auto-approvals");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-auto-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const requestOpened = yield* Deferred.make<ProviderRuntimeEvent>();
      const requestResolved = yield* Deferred.make<ProviderRuntimeEvent>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(requestOpened, event).pipe(Effect.ignore);
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            );
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolved, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "auto",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "run a tool call",
        attachments: [],
      });

      const opened = yield* Deferred.await(requestOpened);
      const resolved = yield* Deferred.await(requestResolved);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(opened.type, "request.opened");
      assert.equal(resolved.type, "request.resolved");
      if (resolved.type === "request.resolved") {
        assert.equal(resolved.payload.decision, "accept");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps supervised mode onto Devin's ask session mode", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-supervised-mode-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-supervised-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      // The mock's session already starts in `ask`, so setMode is a no-op
      // until another mode is applied. A plan turn moves to `architect`,
      // then the next default turn must resolve back to `ask` — never the
      // edit-accepting `code` mode, which would silently approve edits.
      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "now do it",
        attachments: [],
      });

      const isModeUpdate = (entry: Record<string, unknown>) => {
        if (entry.method !== "session/set_config_option") {
          return false;
        }
        const params = entry.params as Record<string, unknown> | undefined;
        return params?.configId === "mode";
      };
      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => isModeUpdate(entry) && (entry.params as Record<string, unknown>).value === "ask",
      );
      const modeValues = requests
        .filter(isModeUpdate)
        .map((entry) => (entry.params as Record<string, unknown>).value);
      assert.include(modeValues, "architect");
      assert.include(modeValues, "ask");
      assert.notInclude(modeValues, "code");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("forwards Devin permission requests to the user in approval-required mode", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-approval-required");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-approval-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const requestOpened = yield* Deferred.make<ProviderRuntimeEvent>();
      const requestResolved = yield* Deferred.make<ProviderRuntimeEvent>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(requestOpened, event).pipe(Effect.ignore);
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            );
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolved, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "run a tool call",
        attachments: [],
      });

      const opened = yield* Deferred.await(requestOpened);
      const resolved = yield* Deferred.await(requestResolved);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(opened.type, "request.opened");
      assert.equal(resolved.type, "request.resolved");
      if (resolved.type === "request.resolved") {
        assert.equal(resolved.payload.decision, "accept");
      }

      const isSelectedPermissionResponse = (entry: Record<string, unknown>) =>
        !("method" in entry) &&
        typeof entry.result === "object" &&
        entry.result !== null &&
        "outcome" in entry.result &&
        typeof entry.result.outcome === "object" &&
        entry.result.outcome !== null &&
        "outcome" in entry.result.outcome &&
        entry.result.outcome.outcome === "selected";
      const permissionResponses = yield* waitForJsonLogMatch(
        requestLogPath,
        isSelectedPermissionResponse,
      );
      assert.isTrue(permissionResponses.some(isSelectedPermissionResponse));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels pending ACP approvals and marks the turn cancelled when interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-cancel-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-cancel-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId && !interrupted) {
            interrupted = true;
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "cancel",
            );
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel this turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.type, "request.resolved");
      if (requestResolved.type === "request.resolved") {
        assert.equal(requestResolved.payload.decision, "cancel");
      }

      assert.equal(turnCompleted.type, "turn.completed");
      if (turnCompleted.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
        assert.equal(turnCompleted.payload.stopReason, "cancelled");
      }

      const isCancelledApprovalResponse = (entry: Record<string, unknown>) =>
        !("method" in entry) &&
        typeof entry.result === "object" &&
        entry.result !== null &&
        "outcome" in entry.result &&
        typeof entry.result.outcome === "object" &&
        entry.result.outcome !== null &&
        "outcome" in entry.result.outcome &&
        entry.result.outcome.outcome === "cancelled";
      const approvalResponses = yield* waitForJsonLogMatch(
        requestLogPath,
        isCancelledApprovalResponse,
      );
      assert.isTrue(approvalResponses.some(isCancelledApprovalResponse));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stopping a session settles pending approval waits", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-stop-pending-approval");
      const approvalRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "request.opened") {
          return Effect.void;
        }
        return Deferred.succeed(approvalRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run a tool call and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(approvalRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("broadcasts runtime events to multiple stream consumers", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-runtime-event-broadcast");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const firstConsumer = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "thread.started"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const secondConsumer = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "thread.started"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstEvents = yield* Fiber.join(firstConsumer);
      const secondEvents = yield* Fiber.join(secondConsumer);
      assert.isTrue(firstEvents.length > 0);
      assert.isTrue(secondEvents.length > 0);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect.skipIf(windowsHost)("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("bad-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("suppresses session/load replay so resumed history is not new activity", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-replay-suppression");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_LOAD_REPLAY: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(
        adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
        (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "devin-session-to-resume" },
      });
      // Run one real turn so any leaked replay would be visible alongside
      // genuine turn events.
      yield* adapter.sendTurn({
        threadId,
        input: "continue after resume",
        attachments: [],
      });

      const serializedEvents = encodeUnknownJsonString(runtimeEvents);
      // The mock replays both `_meta.isReplay`-marked updates (dropped by the
      // runtime) and an unmarked `user_message_chunk` (dropped while the
      // session is still Starting). Neither may surface as new activity.
      assert.isFalse(serializedEvents.includes("replayed assistant text"));
      assert.isFalse(serializedEvents.includes("replay-tool-1"));
      assert.isFalse(serializedEvents.includes('"replay"'));
      assert.isTrue(runtimeEvents.some((event) => event.type === "turn.completed"));

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("drops session updates for foreign session ids", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-foreign-session-updates");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(
        adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
        (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "run a turn while a child session emits",
        attachments: [],
      });

      const serializedEvents = encodeUnknownJsonString(runtimeEvents);
      assert.isFalse(serializedEvents.includes("mock-child-session-1"));
      assert.isFalse(serializedEvents.includes("child before completion"));
      assert.isFalse(serializedEvents.includes("Child-only tool"));
      assert.isTrue(runtimeEvents.some((event) => event.type === "turn.completed"));

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes a persisted session through a fresh adapter after provider restart", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const resolveSettings = yield* makeResolveDevinSettings;
      const threadId = ThreadId.make("devin-restart-resume");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-restart-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const firstSession = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      // A provider restart constructs a brand-new adapter over the same
      // persisted resumeCursor; the resumed session must go through
      // session/load with the recorded Devin session id.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restartedAdapter = yield* makeDevinAdapter(decodeDevinSettings({}), {
            resolveSettings,
          });
          yield* restartedAdapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("devin"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: firstSession.resumeCursor,
          });
        }),
      );

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const loadRequests = requests.filter((entry) => entry.method === "session/load");
      assert.equal(loadRequests.length, 1);
      assert.equal(
        (loadRequests[0]?.params as Record<string, unknown> | undefined)?.sessionId,
        "mock-session-1",
      );
    }),
  );

  it.effect("fails honestly instead of importing a session Devin cannot load", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-unknown-resume");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-fail-load-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_FAIL_LOAD_SESSION: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("devin"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "not-a-t3-session" },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");

      // The failed load must not silently fall back to session/new — an
      // unknown session is an error, not an import or a fresh start.
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "session/load"));
      assert.isFalse(requests.some((entry) => entry.method === "session/new"));
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("starts a fresh session for an unparseable resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-bogus-cursor");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-bogus-cursor-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, arbitrary: "foreign-data" },
      });

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/new",
      );
      assert.isFalse(requests.some((entry) => entry.method === "session/load"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("applies the selected discovered model at session start and on later turns", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-model-selection");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-model-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, {
          T3_ACP_MODEL_IDS: "adaptive,swe-2-high,swe-2-medium",
        }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("devin"),
          model: "swe-2-high",
        },
      });
      assert.equal(session.model, "swe-2-high");

      yield* adapter.sendTurn({
        threadId,
        input: "switch models",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("devin"),
          model: "swe-2-medium",
        },
      });

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "model" &&
          (entry.params as Record<string, unknown> | undefined)?.value === "swe-2-medium",
      );
      const modelValues = requests
        .filter(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "model",
        )
        .map((entry) => (entry.params as Record<string, unknown>).value);
      assert.deepStrictEqual(modelValues, ["swe-2-high", "swe-2-medium"]);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.find((s) => s.threadId === threadId)?.model, "swe-2-medium");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects model selections outside the discovered catalog", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-unknown-model");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-bad-model-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, {
          T3_ACP_MODEL_IDS: "adaptive,swe-2-high",
        }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "use an unknown model",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("devin"),
            model: "not-a-discovered-model",
          },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");

      // The rejected selection must not wedge the session; a default-model
      // turn still runs.
      yield* adapter.sendTurn({
        threadId,
        input: "continue with the default model",
        attachments: [],
      });
      assert.equal(
        (yield* adapter.listSessions()).find((s) => s.threadId === threadId)?.status,
        "ready",
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends image attachments as ACP image parts", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const serverConfig = yield* Effect.service(ServerConfig);
      const threadId = ThreadId.make("devin-image-attachment");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-image-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(serverConfig.attachmentsDir, "img-1.png"), imageBytes),
      );

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_IMAGE_CAPABILITY: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "describe this",
        attachments: [
          {
            type: "image",
            id: "img-1",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.length,
          },
        ],
      });

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/prompt",
      );
      const prompt = (
        requests.find((entry) => entry.method === "session/prompt")?.params as
          | Record<string, unknown>
          | undefined
      )?.prompt as Array<Record<string, unknown>> | undefined;
      assert.deepStrictEqual(prompt?.[0], {
        type: "image",
        data: imageBytes.toString("base64"),
        mimeType: "image/png",
      });
      assert.deepStrictEqual(prompt?.[1], { type: "text", text: "describe this" });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects image attachments when the CLI does not advertise image support", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-image-unsupported");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "describe this",
          attachments: [
            {
              type: "image",
              id: "img-1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.match(error.detail, /does not support image attachments/);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects invalid attachment ids with the existing request error", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-invalid-attachment");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-invalid-att-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_IMAGE_CAPABILITY: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "describe this",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.match(error.detail, /missing-image/);
      }

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((s) => s.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("lets ordinary file attachments ride the prompt path line", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-file-attachment");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-file-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "review this file",
        attachments: [
          {
            type: "file",
            id: "file-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
        ],
      });

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/prompt",
      );
      const prompt = (
        requests.find((entry) => entry.method === "session/prompt")?.params as
          | Record<string, unknown>
          | undefined
      )?.prompt as Array<Record<string, unknown>> | undefined;
      // Generic files are not inlined as ACP parts; ProviderService puts the
      // file path in the prompt text upstream (same as Cursor and Grok).
      assert.isFalse(prompt?.some((part) => part.type !== "text"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("exposes /compact as a slash-command compaction routed as a normal turn", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-compact-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-compact-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      // ProviderService drives compaction through this static capability,
      // sending the command as an ordinary turn (same as Grok's /compact and
      // Cursor's /compress).
      assert.deepStrictEqual(adapter.compaction, {
        type: "slash-command",
        command: "/compact",
      });
      if (adapter.compaction?.type !== "slash-command") {
        throw new Error("Expected slash-command compaction.");
      }

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: adapter.compaction.command,
        attachments: [],
      });

      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/prompt",
      );
      const prompt = (
        requests.find((entry) => entry.method === "session/prompt")?.params as
          | Record<string, unknown>
          | undefined
      )?.prompt as Array<Record<string, unknown>> | undefined;
      assert.deepStrictEqual(prompt?.[0], { type: "text", text: "/compact" });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a compaction turn while a Devin turn is in flight", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-compact-collision");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-compact-collide-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));

      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_PROMPT_DELAY_MS: "1500" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run 5 commands", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = yield* adapter.listSessions();
          const session = sessions.find((entry) => entry.threadId === threadId);
          if (session?.activeTurnId !== undefined) {
            return;
          }
          yield* TestClock.adjust("10 millis");
        }
        throw new Error("Timed out waiting for the first prompt to be in flight.");
      });

      // ProviderService sends compaction through sendTurn, so the active-turn
      // admission gate rejects it before it can reach ACP.
      const rejection = yield* adapter
        .sendTurn({ threadId, input: "/compact", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(rejection._tag, "ProviderAdapterRequestError");

      yield* Fiber.join(firstTurnFiber);
      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/prompt",
      );
      assert.equal(requests.filter((entry) => entry.method === "session/prompt").length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("leaves the session usable after a failed compaction turn", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-compact-failure");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({ threadId, input: "/compact", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not offer conversation rollback Devin cannot honor", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-no-rollback");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      assert.equal(adapter.capabilities.supportsConversationRollback, false);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "remember this", attachments: [] });

      const error = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");

      // The transcript must stay whole: trimming only the adapter's local
      // turn list would desync it from Devin's native session history.
      const thread = yield* adapter.readThread(threadId);
      assert.equal(thread.turns.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles a mid-turn disconnect as a failed turn and an error exit", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-mid-turn-disconnect");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_ON_PROMPT: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnExit = yield* adapter
        .sendTurn({ threadId, input: "die on this prompt", attachments: [] })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(sendTurnExit));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.filter((event) => event.type === "turn.completed");
      // Exactly one settlement — sendTurn's error path and the disconnect
      // stop must not both complete the same turn.
      assert.equal(completed.length, 1);
      if (completed[0]?.type === "turn.completed") {
        assert.equal(completed[0].payload.state, "failed");
      }
      const exited = events.find((event) => event.type === "session.exited");
      assert.isDefined(exited);
      if (exited?.type === "session.exited") {
        assert.equal(exited.payload.exitKind, "error");
        assert.isString(exited.payload.reason);
      }
      // Terminal order is fixed: the turn settles before the session exits.
      assert.isBelow(
        events.findIndex((event) => event.type === "turn.completed"),
        events.findIndex((event) => event.type === "session.exited"),
      );

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("settles an in-flight turn before session.exited when the session is stopped", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-stop-mid-turn-order");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_PROMPT_DELAY_MS: "1500" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "stop me mid-turn", attachments: [] })
        .pipe(Effect.forkChild);

      // Wait for the prompt to be genuinely in flight before stopping.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = yield* adapter.listSessions();
          if (sessions.find((entry) => entry.threadId === threadId)?.activeTurnId !== undefined) {
            return;
          }
          yield* TestClock.adjust("10 millis");
        }
        throw new Error("Timed out waiting for the prompt to be in flight.");
      });

      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.filter((event) => event.type === "turn.completed");
      assert.equal(completed.length, 1);
      if (completed[0]?.type === "turn.completed") {
        assert.equal(completed[0].payload.state, "cancelled");
      }
      assert.isBelow(
        events.findIndex((event) => event.type === "turn.completed"),
        events.findIndex((event) => event.type === "session.exited"),
      );
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("fails startup cleanly when the agent dies during session configuration", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-startup-death");

      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(
        adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
        (event) => Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      // `auto-accept-edits` resolves to the mock's `code` mode, so startup
      // issues `session/set_config_option` — where this mock exits.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EXIT_ON_SET_CONFIG_OPTION: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const error = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("devin"),
          cwd: process.cwd(),
          runtimeMode: "auto-accept-edits",
        })
        .pipe(Effect.flip);
      assert.include(
        [
          "ProviderAdapterRequestError",
          "ProviderAdapterProcessError",
          "ProviderAdapterSessionClosedError",
        ],
        error._tag,
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(eventsFiber);
      assert.isFalse(events.some((event) => event.type === "session.started"));
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("declares the attachment store as a workspace root on session/new", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const threadId = ThreadId.make("devin-attachments-root");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-dirs-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const requests = yield* waitForJsonLogMatch(
        requestLogPath,
        (entry) => entry.method === "session/new",
      );
      const params = requests.find((entry) => entry.method === "session/new")?.params as
        | Record<string, unknown>
        | undefined;
      assert.deepEqual(params?.additionalDirectories, [serverConfig.attachmentsDir]);
      yield* adapter.stopSession(threadId);
    }),
  );
});
