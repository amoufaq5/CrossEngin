import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SOURCE_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const SOURCE_KINDS = [
  "csv",
  "jsonl",
  "json",
  "excel_xlsx",
  "parquet",
  "salesforce",
  "servicenow",
  "sql_dump_postgres",
  "sql_dump_mysql",
  "http_api",
  "hl7_v2",
  "fhir_r4",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SourceKindSchema = z.enum(SOURCE_KINDS);

export const AUTH_KINDS = [
  "none",
  "basic",
  "bearer_token",
  "api_key",
  "oauth2_client_credentials",
  "oauth2_authorization_code",
  "aws_iam",
] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];
export const AuthKindSchema = z.enum(AUTH_KINDS);

export const SOURCE_SCHEDULES = ["one_shot", "interval", "cron", "webhook_driven"] as const;
export type SourceSchedule = (typeof SOURCE_SCHEDULES)[number];

const STRUCTURED_KINDS: ReadonlySet<SourceKind> = new Set([
  "salesforce",
  "servicenow",
  "fhir_r4",
  "sql_dump_postgres",
  "sql_dump_mysql",
]);

export const AuthCredentialRefSchema = z
  .object({
    kind: AuthKindSchema,
    vault: z.string().min(1),
    secretName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    rotateAfterDays: z.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "none" && v.vault !== "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vault"],
        message: "auth kind 'none' requires vault='none' (sentinel value)",
      });
    }
  });
export type AuthCredentialRef = z.infer<typeof AuthCredentialRefSchema>;

export const ImportSourceSpecSchema = z
  .object({
    id: z.string().regex(SOURCE_ID_REGEX),
    tenantId: z.string().min(1),
    label: z.string().min(1),
    kind: SourceKindSchema,
    location: z.string().min(1),
    auth: AuthCredentialRefSchema,
    schedule: z.enum(SOURCE_SCHEDULES).default("one_shot"),
    intervalSeconds: z.number().int().positive().optional(),
    cron: z
      .string()
      .regex(/^(\S+\s+){4}\S+$/)
      .optional(),
    sampleSize: z.number().int().min(1).max(10_000).default(100),
    sourceSchemaUrl: z.string().url().optional(),
    primaryEntity: z.string().min(1).optional(),
    createdAt: Iso8601,
    createdBy: z.string().min(1),
    lastFetchedAt: Iso8601.nullable().default(null),
    lastFetchStatus: z.enum(["ok", "error", "rate_limited"]).nullable().default(null),
    lastFetchError: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.schedule === "interval" && v.intervalSeconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalSeconds"],
        message: "schedule='interval' requires intervalSeconds",
      });
    }
    if (v.schedule === "cron" && v.cron === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cron"],
        message: "schedule='cron' requires a cron expression",
      });
    }
    if (v.schedule === "one_shot" && v.intervalSeconds !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalSeconds"],
        message: "schedule='one_shot' must not declare intervalSeconds",
      });
    }
    if (STRUCTURED_KINDS.has(v.kind) && v.primaryEntity === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryEntity"],
        message: `source kind '${v.kind}' requires primaryEntity (e.g., 'Account', 'incident', 'Patient')`,
      });
    }
    if ((v.kind === "salesforce" || v.kind === "servicenow") && v.auth.kind === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "kind"],
        message: `source kind '${v.kind}' requires authenticated access`,
      });
    }
    if (v.lastFetchStatus === "error" && v.lastFetchError === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastFetchError"],
        message: "lastFetchStatus='error' requires lastFetchError",
      });
    }
  });
export type ImportSourceSpec = z.infer<typeof ImportSourceSpecSchema>;

export function isStructuredSource(kind: SourceKind): boolean {
  return STRUCTURED_KINDS.has(kind);
}

export function requiresAuth(kind: SourceKind): boolean {
  return (
    kind === "salesforce" || kind === "servicenow" || kind === "http_api" || kind === "fhir_r4"
  );
}

export function defaultSampleSizeFor(kind: SourceKind): number {
  if (kind === "csv" || kind === "jsonl") return 1_000;
  if (kind === "excel_xlsx" || kind === "parquet") return 500;
  return 100;
}
