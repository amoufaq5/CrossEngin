import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  Region,
  TaskPolicyMap,
} from "@crossengin/ai-providers";
import {
  ResidencyProfileSchema,
  buildProfileFromTemplate,
  type Region as ResidencyRegion,
  type ResidencyProfile,
} from "@crossengin/residency";
import { describe, expect, it } from "vitest";

import { ProviderResolutionError } from "./resolve.js";
import {
  UnsupportedResidencyError,
  residencyProfileToTenantResidency,
  resolveProvidersForProfile,
} from "./residency-profile.js";

const ESTABLISHED = "2026-01-01T00:00:00.000Z";

function profileTemplate(template: "eu-only" | "us-only" | "me-only" | "unrestricted"): ResidencyProfile {
  return buildProfileFromTemplate(template, { establishedAt: ESTABLISHED });
}

function customProfile(primaryRegion: ResidencyRegion): ResidencyProfile {
  const base = buildProfileFromTemplate("unrestricted", { establishedAt: ESTABLISHED });
  return ResidencyProfileSchema.parse({ ...base, profile: "custom", primaryRegion, allowedRegions: [primaryRegion], forbiddenRegions: [] });
}

function fakeProvider(id: string, residency: Region[]): LlmProvider {
  return {
    id,
    models: ["default-model"],
    capabilities: { chat: true, streaming: true, toolUse: false, jsonMode: false, embedding: false, maxContextTokens: 100_000, supportsThinking: false },
    pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
    residency,
    async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      /* no-op */
    },
    async embed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
      throw new Error("not implemented");
    },
  };
}

describe("residencyProfileToTenantResidency", () => {
  it("maps the named templates directly", () => {
    expect(residencyProfileToTenantResidency(profileTemplate("eu-only"))).toBe("eu-only");
    expect(residencyProfileToTenantResidency(profileTemplate("us-only"))).toBe("us-only");
    expect(residencyProfileToTenantResidency(profileTemplate("me-only"))).toBe("me-only");
    expect(residencyProfileToTenantResidency(profileTemplate("unrestricted"))).toBe("unrestricted");
  });

  it("bridges a custom profile via the broad region of its primary", () => {
    expect(residencyProfileToTenantResidency(customProfile("eu-central"))).toBe("eu-only");
    expect(residencyProfileToTenantResidency(customProfile("us-west"))).toBe("us-only");
    expect(residencyProfileToTenantResidency(customProfile("gcc-ksa"))).toBe("me-only");
  });

  it("fails closed for a broad region the router can't express (ap/sa)", () => {
    expect(() => residencyProfileToTenantResidency(customProfile("apac-sg"))).toThrow(UnsupportedResidencyError);
    expect(() => residencyProfileToTenantResidency(customProfile("ap-south"))).toThrow(UnsupportedResidencyError);
  });
});

describe("resolveProvidersForProfile", () => {
  const POLICIES: TaskPolicyMap = {
    executor: { primary: "us-llm/default-model", fallback: ["eu-llm/default-model"] },
  } as unknown as TaskPolicyMap;

  const providers = new Map<string, LlmProvider>([
    ["us-llm", fakeProvider("us-llm", ["us"])],
    ["eu-llm", fakeProvider("eu-llm", ["eu"])],
  ]);

  it("filters the chain to residency-compliant providers under the profile", () => {
    const choices = resolveProvidersForProfile(
      { task: "executor" as never, tenantId: "t1", providers, taskPolicies: POLICIES },
      profileTemplate("eu-only"),
    );
    // the us-only provider is dropped; only the EU provider survives
    expect(choices.map((c) => c.providerId)).toEqual(["eu-llm"]);
  });

  it("throws when no provider serves the profile's region", () => {
    const meProfile = profileTemplate("me-only");
    expect(() =>
      resolveProvidersForProfile({ task: "executor" as never, tenantId: "t1", providers, taskPolicies: POLICIES }, meProfile),
    ).toThrow(ProviderResolutionError);
  });
});
