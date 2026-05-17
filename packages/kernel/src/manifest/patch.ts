import { z } from "zod";
import { ManifestSchema } from "./types.js";

export const ManifestPatchSchema = z.object({
  baseHash: z.string().min(1),
  manifest: ManifestSchema,
});

export type ManifestPatch = z.infer<typeof ManifestPatchSchema>;

export const ValidationErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export type ValidationError = z.infer<typeof ValidationErrorSchema>;

export const ValidationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), errors: z.array(ValidationErrorSchema) }),
]);

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const PreviewResultSchema = z.object({
  approvalToken: z.string().min(1),
  newHash: z.string().min(1),
  destructive: z.boolean(),
  ddlStatements: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
});

export type PreviewResult = z.infer<typeof PreviewResultSchema>;

export const ApplyResultSchema = z.object({
  newHash: z.string().min(1),
  appliedAt: z.string(),
  manifestVersion: z.string(),
});

export type ApplyResult = z.infer<typeof ApplyResultSchema>;
