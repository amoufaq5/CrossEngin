import { z } from "zod";
import { EntitySchema, RelationSchema, TraitSchema } from "@crossengin/types/meta-schema";
import { EntityPermissionsSchema, RoleDefinitionSchema } from "@crossengin/auth";
import { WorkflowSchema } from "../workflow/types.js";

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export const ManifestResolutionEntrySchema = z.object({
  slug: z.string(),
  version: z.string(),
  hash: z.string(),
  parentId: z.string(),
});

export type ManifestResolutionEntry = z.infer<typeof ManifestResolutionEntrySchema>;

export const ManifestResolutionSchema = z.object({
  parents: z.array(ManifestResolutionEntrySchema),
});

export type ManifestResolution = z.infer<typeof ManifestResolutionSchema>;

export const ManifestMetaSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(SLUG_REGEX, {
    message: "slug must be kebab-case path (e.g. 'operate-pharma/community-pharmacy')",
  }),
  version: z.string().regex(SEMVER_REGEX, {
    message: "version must be semver MAJOR.MINOR.PATCH",
  }),
  description: z.string().optional(),
  extends: z.array(z.string().min(1)).optional(),
  compliancePacks: z.array(z.string().min(1)).optional(),
  compliancePackParameters: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  manifestResolution: ManifestResolutionSchema.optional(),
});

export type ManifestMeta = z.infer<typeof ManifestMetaSchema>;

export const ManifestSchema = z.object({
  manifestVersion: z.literal("1.0"),
  meta: ManifestMetaSchema,
  entities: z.array(EntitySchema).optional(),
  traits: z.array(TraitSchema).optional(),
  relations: z.array(RelationSchema).optional(),
  roles: z.record(z.string(), RoleDefinitionSchema).optional(),
  permissions: z.record(z.string(), EntityPermissionsSchema).optional(),
  workflows: z.record(z.string(), WorkflowSchema).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
