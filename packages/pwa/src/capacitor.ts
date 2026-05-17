import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";

export const NATIVE_PLATFORMS = ["ios", "android"] as const;
export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export const CAPACITOR_PLUGIN_IDS = [
  "@capacitor/camera",
  "@capacitor/filesystem",
  "@capacitor/push-notifications",
  "@capacitor-community/bluetooth-le",
  "@capacitor-community/printer",
  "@capacitor-community/nfc",
  "@capacitor/geolocation",
  "@capacitor/preferences",
  "@capacitor-community/keep-awake",
  "@capacitor-community/biometric-auth",
  "@crossengin/capacitor-secure-storage",
  "@crossengin/capacitor-mlllp",
] as const;
export type CapacitorPluginId = (typeof CAPACITOR_PLUGIN_IDS)[number];

export const PluginCapabilitySchema = z.enum([
  "camera",
  "filesystem",
  "push",
  "ble",
  "printer",
  "nfc",
  "geolocation",
  "preferences",
  "keep_awake",
  "biometric",
  "secure_storage",
  "hl7_mllp",
]);
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PLUGIN_CAPABILITIES: Readonly<Record<CapacitorPluginId, PluginCapability>> =
  Object.freeze({
    "@capacitor/camera": "camera",
    "@capacitor/filesystem": "filesystem",
    "@capacitor/push-notifications": "push",
    "@capacitor-community/bluetooth-le": "ble",
    "@capacitor-community/printer": "printer",
    "@capacitor-community/nfc": "nfc",
    "@capacitor/geolocation": "geolocation",
    "@capacitor/preferences": "preferences",
    "@capacitor-community/keep-awake": "keep_awake",
    "@capacitor-community/biometric-auth": "biometric",
    "@crossengin/capacitor-secure-storage": "secure_storage",
    "@crossengin/capacitor-mlllp": "hl7_mllp",
  });

const FIRST_PARTY_PREFIX = "@crossengin/";

export const NativePluginDeclarationSchema = z
  .object({
    id: z.enum(CAPACITOR_PLUGIN_IDS),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    platforms: z.array(z.enum(NATIVE_PLATFORMS)).min(1),
    capability: PluginCapabilitySchema,
    requiredFor: z.array(z.string().min(1)).default([]),
    permissionPromptCopyKey: z.string().min(1).optional(),
    deferToCapacitorWrapper: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const expected = PLUGIN_CAPABILITIES[v.id];
    if (expected !== v.capability) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capability"],
        message: `plugin '${v.id}' provides '${expected}' capability, not '${v.capability}'`,
      });
    }
    if (v.id.startsWith(FIRST_PARTY_PREFIX) === false && v.permissionPromptCopyKey === undefined) {
      const requiresPrompt: ReadonlySet<PluginCapability> = new Set([
        "camera",
        "push",
        "ble",
        "nfc",
        "geolocation",
        "biometric",
      ]);
      if (requiresPrompt.has(v.capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["permissionPromptCopyKey"],
          message: `capability '${v.capability}' requires a permissionPromptCopyKey for the iOS / Android privacy disclosure`,
        });
      }
    }
  });
export type NativePluginDeclaration = z.infer<typeof NativePluginDeclarationSchema>;

export const NativePluginCatalogSchema = z
  .array(NativePluginDeclarationSchema)
  .superRefine((entries, ctx) => {
    const ids = new Set<string>();
    entries.forEach((e, i) => {
      if (ids.has(e.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate plugin '${e.id}'`,
        });
      }
      ids.add(e.id);
    });
  });
export type NativePluginCatalog = z.infer<typeof NativePluginCatalogSchema>;

export const LIVE_UPDATE_CHANNEL_KINDS = ["preview", "staging", "production"] as const;
export type LiveUpdateChannelKind = (typeof LIVE_UPDATE_CHANNEL_KINDS)[number];

export const LiveUpdateChannelSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    kind: z.enum(LIVE_UPDATE_CHANNEL_KINDS),
    region: RegionSchema,
    autoUpdate: z.boolean().default(true),
    maxConcurrentDownloads: z.number().int().min(1).max(1_000_000).default(1_000),
    rolloutPercent: z.number().int().min(0).max(100).default(100),
    requiresAppStoreReview: z.literal(false).default(false),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "production" && v.rolloutPercent > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rolloutPercent"],
        message: "rolloutPercent cannot exceed 100",
      });
    }
    if (v.kind === "preview" && v.rolloutPercent !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rolloutPercent"],
        message: "preview channels deploy at 100% (no canary)",
      });
    }
  });
export type LiveUpdateChannel = z.infer<typeof LiveUpdateChannelSchema>;

export const MobileShellConfigSchema = z
  .object({
    appName: z.string().min(1).max(30),
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/),
    minIosVersion: z.string().regex(/^\d+\.\d+$/).default("16.4"),
    minAndroidApiLevel: z.number().int().min(21).max(40).default(29),
    plugins: NativePluginCatalogSchema,
    liveUpdateChannels: z.array(LiveUpdateChannelSchema).min(1),
    biometricUnlockOnAppOpen: z.boolean().default(false),
    sessionInactivityAutoLockMinutes: z.number().int().min(1).max(1440).default(15),
    phiOfflineCacheEnabled: z.boolean().default(false),
    phiCacheAutoPurgeHours: z.number().int().min(1).max(168).default(24),
  })
  .superRefine((v, ctx) => {
    if (v.phiOfflineCacheEnabled && !v.biometricUnlockOnAppOpen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["biometricUnlockOnAppOpen"],
        message: "phiOfflineCacheEnabled=true requires biometricUnlockOnAppOpen=true (per ADR-0019)",
      });
    }
    const channelIds = new Set<string>();
    v.liveUpdateChannels.forEach((c, i) => {
      if (channelIds.has(c.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["liveUpdateChannels", i, "id"],
          message: `duplicate channel id '${c.id}'`,
        });
      }
      channelIds.add(c.id);
    });
  });
export type MobileShellConfig = z.infer<typeof MobileShellConfigSchema>;

export function selectChannel(
  shell: MobileShellConfig,
  kind: LiveUpdateChannelKind,
  region: string,
): LiveUpdateChannel | null {
  return (
    shell.liveUpdateChannels.find((c) => c.kind === kind && c.region === region) ?? null
  );
}

export function pluginsForCapability(
  catalog: NativePluginCatalog,
  capability: PluginCapability,
): readonly NativePluginDeclaration[] {
  return catalog.filter((p) => p.capability === capability);
}
