import type { LlmProvider } from "./provider.js";
import type {
  CompletionChunk,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResponse,
  NormalizedCompletion,
  TaskKind,
  TaskPolicyMap,
  TenantResidency,
} from "./types.js";

export interface ResolvedProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly reason?: string;
}

export interface RouterConfig {
  readonly providers: ReadonlyMap<string, LlmProvider>;
  readonly taskPolicies: TaskPolicyMap;
  getTenantResidency(tenantId: string): Promise<TenantResidency>;
  getTenantOverrides?(tenantId: string): Promise<Partial<TaskPolicyMap>>;
}

export interface LlmRouter {
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  completeAggregate(req: CompletionRequest): Promise<NormalizedCompletion>;
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>;
  resolveProvider(task: TaskKind, tenantId: string): Promise<ResolvedProvider>;
}
