import { z } from "zod";

const Iso8601 = z.string().datetime({ offset: true });
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const EVIDENCE_ID_REGEX = /^EV-\d{4}-\d{4,8}$/;
const CUSTODY_ID_REGEX = /^COC-\d{4}-\d{4,8}$/;

export const CUSTODY_ACTIONS = [
  "collected",
  "transferred",
  "accessed",
  "analyzed",
  "duplicated",
  "redacted",
  "exported_for_review",
  "returned",
  "destroyed",
] as const;
export type CustodyAction = (typeof CUSTODY_ACTIONS)[number];
export const CustodyActionSchema = z.enum(CUSTODY_ACTIONS);

export const CUSTODY_PURPOSES = [
  "incident_investigation",
  "regulatory_inquiry",
  "litigation_preservation",
  "internal_audit",
  "security_research",
  "law_enforcement_request",
] as const;
export type CustodyPurpose = (typeof CUSTODY_PURPOSES)[number];

export const CustodyEntrySchema = z
  .object({
    id: z.string().regex(CUSTODY_ID_REGEX, {
      message: "custody entry id must match 'COC-YYYY-NNNN'",
    }),
    evidenceId: z.string().regex(EVIDENCE_ID_REGEX),
    action: CustodyActionSchema,
    purpose: z.enum(CUSTODY_PURPOSES),
    occurredAt: Iso8601,
    fromCustodianId: z.string().min(1).nullable(),
    toCustodianId: z.string().min(1),
    witnessId: z.string().min(1).nullable().default(null),
    expectedSha256: z.string().regex(SHA256_REGEX),
    verifiedSha256: z.string().regex(SHA256_REGEX),
    sealNumber: z.string().min(1).optional(),
    location: z.string().min(1),
    notes: z.string().min(1).optional(),
    signature: z.string().min(1),
    signingKeyFingerprint: z.string().regex(SHA256_REGEX),
  })
  .superRefine((v, ctx) => {
    if (v.expectedSha256 !== v.verifiedSha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifiedSha256"],
        message:
          "verifiedSha256 does not match expectedSha256 — chain of custody BROKEN (tampering suspected)",
      });
    }
    if (v.action === "collected") {
      if (v.fromCustodianId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fromCustodianId"],
          message: "action='collected' requires fromCustodianId=null (initial collection)",
        });
      }
    } else {
      if (v.fromCustodianId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fromCustodianId"],
          message: `action '${v.action}' requires fromCustodianId`,
        });
      }
      if (v.fromCustodianId === v.toCustodianId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["toCustodianId"],
          message: "fromCustodianId and toCustodianId must differ",
        });
      }
    }
    if (v.action === "transferred" && v.witnessId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["witnessId"],
        message: "action='transferred' requires a witness",
      });
    }
    if (v.witnessId !== null) {
      if (v.witnessId === v.fromCustodianId || v.witnessId === v.toCustodianId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["witnessId"],
          message: "witness must be a third party (not from/to custodian)",
        });
      }
    }
    if ((v.action === "destroyed" || v.action === "duplicated") && v.sealNumber === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sealNumber"],
        message: `action '${v.action}' requires sealNumber`,
      });
    }
  });
export type CustodyEntry = z.infer<typeof CustodyEntrySchema>;

export const CustodyChainSchema = z.array(CustodyEntrySchema).superRefine((entries, ctx) => {
  if (entries.length === 0) return;
  const evidenceId = entries[0]?.evidenceId;
  let priorTo: string | null = null;
  entries.forEach((e, i) => {
    if (e.evidenceId !== evidenceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "evidenceId"],
        message: `chain must be for a single evidence id; got mixed '${evidenceId}' and '${e.evidenceId}'`,
      });
    }
    if (i === 0) {
      if (e.action !== "collected") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "action"],
          message: "first entry must be action='collected'",
        });
      }
    } else {
      if (e.action === "collected") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "action"],
          message: "only the first entry can be action='collected'",
        });
      }
      if (e.fromCustodianId !== priorTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "fromCustodianId"],
          message: `custody gap: previous toCustodian was '${priorTo}', this entry's fromCustodian is '${e.fromCustodianId}'`,
        });
      }
    }
    priorTo = e.toCustodianId;
    if (i > 0) {
      const prev = entries[i - 1]!;
      if (new Date(e.occurredAt).getTime() < new Date(prev.occurredAt).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "occurredAt"],
          message: "custody entries must be in chronological order",
        });
      }
    }
  });
  const ids = new Set<string>();
  entries.forEach((e, i) => {
    if (ids.has(e.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "id"],
        message: `duplicate custody entry id '${e.id}'`,
      });
    }
    ids.add(e.id);
  });
});
export type CustodyChain = z.infer<typeof CustodyChainSchema>;

export function currentCustodian(chain: CustodyChain): string | null {
  const last = chain[chain.length - 1];
  if (last === undefined) return null;
  if (last.action === "destroyed") return null;
  return last.toCustodianId;
}

export function chainAgeMinutes(chain: CustodyChain, now: Date = new Date()): number | null {
  const first = chain[0];
  if (first === undefined) return null;
  return Math.floor((now.getTime() - new Date(first.occurredAt).getTime()) / 60_000);
}

export function isChainSealed(chain: CustodyChain): boolean {
  const last = chain[chain.length - 1];
  return last !== undefined && last.action === "destroyed";
}
