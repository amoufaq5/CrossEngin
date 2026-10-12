import { z } from "zod";
import { INCIDENT_CATEGORIES, SEVERITIES } from "@crossengin/incident-response";
import { AlertPolicySchema } from "@crossengin/observability";
// The real defect vocabulary, imported rather than mirrored: these are the names
// `verifyStoredEvidence` produces, and a config keyed by a copy of them would drift the moment a
// defect is added or renamed — which is the one way a severity override can silently stop applying.
import { EVIDENCE_DEFECTS } from "@crossengin/tenant-lifecycle-pg";

/**
 * Escalation for the two deletion-evidence findings the forensic chain cannot raise (ADR-0324).
 *
 * Four of the same fields as `IntegrityEscalationConfigSchema`, and deliberately a sibling rather
 * than a reuse: the defaults carry different reasoning, and a deployment should be able to page a
 * different rotation for "a tenant's erasure proof does not verify" than for "the audit chain is
 * broken". `severityByDefect` is the fifth, and has no counterpart there — an integrity verdict is
 * one word, while an evidence finding names which of four things is wrong with the record.
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
    /**
     * Per-defect grading, overriding `severity` for the defects it names (ADR-0324's first open
     * question). An `unwitnessed` tombstone can plausibly be a row written outside the pipeline;
     * a rewritten scope cannot be anything but a tamper. Grading both `sev1` was honest about the
     * uncertainty and dishonest about the difference.
     *
     * The key schema is the real enum, so a typo'd defect name is a **parse error** rather than an
     * override that quietly never matches and leaves the finding at the default `sev1`. A partial
     * map is the point: an unnamed defect keeps `severity`.
     */
    severityByDefect: z.record(z.enum(EVIDENCE_DEFECTS), z.enum(SEVERITIES)).optional(),
    /**
     * The grade a **stalled tombstone sweep** is declared at. Defaults to `sev2`, and the default is
     * the decision rather than a convenience.
     *
     * `AlertPolicy` maps a severity to a channel set, so the grade *is* the route (ADR-0326) — and
     * choosing `sev2` is choosing **not** to wake the rotation that receives tamper findings. The
     * two are different kinds of claim: `severity` above is for a *detected* falsified Article 17
     * proof, a fact in hand about a named record, while a stall concludes nothing about any row and
     * persists for exactly as long as its cause does. Paging the sev1 rotation for it would put a
     * standing misconfiguration beside a confirmed tamper on one board, which is how the board stops
     * being read — the same dishonesty `severityByDefect` exists to undo, one level up.
     *
     * A grade it cannot parse is a **parse error**, not a fall-back to the default: that is
     * `severityByDefect`'s rule, for the sharper reason here that there is one value rather than a
     * map, so a silently-ignored typo would route *every* stall to the configured `severity` — the
     * tamper rotation — which is precisely the outcome this field exists to avoid.
     */
    sweepStallSeverity: z.enum(SEVERITIES).default("sev2"),
    declaredBy: z.string().min(1).default("operate-server"),
    /** Required — escalation with nowhere to page is not escalation (ADR-0288's rule). */
    alertPolicy: AlertPolicySchema,
  })
  .strict();
export type DeletionEscalationConfig = z.infer<typeof DeletionEscalationConfigSchema>;
