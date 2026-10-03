import { z } from "zod";
import { INCIDENT_CATEGORIES, SEVERITIES } from "@crossengin/incident-response";
import { AlertPolicySchema } from "@crossengin/observability";

/**
 * Escalation for the two deletion-evidence findings the forensic chain cannot raise (ADR-0324).
 *
 * The same four fields as `IntegrityEscalationConfigSchema`, and deliberately a sibling rather than
 * a reuse: the defaults carry different reasoning, and a deployment should be able to page a
 * different rotation for "a tenant's erasure proof does not verify" than for "the audit chain is
 * broken".
 */
export const DeletionEscalationConfigSchema = z
  .object({
    /**
     * Defaults to `sev1`. `evidence_unverified` cannot fire on benign state — a tombstone that is
     * merely old reads as `matchesAttestations: null` and passes (ADR-0323) — so it means a stored
     * Article 17 proof was *provably* altered, or was never witnessed by the chain. The record it
     * breaks is the one a regulator would be shown.
     */
    severity: z.enum(SEVERITIES).default("sev1"),
    /**
     * `security`, matching the integrity escalator's reasoning rather than `compliance`: the thing
     * subverted is a tamper-evidence control, and what the compliance consequence turns out to be
     * depends on an investigation this declaration is the start of.
     */
    category: z.enum(INCIDENT_CATEGORIES).default("security"),
    declaredBy: z.string().min(1).default("operate-server"),
    /** Required — escalation with nowhere to page is not escalation (ADR-0288's rule). */
    alertPolicy: AlertPolicySchema,
  })
  .strict();
export type DeletionEscalationConfig = z.infer<typeof DeletionEscalationConfigSchema>;
