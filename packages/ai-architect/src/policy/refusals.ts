import { z } from "zod";

export const HARD_REFUSALS = [
  "disable_audit_on_pack_bound_entity",
  "reduce_audit_retention_below_pack_minimum",
  "grant_cross_tenant_access",
  "weaken_encryption_below_pack_minimum",
  "disable_mfa_on_part11_transitions",
  "bypass_preview_for_apply",
  "disable_audit_log_globally",
  "apply_manifest_failing_pack_validation",
  "grant_ai_architect_direct_db_access",
  "ai_architect_self_elevate",
  "disable_cost_telemetry",
  "disable_eval_suite_gate",
] as const;
export type HardRefusal = (typeof HARD_REFUSALS)[number];

export const HardRefusalSchema = z.enum(HARD_REFUSALS);

export const HARD_REFUSAL_CITATIONS: Readonly<Record<HardRefusal, string>> = Object.freeze({
  disable_audit_on_pack_bound_entity: "ADR-0025 §Layer 3; pack: 21-cfr-part-11",
  reduce_audit_retention_below_pack_minimum: "21 CFR §11.10(e); HIPAA §164.316(b)(2)(i)",
  grant_cross_tenant_access: "ADR-0002 §Tenant isolation",
  weaken_encryption_below_pack_minimum: "ADR-0009 §Encryption",
  disable_mfa_on_part11_transitions: "21 CFR §11.10(g); §11.200",
  bypass_preview_for_apply: "ADR-0005 §previewManifestApply gate",
  disable_audit_log_globally: "ADR-0008 §Audit immutability",
  apply_manifest_failing_pack_validation: "ADR-0012 §Pack validation",
  grant_ai_architect_direct_db_access: "ADR-0005 §Kernel-mediated mutations",
  ai_architect_self_elevate: "ADR-0025 §Layer 3",
  disable_cost_telemetry: "ADR-0006 §Cost telemetry",
  disable_eval_suite_gate: "ADR-0023 §Eval gate",
});

export const REQUESTER_PRINCIPALS = [
  "tenant_user",
  "tenant_admin",
  "ai_architect",
  "crossengin_staff",
  "system",
] as const;
export type RequesterPrincipal = (typeof REQUESTER_PRINCIPALS)[number];

export const RefusalRequestSchema = z.object({
  refusal: HardRefusalSchema,
  requester: z.enum(REQUESTER_PRINCIPALS),
  tenantId: z.string().min(1),
  attemptedAt: z.string().datetime({ offset: true }),
  rationale: z.string().min(1).optional(),
  proposedScope: z.string().min(1).optional(),
});
export type RefusalRequest = z.infer<typeof RefusalRequestSchema>;

export const RefusalDecisionSchema = z.object({
  refused: z.literal(true),
  refusal: HardRefusalSchema,
  citation: z.string().min(1),
  message: z.string().min(1),
  alternativePath: z.string().min(1).optional(),
  auditSeverity: z.literal("P0"),
});
export type RefusalDecision = z.infer<typeof RefusalDecisionSchema>;

export function evaluateRefusal(
  request: RefusalRequest,
  options?: { readonly alternative?: string },
): RefusalDecision {
  const citation = HARD_REFUSAL_CITATIONS[request.refusal];
  const subject = subjectFor(request.refusal);
  const message = `${subject} is forbidden by platform policy and cannot be overridden by any principal. See ${citation}.`;
  return {
    refused: true,
    refusal: request.refusal,
    citation,
    message,
    ...(options?.alternative !== undefined ? { alternativePath: options.alternative } : {}),
    auditSeverity: "P0",
  };
}

function subjectFor(refusal: HardRefusal): string {
  switch (refusal) {
    case "disable_audit_on_pack_bound_entity":
      return "Disabling audit on a compliance-pack-bound entity";
    case "reduce_audit_retention_below_pack_minimum":
      return "Reducing audit retention below a pack-mandated minimum";
    case "grant_cross_tenant_access":
      return "Granting any form of cross-tenant access";
    case "weaken_encryption_below_pack_minimum":
      return "Weakening encryption below a pack-mandated minimum";
    case "disable_mfa_on_part11_transitions":
      return "Disabling MFA on 21 CFR Part 11 transitions";
    case "bypass_preview_for_apply":
      return "Applying a manifest without an unforged preview token";
    case "disable_audit_log_globally":
      return "Disabling the audit log";
    case "apply_manifest_failing_pack_validation":
      return "Applying a manifest that fails compliance-pack validation";
    case "grant_ai_architect_direct_db_access":
      return "Granting the AI Architect principal direct database access";
    case "ai_architect_self_elevate":
      return "Granting the AI Architect any role or permission to itself";
    case "disable_cost_telemetry":
      return "Disabling cost telemetry";
    case "disable_eval_suite_gate":
      return "Skipping the eval suite for a prompt or model change";
  }
}

export interface RefusalAttemptRecord {
  readonly refusal: HardRefusal;
  readonly requester: RequesterPrincipal;
  readonly tenantId: string;
  readonly attemptedAt: string;
  readonly source: "manifest_apply" | "kernel_api" | "agent_loop";
}

export const REFUSAL_AUDIT_RETENTION_YEARS = 7;
