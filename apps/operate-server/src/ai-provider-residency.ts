/**
 * Whether a tenant's residency profile admits the AI designer's provider (M-17).
 *
 * A `ResidencyProfile` lists `allowedLlmProviders` — `<provider>:<qualifier>` refs, and `.min(1)`,
 * so every profile restricts — and `isLlmProviderAllowed` answers the question, with no caller
 * outside its own test. The designer sent every profiled tenant's business description to whichever
 * provider the environment configured, so a tenant whose profile names only an EU endpoint had its
 * prose shipped to a US one.
 *
 * What this process cannot know is where its provider runs: an API key names an account, not a
 * region, and `OPENAI_BASE_URL` can point anywhere. So the ref is **declared** (`--ai-provider-ref`)
 * rather than guessed, and a profiled tenant with no declaration is refused — answering "allowed"
 * for a profile we could not compare against is the defect restated. A tenant with no profile is
 * unconstrained, as it is for request routing. A directory that cannot answer is a 503: not knowing
 * whether the profile forbids this provider must not send the description to it.
 *
 * A refusal is an RFC 9457 problem under a type of its own (ADR-0462), built by
 * `aiProviderResidencyRefusal` beside the region gate's builder. It answers a different question —
 * where the provider runs, not which instance answers — so it shares the registry and none of the
 * region gate's types; the code it carried as a top-level `error` is `extensions.error` now.
 */

import { isLlmProviderAllowed, type ResidencyProfile } from "@crossengin/residency";
import type { TenantResidencyDirectory } from "@crossengin/residency-runtime";

import type { AiProviderAdmission } from "./ai-design-routes.js";

export const AI_PROVIDER_REF_FLAG = "--ai-provider-ref";

/** The grammar `ResidencyProfileSchema.allowedLlmProviders` admits; a test pins the two together. */
export const AI_PROVIDER_REF_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;

export function parseAiProviderRef(raw: string): string {
  if (!AI_PROVIDER_REF_PATTERN.test(raw)) {
    throw new Error(
      `invalid ${AI_PROVIDER_REF_FLAG}: ${JSON.stringify(raw)} — expected '<provider>:<region|qualifier>' ` +
        `as a residency profile's allowedLlmProviders names it (e.g. 'anthropic:us')`,
    );
  }
  return raw;
}

export interface AiProviderResidencyGateInput {
  /** Absent: no residency directory is configured, so no tenant has a profile to honour. */
  readonly directory?: TenantResidencyDirectory;
  readonly providerRef: string | null;
  readonly providerLabel: string;
}

export function buildAiProviderResidencyGate(
  input: AiProviderResidencyGateInput,
): ((tenantId: string) => Promise<AiProviderAdmission>) | undefined {
  const directory = input.directory;
  if (directory === undefined) return undefined;
  return async (tenantId: string): Promise<AiProviderAdmission> => {
    let profile: ResidencyProfile | null;
    try {
      profile = await directory.resolve(tenantId);
    } catch {
      return { allowed: false, refusal: { decision: "unresolved" } };
    }
    if (profile === null) return { allowed: true };
    if (input.providerRef === null) {
      return {
        allowed: false,
        refusal: {
          decision: "undeclared",
          detail:
            `this tenant's residency profile '${profile.profile}' restricts which AI providers may receive its data, ` +
            `and this deployment has not declared where ${input.providerLabel} runs (${AI_PROVIDER_REF_FLAG}), so it ` +
            `cannot be compared; nothing was sent to the provider`,
        },
      };
    }
    const verdict = isLlmProviderAllowed(profile, input.providerRef);
    if (verdict.compatible) return { allowed: true };
    return {
      allowed: false,
      refusal: {
        decision: "forbidden",
        detail:
          `this tenant's residency profile '${profile.profile}' does not permit the AI provider '${input.providerRef}' ` +
          `(it permits ${profile.allowedLlmProviders.join(", ")}); nothing was sent to the provider`,
      },
    };
  };
}

/** The boot line: said either way, because the absence of a refusal is not evidence of a check. */
export function formatAiProviderResidency(input: AiProviderResidencyGateInput): string {
  if (input.directory === undefined) {
    return (
      `ai residency: no residency directory is configured (--residency-file / --residency-store), so no tenant's ` +
      `profile is consulted before its description is sent to ${input.providerLabel}`
    );
  }
  if (input.providerRef === null) {
    return (
      `ai residency: ${input.providerLabel} has no declared location (${AI_PROVIDER_REF_FLAG}); a tenant with a ` +
      `residency profile is refused AI design (403 ai_provider_residency_undeclared), a tenant without one is served`
    );
  }
  return (
    `ai residency: ${input.providerLabel} is '${input.providerRef}'; a tenant whose profile does not list it is ` +
    `refused AI design (403 ai_provider_residency_forbidden), a tenant without a profile is served`
  );
}
