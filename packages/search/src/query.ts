import { z } from "zod";
import { FieldPathSchema, ENTITY_NAME_REGEX } from "./manifest.js";
import { PermissionTagSchema } from "./permissions.js";

export const SEARCH_KINDS = ["entity", "global", "semantic", "typeahead"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_ENGINES = ["postgres_fts", "pgvector", "typesense"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export const SEARCH_FACET_OPERATORS = ["eq", "in", "between"] as const;
export type SearchFacetOperator = (typeof SEARCH_FACET_OPERATORS)[number];

export const FacetSelectionSchema = z
  .object({
    field: FieldPathSchema,
    operator: z.enum(SEARCH_FACET_OPERATORS),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
  })
  .superRefine((v, ctx) => {
    if (v.operator === "eq" && v.values.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values"],
        message: "operator 'eq' requires exactly one value",
      });
    }
    if (v.operator === "between" && v.values.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values"],
        message: "operator 'between' requires exactly two values [from, to]",
      });
    }
  });
export type FacetSelection = z.infer<typeof FacetSelectionSchema>;

export const SortDirectionSchema = z.enum(["asc", "desc"]);
export type SortDirection = z.infer<typeof SortDirectionSchema>;

export const SearchSortSchema = z.object({
  field: FieldPathSchema,
  direction: SortDirectionSchema.default("desc"),
});

const BaseSearchQuerySchema = z.object({
  text: z.string().min(1).max(512).optional(),
  filters: z.array(FacetSelectionSchema).default([]),
  sort: z.array(SearchSortSchema).default([]),
  pageSize: z.number().int().min(1).max(500).default(20),
  cursor: z.string().min(1).optional(),
  permissionTags: z.array(PermissionTagSchema).default([]),
  highlight: z.boolean().default(true),
  facets: z.array(FieldPathSchema).default([]),
});

export const EntitySearchQuerySchema = BaseSearchQuerySchema.extend({
  kind: z.literal("entity"),
  entity: z.string().regex(ENTITY_NAME_REGEX),
});

export const GlobalSearchQuerySchema = BaseSearchQuerySchema.extend({
  kind: z.literal("global"),
  entityScope: z
    .array(z.string().regex(ENTITY_NAME_REGEX))
    .default([])
    .describe("optional restriction to a subset of globally-indexed entities"),
});

export const SemanticSearchQuerySchema = BaseSearchQuerySchema.extend({
  kind: z.literal("semantic"),
  entity: z.string().regex(ENTITY_NAME_REGEX).optional(),
  embedding: z.array(z.number()).min(64).max(8192).optional(),
  similarity: z.enum(["cosine", "l2", "inner_product"]).default("cosine"),
  minScore: z.number().min(0).max(1).optional(),
});

export const TypeaheadQuerySchema = BaseSearchQuerySchema.extend({
  kind: z.literal("typeahead"),
  text: z.string().min(1).max(256),
  entityScope: z.array(z.string().regex(ENTITY_NAME_REGEX)).default([]),
  maxResultsPerEntity: z.number().int().min(1).max(20).default(5),
});

export const SearchQuerySchema = z.discriminatedUnion("kind", [
  EntitySearchQuerySchema,
  GlobalSearchQuerySchema,
  SemanticSearchQuerySchema,
  TypeaheadQuerySchema,
]);
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchHitSchema = z.object({
  id: z.string().min(1),
  entityType: z.string().regex(ENTITY_NAME_REGEX),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  url: z.string().min(1).optional(),
  score: z.number().nonnegative(),
  highlights: z.record(z.string().min(1), z.array(z.string()).min(1)).default({}),
  redactedFields: z.array(z.string().min(1)).default([]),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const FacetBucketSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  count: z.number().int().nonnegative(),
});
export const FacetBucketsSchema = z.record(FieldPathSchema, z.array(FacetBucketSchema));
export type FacetBuckets = z.infer<typeof FacetBucketsSchema>;

export const SearchResultSchema = z.object({
  query: SearchQuerySchema,
  hits: z.array(SearchHitSchema),
  facetBuckets: FacetBucketsSchema.default({}),
  totalHits: z.number().int().nonnegative().nullable(),
  nextCursor: z.string().min(1).nullable().default(null),
  engine: z.enum(SEARCH_ENGINES),
  latencyMs: z.number().int().nonnegative(),
  cacheHit: z.boolean().default(false),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export function selectEngine(query: SearchQuery): SearchEngine {
  switch (query.kind) {
    case "entity":
      return "postgres_fts";
    case "global":
    case "typeahead":
      return "typesense";
    case "semantic":
      return "pgvector";
  }
}
