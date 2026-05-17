import type {
  LlmProvider,
  TaskKind,
  TaskPolicy,
  TaskPolicyMap,
  TenantResidency,
} from "@crossengin/ai-providers";

export interface ResolveInput {
  readonly task: TaskKind;
  readonly tenantId: string;
  readonly residency: TenantResidency;
  readonly providers: ReadonlyMap<string, LlmProvider>;
  readonly taskPolicies: TaskPolicyMap;
  readonly overrides?: Partial<TaskPolicyMap>;
}

export interface ResolvedProviderChoice {
  readonly providerId: string;
  readonly provider: LlmProvider;
  readonly modelId: string;
  readonly reason: string;
}

export class ProviderResolutionError extends Error {
  readonly kind = "provider_resolution_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderResolutionError";
  }

  isRetryable(): boolean {
    return false;
  }
}

export function effectivePolicy(input: ResolveInput): TaskPolicy {
  const override = input.overrides?.[input.task];
  if (override !== undefined) return override;
  const policy = input.taskPolicies[input.task];
  if (policy === undefined) {
    throw new ProviderResolutionError(`no task policy for task '${input.task}'`);
  }
  return policy;
}

export function residencyAllowsProvider(
  residency: TenantResidency,
  provider: LlmProvider,
): boolean {
  if (residency === "unrestricted") return true;
  const required = residencyRegion(residency);
  return provider.residency.includes(required as "us" | "eu" | "me" | "ap" | "sa");
}

function residencyRegion(residency: TenantResidency): string {
  switch (residency) {
    case "eu-only":
      return "eu";
    case "us-only":
      return "us";
    case "me-only":
      return "me";
    case "unrestricted":
      return "unrestricted";
  }
}

export function chainFromPolicy(policy: TaskPolicy): readonly string[] {
  return [policy.primary, ...policy.fallback];
}

export function resolveProviders(input: ResolveInput): readonly ResolvedProviderChoice[] {
  const policy = effectivePolicy(input);
  const order = chainFromPolicy(policy);
  const choices: ResolvedProviderChoice[] = [];
  for (const ref of order) {
    const { providerId, modelId } = parseProviderRef(ref);
    const provider = input.providers.get(providerId);
    if (provider === undefined) continue;
    if (!residencyAllowsProvider(input.residency, provider)) continue;
    const effectiveModel = modelId ?? provider.models[0];
    if (effectiveModel === undefined) continue;
    choices.push({
      providerId,
      provider,
      modelId: effectiveModel,
      reason:
        modelId !== undefined
          ? `policy chain entry '${ref}'`
          : `policy chain entry '${ref}' (default model)`,
    });
  }
  if (choices.length === 0) {
    throw new ProviderResolutionError(
      `no usable provider for task '${input.task}' (residency=${input.residency}; policy primary='${policy.primary}')`,
    );
  }
  return choices;
}

export function parseProviderRef(ref: string): {
  readonly providerId: string;
  readonly modelId: string | null;
} {
  const slashIdx = ref.indexOf("/");
  if (slashIdx < 0) return { providerId: ref, modelId: null };
  return {
    providerId: ref.slice(0, slashIdx),
    modelId: ref.slice(slashIdx + 1),
  };
}
