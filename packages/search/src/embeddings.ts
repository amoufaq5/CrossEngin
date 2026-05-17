import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const EMBEDDING_MODELS = [
  "bge-m3",
  "bge-large-en",
  "bge-base-en",
  "openai-text-embedding-3-small",
  "openai-text-embedding-3-large",
] as const;
export type EmbeddingModel = (typeof EMBEDDING_MODELS)[number];

export const EMBEDDING_DIMENSIONS: Readonly<Record<EmbeddingModel, number>> = Object.freeze({
  "bge-m3": 1024,
  "bge-large-en": 1024,
  "bge-base-en": 768,
  "openai-text-embedding-3-small": 1536,
  "openai-text-embedding-3-large": 3072,
});

export const VECTOR_INDEX_KINDS = ["ivfflat", "hnsw"] as const;
export type VectorIndexKind = (typeof VECTOR_INDEX_KINDS)[number];

export const VECTOR_DISTANCES = ["cosine", "l2", "inner_product"] as const;
export type VectorDistance = (typeof VECTOR_DISTANCES)[number];

export const VectorIndexConfigSchema = z
  .object({
    kind: z.enum(VECTOR_INDEX_KINDS),
    distance: z.enum(VECTOR_DISTANCES).default("cosine"),
    ivfflatLists: z.number().int().min(1).max(10_000).optional(),
    hnswM: z.number().int().min(2).max(100).optional(),
    hnswEfConstruction: z.number().int().min(4).max(2048).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "ivfflat" && v.ivfflatLists === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ivfflatLists"],
        message: "ivfflat index requires ivfflatLists",
      });
    }
    if (v.kind === "hnsw" && (v.hnswM === undefined || v.hnswEfConstruction === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hnswM"],
        message: "hnsw index requires both hnswM and hnswEfConstruction",
      });
    }
  });
export type VectorIndexConfig = z.infer<typeof VectorIndexConfigSchema>;

export const EmbeddingChunkSchema = z
  .object({
    tenantId: Uuid,
    sourceKind: z.enum(["file", "entity", "manifest_section", "compliance_pack_section"]),
    sourceId: z.string().min(1),
    chunkIdx: z.number().int().nonnegative(),
    chunkText: z.string().min(1),
    embedding: z.array(z.number()).min(64),
    model: z.enum(EMBEDDING_MODELS),
    dimensions: z.number().int().positive(),
    createdAt: Iso8601,
    tokenCount: z.number().int().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.embedding.length !== v.dimensions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embedding"],
        message: `embedding length ${v.embedding.length} does not match dimensions ${v.dimensions}`,
      });
    }
    const expected = EMBEDDING_DIMENSIONS[v.model];
    if (v.dimensions !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions"],
        message: `model '${v.model}' expects ${expected} dimensions, got ${v.dimensions}`,
      });
    }
  });
export type EmbeddingChunk = z.infer<typeof EmbeddingChunkSchema>;

export interface ChunkingOptions {
  readonly maxChunkTokens: number;
  readonly overlapTokens: number;
  readonly approxCharsPerToken?: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = Object.freeze({
  maxChunkTokens: 1024,
  overlapTokens: 128,
  approxCharsPerToken: 4,
});

export function chunkText(
  text: string,
  opts: ChunkingOptions = DEFAULT_CHUNKING,
): readonly string[] {
  if (text.length === 0) return [];
  const charsPerToken = opts.approxCharsPerToken ?? 4;
  const chunkChars = opts.maxChunkTokens * charsPerToken;
  const overlapChars = opts.overlapTokens * charsPerToken;
  if (overlapChars >= chunkChars) {
    throw new Error("overlapTokens must be strictly less than maxChunkTokens");
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(cursor + chunkChars, text.length);
    chunks.push(text.slice(cursor, end));
    if (end === text.length) break;
    cursor = end - overlapChars;
  }
  return chunks;
}
