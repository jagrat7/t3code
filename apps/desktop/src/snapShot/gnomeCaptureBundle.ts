import bundle from "../../gnome-extension/bundle.json" with { type: "json" };
import {
  currentDesktopDistribution,
  resolveDesktopDistributionIdentity,
  type DesktopDistribution,
} from "../app/DesktopDistribution.ts";

export const resolveGnomeCaptureUuid = (
  distribution: DesktopDistribution = currentDesktopDistribution(),
): string =>
  distribution === "official"
    ? bundle.uuid
    : resolveDesktopDistributionIdentity(distribution, false).gnomeCaptureUuid;
export const GNOME_CAPTURE_UUID = resolveGnomeCaptureUuid();
export const GNOME_CAPTURE_FILES = bundle.files;
