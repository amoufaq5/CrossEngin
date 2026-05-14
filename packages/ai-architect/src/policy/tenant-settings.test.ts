import { describe, expect, it } from "vitest";
import {
  applyPackForcedDefaults,
  PACK_FORCED_DEFAULTS,
  TenantAiSettingsSchema,
  validateSettingChange,
} from "./tenant-settings.js";

const now = "2026-05-13T10:00:00.000Z";

const baseSettings = TenantAiSettingsSchema.parse({
  tenantId: "t_1",
  updatedAt: now,
  updatedBy: "u_admin",
});

describe("TenantAiSettingsSchema", () => {
  it("applies defaults (fireworks-only, always_human, 50K tokens, $200/mo)", () => {
    expect(baseSettings.allowedExternalProviders).toEqual(["fireworks"]);
    expect(baseSettings.schemaChangeApprovalTier).toBe("always_human");
    expect(baseSettings.perSessionTokenCeiling).toBe(50_000);
    expect(baseSettings.perTenantMonthlyDollarCeiling).toBe(200);
  });

  it("rejects allowedExternalProviders without fireworks", () => {
    expect(() =>
      TenantAiSettingsSchema.parse({
        tenantId: "t",
        allowedExternalProviders: ["openai"],
        updatedAt: now,
        updatedBy: "u",
      }),
    ).toThrow(/must include 'fireworks'/);
  });

  it("rejects duplicate providers", () => {
    expect(() =>
      TenantAiSettingsSchema.parse({
        tenantId: "t",
        allowedExternalProviders: ["fireworks", "fireworks"],
        updatedAt: now,
        updatedBy: "u",
      }),
    ).toThrow();
  });
});

describe("PACK_FORCED_DEFAULTS + applyPackForcedDefaults", () => {
  it("hipaa pins sharedCatalogOptIn off and providers to fireworks", () => {
    const forced = PACK_FORCED_DEFAULTS.hipaa;
    expect(forced).toBeDefined();
    expect(forced?.sharedCatalogOptIn).toBe(false);
    expect(forced?.allowedExternalProviders).toEqual(["fireworks"]);
  });

  it("applyPackForcedDefaults overrides tenant settings when packs require", () => {
    const tenantWithOptIn = TenantAiSettingsSchema.parse({
      ...baseSettings,
      sharedCatalogOptIn: true,
      allowedExternalProviders: ["fireworks", "openai"],
    });
    const result = applyPackForcedDefaults(tenantWithOptIn, ["hipaa"]);
    expect(result.sharedCatalogOptIn).toBe(false);
    expect(result.allowedExternalProviders).toEqual(["fireworks"]);
  });

  it("is idempotent — applying twice is the same as once", () => {
    const once = applyPackForcedDefaults(baseSettings, ["hipaa", "21-cfr-part-11"]);
    const twice = applyPackForcedDefaults(once, ["hipaa", "21-cfr-part-11"]);
    expect(twice).toEqual(once);
  });
});

describe("validateSettingChange", () => {
  it("blocks settings that contradict an active pack", () => {
    const r = validateSettingChange({
      settings: baseSettings,
      activePackIds: ["hipaa"],
      proposed: { sharedCatalogOptIn: true },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("pinned");
  });

  it("allows changes that don't touch pack-pinned fields", () => {
    const r = validateSettingChange({
      settings: baseSettings,
      activePackIds: ["hipaa"],
      proposed: { perSessionTokenCeiling: 75_000 },
    });
    expect(r.allowed).toBe(true);
  });

  it("allows changes when no packs apply", () => {
    const r = validateSettingChange({
      settings: baseSettings,
      activePackIds: [],
      proposed: { sharedCatalogOptIn: true },
    });
    expect(r.allowed).toBe(true);
  });
});
