import { z } from "zod";

const CRON_FIELD = String.raw`(?:\*|(?:\*\/\d+)|(?:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)(?:\/\d+)?)`;
const CRON_REGEX = new RegExp(`^${CRON_FIELD}(?: ${CRON_FIELD}){4,5}$`);

export const SYNTHETIC_CHECK_KINDS = [
  "http",
  "ai_architect_conversation",
  "manifest_apply",
  "file_round_trip",
  "browser",
] as const;
export type SyntheticCheckKind = (typeof SYNTHETIC_CHECK_KINDS)[number];

const SyntheticHttpCheckSchema = z.object({
  kind: z.literal("http"),
  url: z.string().url(),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE"]).default("GET"),
  expectStatus: z.array(z.number().int().min(100).max(599)).min(1).default([200]),
  expectBodyContains: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(5_000),
});

const SyntheticAiArchitectCheckSchema = z.object({
  kind: z.literal("ai_architect_conversation"),
  tenantId: z.string().min(1),
  scenarioId: z.string().min(1),
  maxLatencyMs: z.number().int().positive(),
  expectedToolCalls: z.array(z.string().min(1)).optional(),
});

const SyntheticManifestApplyCheckSchema = z.object({
  kind: z.literal("manifest_apply"),
  tenantId: z.string().min(1),
  manifestFixture: z.string().min(1),
  maxLatencyMs: z.number().int().positive(),
});

const SyntheticFileRoundTripCheckSchema = z.object({
  kind: z.literal("file_round_trip"),
  tenantId: z.string().min(1),
  fileSizeBytes: z.number().int().positive(),
  maxLatencyMs: z.number().int().positive(),
});

const SyntheticBrowserCheckSchema = z.object({
  kind: z.literal("browser"),
  url: z.string().url(),
  scriptId: z.string().min(1),
  maxLatencyMs: z.number().int().positive(),
});

export const SyntheticCheckDeclarationSchema = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
  name: z.string().min(1),
  schedule: z.string().regex(CRON_REGEX),
  region: z.string().min(1),
  check: z.discriminatedUnion("kind", [
    SyntheticHttpCheckSchema,
    SyntheticAiArchitectCheckSchema,
    SyntheticManifestApplyCheckSchema,
    SyntheticFileRoundTripCheckSchema,
    SyntheticBrowserCheckSchema,
  ]),
  alertAfterConsecutiveFailures: z.number().int().min(1).default(2),
});
export type SyntheticCheckDeclaration = z.infer<typeof SyntheticCheckDeclarationSchema>;

export const COMPONENT_STATUSES = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export const ComponentStatusSchema = z.enum(COMPONENT_STATUSES);

export const STATUS_PAGE_COMPONENTS = [
  "api",
  "ai_architect",
  "file_uploads",
  "workflows",
  "integrations",
  "search",
  "auth",
  "kernel",
] as const;
export type StatusPageComponentId = (typeof STATUS_PAGE_COMPONENTS)[number];

export const StatusPageComponentSchema = z.object({
  id: z.enum(STATUS_PAGE_COMPONENTS),
  label: z.string().min(1),
  region: z.string().min(1),
  status: ComponentStatusSchema,
  description: z.string().optional(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type StatusPageComponent = z.infer<typeof StatusPageComponentSchema>;

export const StatusIncidentImpactSchema = z.enum([
  "none",
  "minor",
  "major",
  "critical",
]);
export type StatusIncidentImpact = z.infer<typeof StatusIncidentImpactSchema>;

export const StatusIncidentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
  impact: StatusIncidentImpactSchema,
  affectedComponents: z.array(z.enum(STATUS_PAGE_COMPONENTS)).min(1),
  regions: z.array(z.string().min(1)).min(1),
  postMortemUrl: z.string().url().optional(),
});
export type StatusIncident = z.infer<typeof StatusIncidentSchema>;
