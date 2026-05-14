import { describe, expect, it } from "vitest";
import {
  CAPACITOR_PLUGIN_IDS,
  LiveUpdateChannelSchema,
  MobileShellConfigSchema,
  NativePluginCatalogSchema,
  NativePluginDeclarationSchema,
  pluginsForCapability,
  selectChannel,
} from "./capacitor.js";

describe("CAPACITOR_PLUGIN_IDS", () => {
  it("includes the documented official + community + first-party plugins", () => {
    expect(CAPACITOR_PLUGIN_IDS).toContain("@capacitor/camera");
    expect(CAPACITOR_PLUGIN_IDS).toContain("@capacitor-community/bluetooth-le");
    expect(CAPACITOR_PLUGIN_IDS).toContain("@crossengin/capacitor-secure-storage");
    expect(CAPACITOR_PLUGIN_IDS).toContain("@crossengin/capacitor-mlllp");
  });
});

describe("NativePluginDeclarationSchema", () => {
  const baseDecl = {
    id: "@capacitor/camera" as const,
    version: "6.0.0",
    platforms: ["ios" as const, "android" as const],
    capability: "camera" as const,
    requiredFor: ["barcode-scan", "document-photo"],
    permissionPromptCopyKey: "perm.camera.prompt",
  };

  it("parses a typical declaration", () => {
    expect(() => NativePluginDeclarationSchema.parse(baseDecl)).not.toThrow();
  });

  it("rejects mismatched capability for the declared plugin id", () => {
    expect(() =>
      NativePluginDeclarationSchema.parse({ ...baseDecl, capability: "ble" }),
    ).toThrow(/provides 'camera' capability/);
  });

  it("requires permissionPromptCopyKey for prompt-bearing capabilities (third-party)", () => {
    expect(() =>
      NativePluginDeclarationSchema.parse({
        ...baseDecl,
        permissionPromptCopyKey: undefined,
      }),
    ).toThrow(/permissionPromptCopyKey/);
  });

  it("waives permissionPromptCopyKey for first-party plugins", () => {
    expect(() =>
      NativePluginDeclarationSchema.parse({
        id: "@crossengin/capacitor-secure-storage",
        version: "1.0.0",
        platforms: ["ios", "android"],
        capability: "secure_storage",
      }),
    ).not.toThrow();
  });
});

describe("NativePluginCatalogSchema + pluginsForCapability", () => {
  const catalog = NativePluginCatalogSchema.parse([
    {
      id: "@capacitor/camera",
      version: "6.0.0",
      platforms: ["ios", "android"],
      capability: "camera",
      permissionPromptCopyKey: "perm.camera.prompt",
    },
    {
      id: "@capacitor/preferences",
      version: "6.0.0",
      platforms: ["ios", "android"],
      capability: "preferences",
    },
  ]);

  it("rejects duplicate plugin ids", () => {
    expect(() =>
      NativePluginCatalogSchema.parse([
        {
          id: "@capacitor/camera",
          version: "6.0.0",
          platforms: ["ios"],
          capability: "camera",
          permissionPromptCopyKey: "x",
        },
        {
          id: "@capacitor/camera",
          version: "6.0.1",
          platforms: ["android"],
          capability: "camera",
          permissionPromptCopyKey: "x",
        },
      ]),
    ).toThrow(/duplicate plugin/);
  });

  it("pluginsForCapability filters by capability", () => {
    expect(pluginsForCapability(catalog, "camera")).toHaveLength(1);
    expect(pluginsForCapability(catalog, "ble")).toHaveLength(0);
  });
});

describe("LiveUpdateChannelSchema", () => {
  it("parses a production channel for eu-central", () => {
    expect(() =>
      LiveUpdateChannelSchema.parse({
        id: "production-eu-central",
        kind: "production",
        region: "eu-central",
        rolloutPercent: 25,
      }),
    ).not.toThrow();
  });

  it("requires preview to deploy at 100%", () => {
    expect(() =>
      LiveUpdateChannelSchema.parse({
        id: "preview",
        kind: "preview",
        region: "eu-central",
        rolloutPercent: 50,
      }),
    ).toThrow(/preview channels deploy at 100%/);
  });
});

describe("MobileShellConfigSchema + selectChannel", () => {
  const shell = MobileShellConfigSchema.parse({
    appName: "CrossEngin",
    appId: "com.crossengin.app",
    plugins: [
      {
        id: "@capacitor/camera",
        version: "6.0.0",
        platforms: ["ios", "android"],
        capability: "camera",
        permissionPromptCopyKey: "perm.camera.prompt",
      },
    ],
    liveUpdateChannels: [
      {
        id: "production-eu",
        kind: "production",
        region: "eu-central",
        rolloutPercent: 100,
      },
      {
        id: "staging-eu",
        kind: "staging",
        region: "eu-central",
        rolloutPercent: 100,
      },
    ],
  });

  it("applies defaults: min iOS 16.4, Android API 29, 15-min auto-lock", () => {
    expect(shell.minIosVersion).toBe("16.4");
    expect(shell.minAndroidApiLevel).toBe(29);
    expect(shell.sessionInactivityAutoLockMinutes).toBe(15);
  });

  it("rejects phiOfflineCacheEnabled without biometricUnlockOnAppOpen", () => {
    expect(() =>
      MobileShellConfigSchema.parse({
        appName: "CrossEngin",
        appId: "com.crossengin.app",
        plugins: shell.plugins,
        liveUpdateChannels: shell.liveUpdateChannels,
        phiOfflineCacheEnabled: true,
        biometricUnlockOnAppOpen: false,
      }),
    ).toThrow(/biometricUnlockOnAppOpen=true/);
  });

  it("selectChannel resolves by (kind, region)", () => {
    const channel = selectChannel(shell, "production", "eu-central");
    expect(channel?.id).toBe("production-eu");
  });

  it("selectChannel returns null when no match", () => {
    expect(selectChannel(shell, "production", "us-east")).toBeNull();
  });

  it("rejects duplicate channel ids", () => {
    expect(() =>
      MobileShellConfigSchema.parse({
        appName: "CrossEngin",
        appId: "com.crossengin.app",
        plugins: shell.plugins,
        liveUpdateChannels: [
          { id: "dup", kind: "preview", region: "eu-central", rolloutPercent: 100 },
          { id: "dup", kind: "staging", region: "eu-central", rolloutPercent: 100 },
        ],
      }),
    ).toThrow(/duplicate channel id/);
  });
});
