import { z } from "zod";
import { EntitySchema, TraitSchema } from "@crossengin/types/meta-schema";
import { EntityPermissionsSchema, RoleDefinitionSchema } from "@crossengin/auth";
import { WorkflowSchema } from "@crossengin/kernel/workflow";

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

const StringParameter = z.object({
  type: z.literal("string"),
  required: z.boolean().optional(),
  default: z.string().optional(),
  helpText: z.string().optional(),
});

const LongTextParameter = z.object({
  type: z.literal("long-text"),
  required: z.boolean().optional(),
  default: z.string().optional(),
  helpText: z.string().optional(),
});

const IntegerParameter = z.object({
  type: z.literal("integer"),
  required: z.boolean().optional(),
  default: z.number().int().optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  helpText: z.string().optional(),
});

const BooleanParameter = z.object({
  type: z.literal("boolean"),
  required: z.boolean().optional(),
  default: z.boolean().optional(),
  helpText: z.string().optional(),
});

const EnumParameter = z.object({
  type: z.literal("enum"),
  required: z.boolean().optional(),
  values: z.array(z.string().min(1)).min(1),
  default: z.string().optional(),
  helpText: z.string().optional(),
});

const LocalizedStringParameter = z.object({
  type: z.literal("localized-string"),
  required: z.boolean().optional(),
  helpText: z.string().optional(),
});

export const CompliancePackParameterSchema = z.discriminatedUnion("type", [
  StringParameter,
  LongTextParameter,
  IntegerParameter,
  BooleanParameter,
  EnumParameter,
  LocalizedStringParameter,
]);

export type CompliancePackParameter = z.infer<typeof CompliancePackParameterSchema>;

export const CompliancePackMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  version: z.string().regex(SEMVER_REGEX, {
    message: "pack version must be semver MAJOR.MINOR.PATCH",
  }),
  regulator: z.string().optional(),
  appliesTo: z
    .object({
      industries: z.array(z.string()).optional(),
      families: z.array(z.string()).optional(),
    })
    .optional(),
  parameters: z.record(z.string(), CompliancePackParameterSchema).optional(),
  minKernelVersion: z.string().regex(SEMVER_REGEX).optional(),
});

export type CompliancePackMeta = z.infer<typeof CompliancePackMetaSchema>;

export const CompliancePackContributionsSchema = z.object({
  entities: z.array(EntitySchema).optional(),
  traits: z.array(TraitSchema).optional(),
  roles: z.record(z.string(), RoleDefinitionSchema).optional(),
  permissions: z.record(z.string(), EntityPermissionsSchema).optional(),
  workflows: z.record(z.string(), WorkflowSchema).optional(),
});

export type CompliancePackContributions = z.infer<typeof CompliancePackContributionsSchema>;

export const CompliancePackSchema = z.object({
  meta: CompliancePackMetaSchema,
  contributions: CompliancePackContributionsSchema,
});

export type CompliancePack = z.infer<typeof CompliancePackSchema>;
