import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const Uuid = z.string().min(1);

export const AI_INCIDENT_CLASSES = [
  "cross_tenant_retrieval_leak",
  "prompt_injection_bypass",
  "production_eval_regression",
  "cost_runaway",
  "refused_op_ui_bypass_attempt",
  "refusal_copy_regression",
] as const;
export type AiIncidentClass = (typeof AI_INCIDENT_CLASSES)[number];

export const AI_INCIDENT_SEVERITY: Readonly<Record<AiIncidentClass, "P0" | "P1" | "P2" | "P3">> =
  Object.freeze({
    cross_tenant_retrieval_leak: "P0",
    prompt_injection_bypass: "P1",
    production_eval_regression: "P1",
    cost_runaway: "P2",
    refused_op_ui_bypass_attempt: "P2",
    refusal_copy_regression: "P3",
  });

export const AI_INCIDENT_RESPONSES: Readonly<Record<AiIncidentClass, string>> = Object.freeze({
  cross_tenant_retrieval_leak:
    "Disable retrieval globally; investigate; notify affected tenants within 24h",
  prompt_injection_bypass: "Disable affected tools temporarily; reproduce; patch + eval",
  production_eval_regression: "Rollback to prior version; investigate",
  cost_runaway: "Pause agent for that tenant; investigate; communicate",
  refused_op_ui_bypass_attempt: "Audit + alert; verify defense-in-depth holds",
  refusal_copy_regression: "Patch template; redeploy; no further action",
});

export const AiIncidentSchema = z.object({
  id: Uuid,
  class: z.enum(AI_INCIDENT_CLASSES),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  detectedAt: Iso8601,
  containedAt: Iso8601.nullable().default(null),
  resolvedAt: Iso8601.nullable().default(null),
  affectedTenantIds: z.array(Uuid).default([]),
  triggeringConversationId: z.string().min(1).nullable().default(null),
  triggeringEvalCaseId: z.string().min(1).nullable().default(null),
  notificationStatus: z
    .enum(["not_required", "pending", "in_progress", "completed"])
    .default("not_required"),
  postMortemPath: z.string().min(1).optional(),
  rootCause: z.string().optional(),
});
export type AiIncident = z.infer<typeof AiIncidentSchema>;

export function severityFor(klass: AiIncidentClass): "P0" | "P1" | "P2" | "P3" {
  return AI_INCIDENT_SEVERITY[klass];
}

export function recommendedResponse(klass: AiIncidentClass): string {
  return AI_INCIDENT_RESPONSES[klass];
}

export function requiresPublicDisclosure(severity: "P0" | "P1" | "P2" | "P3"): boolean {
  return severity === "P0" || severity === "P1";
}
