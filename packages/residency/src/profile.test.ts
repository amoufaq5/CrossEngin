import { describe, expect, it } from "vitest";
import {
  buildProfileFromTemplate,
  minimumProfileForPacks,
  PACK_MIN_PROFILE,
  PROFILE_TEMPLATES,
  RESIDENCY_PROFILE_TEMPLATES,
  ResidencyProfileSchema,
} from "./profile.js";

const now = "2026-05-13T10:00:00.000Z";

describe("RESIDENCY_PROFILE_TEMPLATES", () => {
  it("declares the five canonical templates", () => {
    expect(RESIDENCY_PROFILE_TEMPLATES).toEqual([
      "eu-only",
      "us-only",
      "me-only",
      "unrestricted",
      "custom",
    ]);
  });
});

describe("ResidencyProfileSchema", () => {
  it("parses a custom profile with required fields", () => {
    const p = ResidencyProfileSchema.parse({
      profile: "custom",
      primaryRegion: "eu-central",
      allowedRegions: ["eu-central", "eu-west"],
      forbiddenRegions: ["us-east"],
      allowedLlmProviders: ["fireworks:eu"],
      dataClass: "pii_strict",
      establishedAt: now,
    });
    expect(p.primaryRegion).toBe("eu-central");
  });

  it("rejects primaryRegion not in allowedRegions", () => {
    expect(() =>
      ResidencyProfileSchema.parse({
        profile: "custom",
        primaryRegion: "us-east",
        allowedRegions: ["eu-central"],
        allowedLlmProviders: ["fireworks:eu"],
        dataClass: "pii_basic",
        establishedAt: now,
      }),
    ).toThrow(/primaryRegion .* must be in allowedRegions/);
  });

  it("rejects a region appearing in both allowed and forbidden", () => {
    expect(() =>
      ResidencyProfileSchema.parse({
        profile: "custom",
        primaryRegion: "eu-central",
        allowedRegions: ["eu-central", "us-east"],
        forbiddenRegions: ["us-east"],
        allowedLlmProviders: ["fireworks:eu"],
        dataClass: "pii_basic",
        establishedAt: now,
      }),
    ).toThrow(/both allowedRegions and forbiddenRegions/);
  });

  it("rejects malformed LLM provider ref", () => {
    expect(() =>
      ResidencyProfileSchema.parse({
        profile: "custom",
        primaryRegion: "eu-central",
        allowedRegions: ["eu-central"],
        allowedLlmProviders: ["fireworks"],
        dataClass: "public",
        establishedAt: now,
      }),
    ).toThrow();
  });
});

describe("buildProfileFromTemplate", () => {
  it("eu-only template forbids US + ME + APAC regions", () => {
    const p = buildProfileFromTemplate("eu-only", { establishedAt: now });
    expect(p.allowedRegions).toEqual(["eu-central", "eu-west"]);
    expect(p.forbiddenRegions).toContain("us-east");
    expect(p.forbiddenRegions).toContain("me-uae");
  });

  it("us-only template defaults dataClass to phi", () => {
    const p = buildProfileFromTemplate("us-only", { establishedAt: now });
    expect(p.dataClass).toBe("phi");
  });

  it("me-only template restricts to self-hosted LLM", () => {
    const p = buildProfileFromTemplate("me-only", { establishedAt: now });
    expect(p.allowedLlmProviders).toEqual(["self-hosted-bge:uae"]);
  });

  it("unrestricted template allows every canonical region", () => {
    const p = buildProfileFromTemplate("unrestricted", { establishedAt: now });
    expect(p.allowedRegions.length).toBeGreaterThan(5);
    expect(p.forbiddenRegions).toEqual([]);
  });

  it("includes validatedBy when supplied", () => {
    const p = buildProfileFromTemplate("eu-only", {
      establishedAt: now,
      validatedBy: "u_admin",
    });
    expect(p.validatedBy).toBe("u_admin");
  });
});

describe("PROFILE_TEMPLATES", () => {
  it("each non-custom template has consistent forbiddenRegions ∩ allowedRegions = ∅", () => {
    for (const [, t] of Object.entries(PROFILE_TEMPLATES)) {
      for (const f of t.forbiddenRegions) {
        expect(t.allowedRegions).not.toContain(f);
      }
    }
  });
});

describe("PACK_MIN_PROFILE / minimumProfileForPacks", () => {
  it("maps known packs to a minimum profile", () => {
    expect(PACK_MIN_PROFILE.hipaa).toBe("us-only");
    expect(PACK_MIN_PROFILE.gdpr).toBe("eu-only");
    expect(PACK_MIN_PROFILE["uae-moh"]).toBe("me-only");
  });

  it("returns null when no packs match", () => {
    expect(minimumProfileForPacks([])).toBeNull();
    expect(minimumProfileForPacks(["unknown-pack"])).toBeNull();
  });

  it("picks the strictest profile when packs disagree", () => {
    expect(minimumProfileForPacks(["gdpr"])).toBe("eu-only");
    expect(minimumProfileForPacks(["gdpr", "hipaa"])).toBe("us-only");
    expect(minimumProfileForPacks(["gdpr", "uae-moh"])).toBe("me-only");
    expect(minimumProfileForPacks(["uae-pdpl", "hipaa", "gdpr"])).toBe("me-only");
  });
});
