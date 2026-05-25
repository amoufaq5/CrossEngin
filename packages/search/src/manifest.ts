import { z } from "zod";

export const FIELD_PATH_REGEX = /^[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*$/;
export const ENTITY_NAME_REGEX = /^[A-Z][A-Za-z0-9]*$/;

export const FieldPathSchema = z.string().regex(FIELD_PATH_REGEX, {
  message: "field path must be lowercase dot.path (e.g., 'patient.name')",
});

export const FTS_WEIGHTS = ["A", "B", "C", "D"] as const;
export type FtsWeight = (typeof FTS_WEIGHTS)[number];

export const INDEXED_FIELD_KINDS = ["text", "exact", "prefix", "phrase"] as const;
export type IndexedFieldKind = (typeof INDEXED_FIELD_KINDS)[number];

export const FTS_DICTIONARIES = [
  "simple",
  "english",
  "french",
  "spanish",
  "arabic",
  "german",
  "portuguese",
] as const;
export type FtsDictionary = (typeof FTS_DICTIONARIES)[number];

export const IndexedFieldSchema = z.object({
  field: FieldPathSchema,
  weight: z.enum(FTS_WEIGHTS).default("B"),
  kind: z.enum(INDEXED_FIELD_KINDS).default("text"),
  boost: z.number().min(0).max(100).optional(),
});
export type IndexedField = z.infer<typeof IndexedFieldSchema>;

export const SearchTemplateSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  url: z.string().min(1),
  iconField: FieldPathSchema.optional(),
});
export type SearchTemplate = z.infer<typeof SearchTemplateSchema>;

export const SearchEntityIndexSchema = z
  .object({
    indexedFields: z.array(IndexedFieldSchema).min(1),
    globalIndex: z.boolean().default(false),
    displayInGlobalResults: SearchTemplateSchema.optional(),
    facets: z.array(FieldPathSchema).default([]),
    semanticIndex: z.boolean().default(false),
    dictionary: z.enum(FTS_DICTIONARIES).optional(),
    typeaheadFields: z.array(FieldPathSchema).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.globalIndex && v.displayInGlobalResults === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["displayInGlobalResults"],
        message: "globalIndex=true requires displayInGlobalResults (title + url template)",
      });
    }
    const fieldNames = new Set<string>();
    v.indexedFields.forEach((f, i) => {
      if (fieldNames.has(f.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["indexedFields", i, "field"],
          message: `duplicate indexed field '${f.field}'`,
        });
      }
      fieldNames.add(f.field);
    });
  });
export type SearchEntityIndex = z.infer<typeof SearchEntityIndexSchema>;

export const SearchFilesConfigSchema = z.object({
  globalIndex: z.boolean().default(false),
  ocr: z.boolean().default(false),
  embedding: z.boolean().default(false),
  embeddingScope: z.enum(["tenant", "tenant_opt_in_catalog"]).default("tenant"),
});
export type SearchFilesConfig = z.infer<typeof SearchFilesConfigSchema>;

export const SearchManifestSchema = z.object({
  entities: z.record(z.string().regex(ENTITY_NAME_REGEX), SearchEntityIndexSchema).default({}),
  files: SearchFilesConfigSchema.optional(),
  defaultDictionary: z.enum(FTS_DICTIONARIES).default("simple"),
});
export type SearchManifest = z.infer<typeof SearchManifestSchema>;

export function indexedEntities(search: SearchManifest): readonly string[] {
  return Object.keys(search.entities);
}

export function indexedFieldPaths(search: SearchManifest, entityName: string): readonly string[] {
  const entry = search.entities[entityName];
  if (entry === undefined) return [];
  return entry.indexedFields.map((f) => f.field);
}

export function globallyIndexedEntities(search: SearchManifest): readonly string[] {
  return Object.entries(search.entities)
    .filter(([, idx]) => idx.globalIndex)
    .map(([name]) => name);
}
