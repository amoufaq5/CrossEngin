import { buildProfileFromTemplate, ResidencyProfileSchema, type ResidencyProfile } from "@crossengin/residency";
import { InMemoryTenantResidencyDirectory } from "@crossengin/residency-runtime";
import { describe, expect, it } from "vitest";

import {
  AI_PROVIDER_REF_FLAG,
  buildAiProviderResidencyGate,
  formatAiProviderResidency,
  parseAiProviderRef,
} from "./ai-provider-residency.js";

const EU_TENANT = "00000000-0000-4000-8000-0000000000e1";
const US_TENANT = "00000000-0000-4000-8000-0000000000a1";
const FREE_TENANT = "00000000-0000-4000-8000-0000000000f1";

function directory(): InMemoryTenantResidencyDirectory {
  const at = { establishedAt: "2026-11-18T00:00:00.000Z" };
  return new InMemoryTenantResidencyDirectory([
    [EU_TENANT, buildProfileFromTemplate("eu-only", at)],
    [US_TENANT, buildProfileFromTemplate("us-only", at)],
  ]);
}

describe("parseAiProviderRef", () => {
  it("accepts exactly the refs a residency profile can list", () => {
    const base = buildProfileFromTemplate("eu-only", { establishedAt: "2026-11-18T00:00:00.000Z" });
    for (const ref of ["anthropic:eu", "openai:us", "self-hosted-bge:uae", "fireworks:eu:fra"]) {
      expect(parseAiProviderRef(ref)).toBe(ref);
      expect(ResidencyProfileSchema.safeParse({ ...base, allowedLlmProviders: [ref] }).success).toBe(true);
    }
    for (const ref of ["anthropic", "Anthropic:eu", "anthropic:", ":eu", "anthropic eu", "1x:eu"]) {
      expect(() => parseAiProviderRef(ref), ref).toThrow(AI_PROVIDER_REF_FLAG);
      expect(ResidencyProfileSchema.safeParse({ ...base, allowedLlmProviders: [ref] }).success).toBe(false);
    }
  });
});

describe("buildAiProviderResidencyGate", () => {
  it("is absent when no directory is configured, so nothing claims a check that is not made", () => {
    expect(buildAiProviderResidencyGate({ providerRef: "anthropic:us", providerLabel: "anthropic/x" })).toBeUndefined();
  });

  it("admits a tenant whose profile lists the declared provider and refuses one whose profile does not", async () => {
    const gate = buildAiProviderResidencyGate({ directory: directory(), providerRef: "anthropic:us", providerLabel: "anthropic/x" });
    expect(await gate?.(US_TENANT)).toEqual({ allowed: true });
    const eu = await gate?.(EU_TENANT);
    expect(eu).toMatchObject({ allowed: false, status: 403, error: "ai_provider_residency_forbidden" });
    expect(eu?.allowed === false ? eu.detail : "").toContain("anthropic:eu");
  });

  it("admits an unprofiled tenant", async () => {
    const gate = buildAiProviderResidencyGate({ directory: directory(), providerRef: "anthropic:us", providerLabel: "anthropic/x" });
    expect(await gate?.(FREE_TENANT)).toEqual({ allowed: true });
  });

  it("refuses a profiled tenant when the provider's location is undeclared, and serves an unprofiled one", async () => {
    const gate = buildAiProviderResidencyGate({ directory: directory(), providerRef: null, providerLabel: "local/qwen" });
    expect(await gate?.(EU_TENANT)).toMatchObject({ allowed: false, status: 403, error: "ai_provider_residency_undeclared" });
    expect(await gate?.(FREE_TENANT)).toEqual({ allowed: true });
  });

  it("answers 503 rather than admitting when the directory cannot be read", async () => {
    const gate = buildAiProviderResidencyGate({
      directory: { resolve: async (): Promise<ResidencyProfile | null> => Promise.reject(new Error("db down")) },
      providerRef: "anthropic:us",
      providerLabel: "anthropic/x",
    });
    expect(await gate?.(US_TENANT)).toMatchObject({ allowed: false, status: 503, error: "ai_residency_unresolved" });
  });
});

describe("formatAiProviderResidency", () => {
  it("says which of the three states the deployment is in", () => {
    expect(formatAiProviderResidency({ providerRef: "anthropic:us", providerLabel: "anthropic/x" })).toMatch(/no residency directory/);
    expect(formatAiProviderResidency({ directory: directory(), providerRef: null, providerLabel: "local/q" })).toMatch(
      /ai_provider_residency_undeclared/,
    );
    expect(formatAiProviderResidency({ directory: directory(), providerRef: "anthropic:us", providerLabel: "anthropic/x" })).toMatch(
      /'anthropic:us'/,
    );
  });
});
