import { z } from "zod";
import { INCIDENT_CATEGORIES, SEVERITIES } from "@crossengin/incident-response";
import { AlertPolicySchema } from "@crossengin/observability";

export const IntegrityEscalationConfigSchema = z
  .object({
    /**
     * Defaults to `sev1`. A `compromised` verdict cannot fire on benign state — `unproven`
     * exists precisely to absorb rows that are merely unanchored — so it means the audit
     * trail was *provably* altered. Until the blast radius is known no audit record can be
     * trusted, and on a platform selling SOC 2 / HIPAA that is an all-hands event with a
     * regulatory clock attached. The low false-positive rate is what earns the severity.
     */
    severity: z.enum(SEVERITIES).default("sev1"),
    /** `security` rather than `data_integrity`: the subverted thing is a security control. */
    category: z.enum(INCIDENT_CATEGORIES).default("security"),
    declaredBy: z.string().min(1).default("operate-server"),
    /** Routes the page by severity. Required — escalation with nowhere to page is not escalation. */
    alertPolicy: AlertPolicySchema,
  })
  .strict();
export type IntegrityEscalationConfig = z.infer<typeof IntegrityEscalationConfigSchema>;
