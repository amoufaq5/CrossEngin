import { z } from "zod";
import { DATA_CLASSES } from "@crossengin/jobs";
import { LIFECYCLE_PHASES } from "./types.js";

const FILE_TYPE_ID_REGEX = /^[a-z][a-zA-Z0-9]*$/;
const ISO_DURATION_REGEX =
  /^P(?=.)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const SIZE_REGEX = /^(\d+(?:\.\d+)?)(B|KB|MB|GB)$/;
const MIME_TYPE_REGEX = /^[a-z0-9*-]+\/[a-z0-9.+*\-_]+$/i;

export const FileTypeIdSchema = z.string().regex(FILE_TYPE_ID_REGEX, {
  message: "file type id must be camelCase starting with a lowercase letter",
});

export const FileSizeSchema = z.string().regex(SIZE_REGEX, {
  message: "file size must be '<n><B|KB|MB|GB>' (e.g., '20MB')",
});
export type FileSize = z.infer<typeof FileSizeSchema>;

export const FileSignedUrlPolicySchema = z
  .object({
    defaultExpiry: z.string().regex(ISO_DURATION_REGEX).default("PT15M"),
    maxExpiry: z.string().regex(ISO_DURATION_REGEX).default("P1D"),
  })
  .refine((v) => durationToSeconds(v.defaultExpiry) <= durationToSeconds(v.maxExpiry), {
    message: "defaultExpiry must be <= maxExpiry",
  });
export type FileSignedUrlPolicy = z.infer<typeof FileSignedUrlPolicySchema>;

export const OCR_LANGUAGE_REGEX = /^[a-z]{3}(?:\+[a-z]{3})*$/;
export const FileOcrConfigSchema = z.object({
  enabled: z.boolean().default(false),
  language: z.string().regex(OCR_LANGUAGE_REGEX).default("eng"),
});
export type FileOcrConfig = z.infer<typeof FileOcrConfigSchema>;

export const FILE_EMBEDDING_SCOPES = ["tenant", "tenant_opt_in_catalog"] as const;
export type FileEmbeddingScope = (typeof FILE_EMBEDDING_SCOPES)[number];

export const FileEmbeddingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  scope: z.enum(FILE_EMBEDDING_SCOPES).default("tenant"),
  chunkTokens: z.number().int().min(64).max(8192).default(1024),
  chunkOverlapTokens: z.number().int().min(0).max(2048).default(128),
});
export type FileEmbeddingConfig = z.infer<typeof FileEmbeddingConfigSchema>;

export const FileLifecyclePhaseSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("hot"),
    durationDays: z.number().int().positive(),
  }),
  z.object({
    phase: z.literal("archive"),
    durationDays: z.number().int().positive().optional(),
    tier: z.enum(["infrequent", "glacier"]).default("infrequent"),
  }),
  z.object({
    phase: z.literal("cold"),
    durationDays: z.number().int().positive().optional(),
  }),
  z.object({
    phase: z.literal("delete"),
  }),
]);
export type FileLifecyclePhaseDefinition = z.infer<typeof FileLifecyclePhaseSchema>;

export const FileRetentionPolicySchema = z.object({
  minYears: z.number().int().min(0).max(100).default(0),
  compliancePackOverride: z.string().min(1).optional(),
});
export type FileRetentionPolicy = z.infer<typeof FileRetentionPolicySchema>;

export const FileStorageBindingSchema = z.object({
  bucket: z.string().min(1),
  prefix: z.string().min(1),
});
export type FileStorageBinding = z.infer<typeof FileStorageBindingSchema>;

export const FileTypeDeclarationSchema = z
  .object({
    label: z.record(z.string(), z.string()).optional(),
    allowedMimeTypes: z.array(z.string().regex(MIME_TYPE_REGEX)).min(1),
    maxSize: FileSizeSchema,
    storage: FileStorageBindingSchema,
    virusScan: z.boolean().default(true),
    ocr: FileOcrConfigSchema.default({}),
    embedding: FileEmbeddingConfigSchema.default({}),
    retention: FileRetentionPolicySchema.default({}),
    lifecycle: z.array(FileLifecyclePhaseSchema).min(1).default([{ phase: "hot", durationDays: 180 }]),
    signedUrl: FileSignedUrlPolicySchema.default({}),
    dataClass: z.enum(DATA_CLASSES),
    generatedOnly: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const phases = new Set<string>();
    v.lifecycle.forEach((p, i) => {
      if (phases.has(p.phase)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lifecycle", i, "phase"],
          message: `duplicate lifecycle phase '${p.phase}'`,
        });
      }
      phases.add(p.phase);
    });
    const order = LIFECYCLE_PHASES;
    let lastIdx = -1;
    v.lifecycle.forEach((p, i) => {
      const idx = order.indexOf(p.phase);
      if (idx <= lastIdx) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lifecycle", i, "phase"],
          message: `lifecycle phases must be declared in order hot → archive → cold → delete`,
        });
      }
      lastIdx = idx;
    });
    if (v.embedding.enabled && !v.ocr.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embedding", "enabled"],
        message: "embedding requires ocr.enabled=true to produce input text",
      });
    }
    if (v.generatedOnly && v.virusScan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["virusScan"],
        message: "generated-only file types skip virus scan; set virusScan=false",
      });
    }
  });
export type FileTypeDeclaration = z.infer<typeof FileTypeDeclarationSchema>;

export function durationToSeconds(iso8601: string): number {
  const match = iso8601.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) throw new Error(`invalid duration: ${iso8601}`);
  const [, y, mo, w, d, h, mi, s] = match;
  return (
    (y ? Number(y) * 31_536_000 : 0) +
    (mo ? Number(mo) * 2_592_000 : 0) +
    (w ? Number(w) * 604_800 : 0) +
    (d ? Number(d) * 86_400 : 0) +
    (h ? Number(h) * 3_600 : 0) +
    (mi ? Number(mi) * 60 : 0) +
    (s ? Number(s) : 0)
  );
}

export function sizeToBytes(size: FileSize): number {
  const match = size.match(SIZE_REGEX);
  if (!match) throw new Error(`invalid size: ${size}`);
  const n = Number(match[1]);
  switch (match[2]) {
    case "B":
      return Math.round(n);
    case "KB":
      return Math.round(n * 1024);
    case "MB":
      return Math.round(n * 1024 * 1024);
    case "GB":
      return Math.round(n * 1024 * 1024 * 1024);
    default:
      throw new Error(`unreachable: ${match[2]}`);
  }
}
