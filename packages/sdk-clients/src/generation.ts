import { z } from "zod";
import { TargetLanguageSchema, type TargetLanguage } from "./languages.js";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const GENERATOR_TOOLS = [
  "openapi_generator",
  "swagger_codegen",
  "stainless",
  "fern",
  "custom_template",
  "manual",
] as const;
export type GeneratorTool = (typeof GENERATOR_TOOLS)[number];
export const GeneratorToolSchema = z.enum(GENERATOR_TOOLS);

export const SPEC_FORMATS = ["openapi_3_1", "openapi_3_0", "asyncapi_2", "protobuf_3"] as const;
export type SpecFormat = (typeof SPEC_FORMATS)[number];

export const GENERATION_STATUSES = [
  "queued",
  "fetching_spec",
  "generating",
  "linting",
  "testing",
  "packaging",
  "succeeded",
  "failed",
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];
export const GenerationStatusSchema = z.enum(GENERATION_STATUSES);

export const GENERATION_TRANSITIONS: Readonly<
  Record<GenerationStatus, readonly GenerationStatus[]>
> = Object.freeze({
  queued: ["fetching_spec", "failed"],
  fetching_spec: ["generating", "failed"],
  generating: ["linting", "failed"],
  linting: ["testing", "failed"],
  testing: ["packaging", "failed"],
  packaging: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
});

export function canTransitionGeneration(from: GenerationStatus, to: GenerationStatus): boolean {
  return GENERATION_TRANSITIONS[from].includes(to);
}

export const NAMING_CONVENTIONS = ["camelCase", "snake_case", "PascalCase", "kebab-case"] as const;
export type NamingConvention = (typeof NAMING_CONVENTIONS)[number];

export const LANGUAGE_NAMING: Readonly<Record<TargetLanguage, NamingConvention>> = Object.freeze({
  typescript: "camelCase",
  python: "snake_case",
  go: "PascalCase",
  java: "camelCase",
  csharp: "PascalCase",
  ruby: "snake_case",
  rust: "snake_case",
  php: "camelCase",
  swift: "camelCase",
  kotlin: "camelCase",
});

export const GeneratorConfigSchema = z
  .object({
    language: TargetLanguageSchema,
    tool: GeneratorToolSchema,
    namingConvention: z.enum(NAMING_CONVENTIONS),
    nullableEmptyString: z.boolean().default(false),
    nullableEmptyArray: z.boolean().default(false),
    generateAsyncMethods: z.boolean().default(true),
    generateSyncMethods: z.boolean().default(false),
    generateStreamMethods: z.boolean().default(true),
    includeDeprecated: z.boolean().default(true),
    minRuntimeVersion: z.string().min(1).optional(),
    extraImports: z.array(z.string().min(1)).default([]),
    customTemplatePath: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const expected = LANGUAGE_NAMING[v.language];
    if (expected !== v.namingConvention) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["namingConvention"],
        message: `language '${v.language}' conventionally uses '${expected}' (got '${v.namingConvention}'); override only with strong reason`,
      });
    }
    if (v.tool === "custom_template" && v.customTemplatePath === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customTemplatePath"],
        message: "tool='custom_template' requires customTemplatePath",
      });
    }
    if (v.tool === "manual" && v.generateAsyncMethods) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tool"],
        message: "tool='manual' does not generate methods (manually-maintained client)",
      });
    }
    const goSync: ReadonlySet<TargetLanguage> = new Set(["go"]);
    if (goSync.has(v.language) && !v.generateSyncMethods) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generateSyncMethods"],
        message: "Go SDK is conventionally synchronous; generateSyncMethods should be true",
      });
    }
  });
export type GeneratorConfig = z.infer<typeof GeneratorConfigSchema>;

export const SpecSourceSchema = z
  .object({
    format: z.enum(SPEC_FORMATS),
    sourceUrl: z.string().url(),
    sourceSha256: z.string().regex(SHA256_REGEX),
    fetchedAt: Iso8601,
    apiVersion: z.string().min(1),
    sizeBytes: z.number().int().positive(),
  })
  .strict();
export type SpecSource = z.infer<typeof SpecSourceSchema>;

export const GenerationRunSchema = z
  .object({
    id: z.string().min(1),
    language: TargetLanguageSchema,
    config: GeneratorConfigSchema,
    spec: SpecSourceSchema,
    status: GenerationStatusSchema,
    queuedAt: Iso8601,
    startedAt: Iso8601.nullable().default(null),
    completedAt: Iso8601.nullable().default(null),
    durationSeconds: z.number().int().nonnegative().nullable().default(null),
    outputArtifactSha256: z.string().regex(SHA256_REGEX).nullable().default(null),
    outputStorageUri: z.string().min(1).nullable().default(null),
    triggeredBy: z.string().min(1),
    failureReason: z.string().min(1).optional(),
    testsPassed: z.number().int().nonnegative().nullable().default(null),
    testsFailed: z.number().int().nonnegative().nullable().default(null),
    lintWarnings: z.number().int().nonnegative().nullable().default(null),
    lintErrors: z.number().int().nonnegative().nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.config.language !== v.language) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config", "language"],
        message: "config.language must match the run's language",
      });
    }
    if (v.status === "succeeded") {
      if (v.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["completedAt"],
          message: "succeeded status requires completedAt",
        });
      }
      if (v.outputArtifactSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputArtifactSha256"],
          message: "succeeded status requires outputArtifactSha256 (build proof)",
        });
      }
      if (v.outputStorageUri === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputStorageUri"],
          message: "succeeded status requires outputStorageUri",
        });
      }
      if (v.testsFailed !== null && v.testsFailed > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["testsFailed"],
          message:
            "succeeded status requires testsFailed=0 (cannot ship a client with failing tests)",
        });
      }
      if (v.lintErrors !== null && v.lintErrors > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lintErrors"],
          message: "succeeded status requires lintErrors=0",
        });
      }
    }
    if (v.status === "failed" && v.failureReason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failureReason"],
        message: "failed status requires failureReason",
      });
    }
  });
export type GenerationRun = z.infer<typeof GenerationRunSchema>;

export function namingFor(language: TargetLanguage): NamingConvention {
  return LANGUAGE_NAMING[language];
}

export function defaultConfigFor(language: TargetLanguage): GeneratorConfig {
  return {
    language,
    tool: "openapi_generator",
    namingConvention: LANGUAGE_NAMING[language],
    nullableEmptyString: false,
    nullableEmptyArray: false,
    generateAsyncMethods: language !== "go",
    generateSyncMethods: language === "go",
    generateStreamMethods: true,
    includeDeprecated: true,
    extraImports: [],
  };
}
