import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { UPDATE } from "./DevinDriver.ts";
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
