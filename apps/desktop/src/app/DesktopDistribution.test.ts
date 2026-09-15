import { assert, describe, it } from "@effect/vitest";

import {
  resolveDesktopDistribution,
  resolveDesktopDistributionIdentity,
} from "./DesktopDistribution.ts";

describe("DesktopDistribution", () => {
  it("defaults unknown builds to the official identity", () => {
    assert.equal(resolveDesktopDistribution(undefined), "official");
    assert.equal(resolveDesktopDistribution("other"), "official");
  });

  it("uses non-overlapping identifiers for the Devin distribution", () => {
    const identity = resolveDesktopDistributionIdentity("devin", false);

    assert.equal(identity.displayName, "t3code+devin");
    assert.equal(identity.appId, "io.github.jagrat7.t3codedevin");
    assert.equal(identity.protocolScheme, "t3code-devin");
    assert.equal(identity.userDataDirName, "t3code-devin");
    assert.equal(identity.integrationDirectoryName, "t3code-devin");
    assert.equal(identity.gnomeCaptureUuid, "snap-shot@t3code-devin.local");
  });
});
