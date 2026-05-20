import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  LlmProvider,
  LlmRouter,
  NormalizedCompletion,
  ResolvedProvider,
  RouterConfig,
  TaskKind,
  TaskPolicyMap,
  TenantResidency,
} from "@crossengin/ai-providers";
import {
  contentToText,
  isConflictError,
  isModerationError,
  isNotFoundError,
} from "@crossengin/ai-providers";

import {
  CostCeilingExceededError,
  InMemoryCostTracker,
  type CostCeiling,
  type CostTracker,
} from "./cost-tracker.js";
import {
  NoopRouterInstrumentation,
  type RouterInstrumentation,
} from "./instrumentation.js";
import { InMemoryLatencyTracker, type LatencyTracker } from "./latency-tracker.js";
import { ProviderResolutionError, resolveProviders } from "./resolve.js";
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  isRetryableError,
  withRetry,
  type RetryPolicy,
} from "./retry.js";

export interface RouterPolicy {
  readonly retry?: RetryPolicy;
  readonly costCeiling?: CostCeiling;
}

export interface DefaultLlmRouterOptions extends RouterConfig {
  readonly retry?: RetryPolicy;
  readonly costCeiling?: CostCeiling;
  readonly getTenantCostCeiling?: (tenantId: string) => Promise<CostCeiling | undefined>;
  readonly costTracker?: CostTracker;
  readonly latencyTracker?: LatencyTracker;
  readonly instrumentation?: RouterInstrumentation;
  readonly clock?: () => number;
}

export interface RouterAttempt {
  readonly providerId: string;
  readonly modelId: string;
  readonly attempts: number;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly errorKind?: string;
}

export interface RouterAttemptCollector {
  onAttempt(attempt: RouterAttempt): void;
}

export class AllProvidersExhaustedError extends Error {
  readonly kind = "all_providers_exhausted" as const;
  readonly attempts: readonly RouterAttempt[];

  constructor(attempts: readonly RouterAttempt[]) {
    super(`router exhausted ${attempts.length.toString()} provider attempt(s)`);
    this.name = "AllProvidersExhaustedError";
    this.attempts = attempts;
  }

  isRetryable(): boolean {
    return false;
  }
}

export class DefaultLlmRouter implements LlmRouter {
  private readonly providers: ReadonlyMap<string, LlmProvider>;
  private readonly taskPolicies: TaskPolicyMap;
  private readonly getTenantResidency: (tenantId: string) => Promise<TenantResidency>;
  private readonly getTenantOverrides:
    | ((tenantId: string) => Promise<Partial<TaskPolicyMap>>)
    | undefined;
  private readonly retry: RetryPolicy;
  private readonly costCeiling: CostCeiling | undefined;
  private readonly getTenantCostCeiling:
    | ((tenantId: string) => Promise<CostCeiling | undefined>)
    | undefined;
  private readonly costTracker: CostTracker;
  private readonly latencyTracker: LatencyTracker;
  private readonly instrumentation: RouterInstrumentation;
  private readonly clock: () => number;

  constructor(opts: DefaultLlmRouterOptions) {
    this.providers = opts.providers;
    this.taskPolicies = opts.taskPolicies;
    this.getTenantResidency = opts.getTenantResidency;
    this.getTenantOverrides = opts.getTenantOverrides;
    this.retry = opts.retry ?? DEFAULT_RETRY_POLICY;
    this.costCeiling = opts.costCeiling;
    this.getTenantCostCeiling = opts.getTenantCostCeiling;
    this.costTracker = opts.costTracker ?? new InMemoryCostTracker();
    this.latencyTracker = opts.latencyTracker ?? new InMemoryLatencyTracker();
    this.instrumentation = opts.instrumentation ?? NoopRouterInstrumentation;
    this.clock = opts.clock ?? (() => Date.now());
  }

  async resolveProvider(task: TaskKind, tenantId: string): Promise<ResolvedProvider> {
    const residency = await this.getTenantResidency(tenantId);
    const overrides = await this.getTenantOverrides?.(tenantId);
    const choices = resolveProviders({
      task,
      tenantId,
      residency,
      providers: this.providers,
      taskPolicies: this.taskPolicies,
      overrides,
    });
    const choice = choices[0]!;
    return {
      providerId: choice.providerId,
      modelId: choice.modelId,
      reason: choice.reason,
    };
  }

  async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const choices = await this.chooseProviders(req.task, req.tenantId);
    await this.enforceCeilingPreflight(req.tenantId, this.estimatePreflightCost(req, choices[0]!));
    const attempts: RouterAttempt[] = [];
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i]!;
      const startMs = this.clock();
      const chunks: CompletionChunk[] = [];
      let usageCost = 0;
      let usageInputTokens = 0;
      let usageOutputTokens = 0;
      let usageCachedInputTokens = 0;
      await this.instrumentation.onEvent({
        kind: "llm_call_started",
        tenantId: req.tenantId,
        sessionId: req.sessionId,
        task: req.task,
        providerId: choice.providerId,
        modelId: choice.modelId,
        occurredAt: new Date(startMs).toISOString(),
        durationMs: null,
        attributes: {
          attemptIndex: i,
          totalChoices: choices.length,
        },
      });
      try {
        await withRetry(
          async () => {
            chunks.length = 0;
            usageCost = 0;
            usageInputTokens = 0;
            usageOutputTokens = 0;
            usageCachedInputTokens = 0;
            for await (const chunk of choice.provider.complete({
              ...req,
              model: choice.modelId,
            })) {
              chunks.push(chunk);
              if (chunk.kind === "usage_final") {
                usageCost = chunk.usage.cost;
                usageInputTokens = chunk.usage.inputTokens;
                usageOutputTokens = chunk.usage.outputTokens;
                usageCachedInputTokens = chunk.usage.cachedInputTokens ?? 0;
              }
            }
          },
          { policy: this.retry },
        );
      } catch (err) {
        const latencyMs = this.clock() - startMs;
        const attempt: RouterAttempt = {
          providerId: choice.providerId,
          modelId: choice.modelId,
          attempts: this.retry.maxAttempts,
          success: false,
          latencyMs,
          errorKind: errorKind(err),
        };
        attempts.push(attempt);
        await this.latencyTracker.record({
          providerId: choice.providerId,
          latencyMs,
          success: false,
        });
        const willFallback = isRouterRetryable(err) && i < choices.length - 1;
        await this.instrumentation.onEvent({
          kind: "llm_call_failed",
          tenantId: req.tenantId,
          sessionId: req.sessionId,
          task: req.task,
          providerId: choice.providerId,
          modelId: choice.modelId,
          occurredAt: new Date(startMs).toISOString(),
          durationMs: latencyMs,
          attributes: {
            errorKind: errorKind(err),
            errorMessage: err instanceof Error ? err.message : String(err),
            attempts: this.retry.maxAttempts,
            willFallback,
          },
        });
        if (!isRouterRetryable(err)) throw err;
        continue;
      }
      const latencyMs = this.clock() - startMs;
      attempts.push({
        providerId: choice.providerId,
        modelId: choice.modelId,
        attempts: 1,
        success: true,
        latencyMs,
      });
      await this.latencyTracker.record({
        providerId: choice.providerId,
        latencyMs,
        success: true,
      });
      await this.costTracker.recordUsage({
        tenantId: req.tenantId,
        costUsd: usageCost,
      });
      await this.instrumentation.onEvent({
        kind: "llm_call_completed",
        tenantId: req.tenantId,
        sessionId: req.sessionId,
        task: req.task,
        providerId: choice.providerId,
        modelId: choice.modelId,
        occurredAt: new Date(startMs).toISOString(),
        durationMs: latencyMs,
        attributes: {
          costUsd: usageCost,
          inputTokens: usageInputTokens,
          outputTokens: usageOutputTokens,
          cachedInputTokens: usageCachedInputTokens,
          attempts: 1,
        },
      });
      for (const chunk of chunks) yield chunk;
      return;
    }
    throw new AllProvidersExhaustedError(attempts);
  }

  async completeAggregate(req: CompletionRequest): Promise<NormalizedCompletion> {
    const text: string[] = [];
    const toolCalls: NonNullable<NormalizedCompletion["toolCalls"]> = [];
    const toolBuffers = new Map<string, { name: string; argBuffer: string }>();
    const toolOrder: string[] = [];
    let usage: NormalizedCompletion["usage"] | null = null;
    for await (const chunk of this.complete(req)) {
      if (chunk.kind === "text") {
        text.push(chunk.text);
        continue;
      }
      if (chunk.kind === "tool_call_start") {
        toolBuffers.set(chunk.id, { name: chunk.name, argBuffer: "" });
        toolOrder.push(chunk.id);
        continue;
      }
      if (chunk.kind === "tool_call_arg_delta") {
        const entry = toolBuffers.get(chunk.id);
        if (entry !== undefined) entry.argBuffer += chunk.delta;
        continue;
      }
      if (chunk.kind === "usage_final") {
        usage = chunk.usage;
      }
    }
    for (const id of toolOrder) {
      const buf = toolBuffers.get(id)!;
      toolCalls.push({
        id,
        name: buf.name,
        arguments: parseArgsOrRaw(buf.argBuffer),
      });
    }
    if (usage === null) {
      throw new Error("completeAggregate: stream ended without usage_final chunk");
    }
    return {
      text: text.length > 0 ? text.join("") : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const choices = await this.chooseProviders("embedding", req.tenantId);
    let lastError: unknown;
    for (const choice of choices) {
      try {
        return await choice.provider.embed(req);
      } catch (err) {
        lastError = err;
        if (!isRouterRetryable(err)) throw err;
      }
    }
    throw lastError ?? new Error("embed: no providers available");
  }

  private async chooseProviders(task: TaskKind, tenantId: string) {
    const residency = await this.getTenantResidency(tenantId);
    const overrides = await this.getTenantOverrides?.(tenantId);
    return resolveProviders({
      task,
      tenantId,
      residency,
      providers: this.providers,
      taskPolicies: this.taskPolicies,
      overrides,
    });
  }

  private async enforceCeilingPreflight(
    tenantId: string,
    estimatedCostUsd: number,
  ): Promise<void> {
    const ceiling = await this.resolveCeiling(tenantId);
    if (ceiling === undefined) return;
    const check = await this.costTracker.checkCeiling({
      tenantId,
      estimatedCostUsd,
      ceiling,
    });
    if (!check.allowed) {
      throw new CostCeilingExceededError(check);
    }
  }

  private async resolveCeiling(tenantId: string): Promise<CostCeiling | undefined> {
    if (this.getTenantCostCeiling !== undefined) {
      const tenantCeiling = await this.getTenantCostCeiling(tenantId);
      if (tenantCeiling !== undefined) return tenantCeiling;
    }
    return this.costCeiling;
  }

  private estimatePreflightCost(
    req: CompletionRequest,
    choice: { provider: LlmProvider; modelId: string },
  ): number {
    const pricing = choice.provider.pricing;
    const expectedInputTokens = estimateRequestTokens(req);
    const expectedOutputTokens = req.maxTokens ?? 1024;
    return (
      (expectedInputTokens * pricing.inputPerMillionTokens) / 1_000_000 +
      (expectedOutputTokens * pricing.outputPerMillionTokens) / 1_000_000
    );
  }
}

function estimateRequestTokens(req: CompletionRequest): number {
  let chars = 0;
  for (const m of req.messages) chars += contentToText(m.content).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function parseArgsOrRaw(buffer: string): unknown {
  if (buffer.trim().length === 0) return {};
  try {
    return JSON.parse(buffer);
  } catch {
    return { __raw: buffer };
  }
}

function errorKind(err: unknown): string {
  if (err instanceof Error) {
    const k = (err as unknown as { kind?: string }).kind;
    if (typeof k === "string") return k;
    return err.name;
  }
  return "unknown";
}

function isRouterRetryable(err: unknown): boolean {
  if (err instanceof CostCeilingExceededError) return false;
  if (err instanceof ProviderResolutionError) return false;
  if (err instanceof AllProvidersExhaustedError) return false;
  // Moderation events are terminal — never retry, never fall over to fallback
  // providers (the input itself triggered the moderation; switching providers
  // won't help).
  if (isModerationError(err)) return false;
  // Conflict errors (HTTP 409) are terminal — the resource is in a state
  // that's incompatible with the request. Retrying with the same input always
  // fails the same way. Switching providers won't help either (the conflict
  // is on the operator's resource state, not the provider's availability).
  if (isConflictError(err)) return false;
  // Not-found errors (HTTP 404) are terminal — the identifier doesn't exist
  // (or this principal can't see it). Retrying with the same identifier
  // always fails. Switching providers won't help: identifiers are
  // provider-scoped (OpenAI file_id ≠ Anthropic file_id ≠ Bedrock ARN).
  if (isNotFoundError(err)) return false;
  return isRetryableError(err);
}

export { computeBackoffMs };
