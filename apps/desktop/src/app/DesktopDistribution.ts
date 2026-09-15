export type DesktopDistribution = "official" | "devin";

declare const __T3CODE_DESKTOP_DISTRIBUTION__: string | undefined;

export const resolveDesktopDistribution = (value: string | undefined): DesktopDistribution =>
  value === "devin" ? "devin" : "official";

export const currentDesktopDistribution = (): DesktopDistribution =>
  resolveDesktopDistribution(
    typeof __T3CODE_DESKTOP_DISTRIBUTION__ === "undefined"
      ? undefined
      : __T3CODE_DESKTOP_DISTRIBUTION__,
  );

export const isDevinDesktopDistribution = (distribution = currentDesktopDistribution()): boolean =>
  distribution === "devin";

export function resolveDesktopDistributionIdentity(
  distribution: DesktopDistribution,
  isDevelopment: boolean,
) {
  if (distribution === "devin") {
    return {
      baseName: "t3code+devin",
      displayName: "t3code+devin",
      appId: isDevelopment ? "io.github.jagrat7.t3codedevin.dev" : "io.github.jagrat7.t3codedevin",
      protocolScheme: isDevelopment ? "t3code-devin-dev" : "t3code-devin",
      linuxDesktopEntryName: isDevelopment
        ? "io.github.jagrat7.t3codedevin.Development.desktop"
        : "io.github.jagrat7.t3codedevin.desktop",
      linuxWmClass: isDevelopment ? "t3code-devin-dev" : "t3code-devin",
      userDataDirName: isDevelopment ? "t3code-devin-dev" : "t3code-devin",
      integrationDirectoryName: isDevelopment ? "t3code-devin-dev" : "t3code-devin",
      gnomeCaptureUuid: "snap-shot@t3code-devin.local",
    } as const;
  }

  return {
    baseName: "T3 Code",
    displayName: isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    appId: isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code",
    protocolScheme: isDevelopment ? "t3code-dev" : "t3code",
    linuxDesktopEntryName: isDevelopment
      ? "com.t3tools.T3Code.Development.desktop"
      : "com.t3tools.T3Code.desktop",
    linuxWmClass: isDevelopment ? "t3code-dev" : "t3code",
    userDataDirName: isDevelopment ? "t3code-dev" : "t3code",
    integrationDirectoryName: "t3code",
    gnomeCaptureUuid: "snap-shot@t3.codes",
  } as const;
}
