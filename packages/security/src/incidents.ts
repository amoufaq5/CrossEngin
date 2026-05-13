import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });

export const SECURITY_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

export const SecuritySeveritySchema = z.enum(SECURITY_SEVERITIES);

export const SECURITY_SEVERITY_DESCRIPTIONS: Readonly<Record<SecuritySeverity, string>> =
  Object.freeze({
    P0: "Tenant data leak, RCE, cross-tenant access — disclose to affected tenants within 24h",
    P1: "Service outage > 5 minutes, partial data loss, MFA bypass",
    P2: "Performance degradation, single-feature outage",
    P3: "Low-impact bug with security implications; no exploit observed",
  });

export const INCIDENT_KINDS = [
  "cross_tenant_data_access",
  "credential_compromise_user",
  "credential_compromise_staff",
  "prompt_injection",
  "data_loss",
  "service_outage",
  "supply_chain",
  "denial_of_service",
  "insider_abuse",
  "encryption_failure",
  "vulnerability_disclosure",
  "other",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const NOTIFICATION_STATUSES = [
  "not_required",
  "pending",
  "in_progress",
  "completed",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const IncidentRecordSchema = z
  .object({
    id: z.string().min(1),
    severity: SecuritySeveritySchema,
    kind: z.enum(INCIDENT_KINDS),
    title: z.string().min(1),
    detectedAt: Iso8601,
    containedAt: Iso8601.nullable(),
    resolvedAt: Iso8601.nullable(),
    affectedTenantIds: z.array(z.string().min(1)).default([]),
    affectedDataClasses: z.array(z.string().min(1)).default([]),
    customerNotification: z.object({
      required: z.boolean(),
      status: z.enum(NOTIFICATION_STATUSES),
      slaHours: z.number().int().positive().default(24),
      completedAt: Iso8601.nullable(),
    }),
    regulatorNotification: z
      .object({
        regulator: z.string().min(1),
        slaHours: z.number().int().positive(),
        status: z.enum(NOTIFICATION_STATUSES),
        completedAt: Iso8601.nullable(),
      })
      .optional(),
    postMortemPath: z.string().min(1).optional(),
    rootCause: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.severity === "P0" && v.affectedTenantIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["affectedTenantIds"],
        message: "P0 incidents must list at least one affected tenant (or 'all_tenants' marker)",
      });
    }
    if (v.severity === "P0" && v.customerNotification.required === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customerNotification", "required"],
        message: "P0 incidents always require customer notification",
      });
    }
    if (v.containedAt !== null && v.resolvedAt !== null) {
      if (new Date(v.containedAt) > new Date(v.resolvedAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["containedAt"],
          message: "containedAt must be <= resolvedAt",
        });
      }
    }
  });
export type IncidentRecord = z.infer<typeof IncidentRecordSchema>;

export function notificationOverdueHours(
  incident: IncidentRecord,
  now: Date = new Date(),
): number | null {
  const notif = incident.customerNotification;
  if (!notif.required || notif.status === "completed") return null;
  const detected = new Date(incident.detectedAt).getTime();
  const elapsed = (now.getTime() - detected) / 3_600_000;
  const overdue = elapsed - notif.slaHours;
  return overdue > 0 ? overdue : null;
}
