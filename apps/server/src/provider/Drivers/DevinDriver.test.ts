import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";
import { expect } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { devinTestSkills, makeDevinCli } from "../testUtils/devinCli.ts";
import { DevinDriver, UPDATE } from "./DevinDriver.ts";
import type { ProviderMaintenanceResolutionContext } from "../providerMaintenance.ts";

const INSTALLED_CONTEXT: ProviderMaintenanceResolutionContext = {
  binaryPath: "devin",
  resolvedCommandPath: "/usr/local/bin/devin",
  realCommandPath: "/usr/local/bin/devin",
  env: {},
  platform: "linux",
};

it.layer(NodeServices.layer)("DevinDriver maintenance", (it) => {
  it.effect("updates an installed Devin CLI through `devin update`", () =>
    Effect.gen(function* () {
      const capabilities = yield* UPDATE.resolve(INSTALLED_CONTEXT);
      expect(capabilities.provider).toBe("devin");
      expect(capabilities.packageName).toBeNull();
      expect(capabilities.update).toMatchObject({
        executable: "/usr/local/bin/devin",
        args: ["update"],
        lockKey: "devin",
      });
    }),
  );

  it.effect("stays manual-only when no Devin executable resolves", () =>
    Effect.gen(function* () {
      const capabilities = yield* UPDATE.resolve(null);
      expect(capabilities.provider).toBe("devin");
      // No executable means nothing to update — T3 never installs the CLI.
      expect(capabilities.update).toBeNull();
    }),
  );
});

const driverTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-devin-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

it.layer(driverTestLayer)("DevinDriver workspace snapshots", (it) => {
  it.effect("discovers workspace skills through the CLI for an authenticated instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* makeDevinCli({ T3_DEVIN_AUTH_STATUS: "Logged in (via Devin).\n" });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-workspace-" });
        // The fake CLI reads its catalog from `devin-test-skills.json` in the
        // spawn cwd, matching how the real CLI scopes skills to the workspace.
        yield* fs.writeFileString(path.join(workspace, "devin-test-skills.json"), devinTestSkills);

        const instance = yield* DevinDriver.create({
          instanceId: ProviderInstanceId.make("devin"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: cli.settings,
        });
        yield* instance.snapshot.refresh;

        const scoped = yield* instance.snapshotForCwd!(workspace);
        expect(scoped.skills.map((skill) => skill.name)).toEqual([
          "broken",
          "internal",
          "visual-check",
        ]);
        const check = scoped.skills.find((skill) => skill.name === "visual-check");
        expect(check).toMatchObject({
          enabled: true,
          userInvocable: true,
          userInvocationOnly: true,
          displayName: "Visual check",
        });
      }),
    ),
  );

  it.effect("does not run the skills probe for a disabled instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* makeDevinCli({ T3_DEVIN_AUTH_STATUS: "Logged in (via Devin).\n" });
        const instance = yield* DevinDriver.create({
          instanceId: ProviderInstanceId.make("devin"),
          displayName: undefined,
          environment: [],
          enabled: false,
          config: cli.settings,
        });
        const scoped = yield* instance.snapshotForCwd!(process.cwd());
        expect(scoped.skills).toEqual([]);
      }),
    ),
  );
});
