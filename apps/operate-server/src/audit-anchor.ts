import { canonicalAuditEntryPayload, type AuditLogEntry } from "@crossengin/auth";
import { sha256 } from "@crossengin/crypto";
import type { ChainedLogEntry } from "@crossengin/forensics";

import type { AnchoredAuditEntry } from "./audit-log-store.js";

/**
 * Why one audit row is or is not provably intact.
 *
 * - `verified` — the chain entry at the row's sequence commits to exactly this content.
 * - `unanchored` — the row carries no chain coordinates. Either it predates anchoring or it
 *   was written by a deployment with no signing key. **Not** proof of tampering, and not
 *   proof of integrity either; it is the absence of evidence, reported as such.
 * - `anchor_missing` — the row names a chain entry that is not there. Deleting the anchor is
 *   how you would try to hide an edit, so this is a finding, not a shrug.
 * - `hash_mismatch` — the chain entry exists and commits to different bytes. The row was
 *   altered after it was written, or the anchor was repointed.
 * - `anchor_repointed` — the entry at that sequence is not the one the row was written with
 *   (its `entryHash` differs), so the row is pointing at somebody else's anchor.
 */
export const AUDIT_ANCHOR_VERDICTS = [
  "verified",
  "unanchored",
  "anchor_missing",
  "hash_mismatch",
  "anchor_repointed",
] as const;
export type AuditAnchorVerdict = (typeof AUDIT_ANCHOR_VERDICTS)[number];

/** Verdicts that mean the row's integrity is *disproven*, as opposed to merely unproven. */
const TAMPERED: ReadonlySet<AuditAnchorVerdict> = new Set<AuditAnchorVerdict>([
  "anchor_missing",
  "hash_mismatch",
  "anchor_repointed",
]);

export interface AuditAnchorResult {
  readonly auditId: string;
  readonly verdict: AuditAnchorVerdict;
  readonly sequenceNumber: number | null;
}

export interface AuditAnchorReport {
  /** The scope the rows were read under; `null` is the platform chain (ADR-0331). */
  readonly tenantId: string | null;
  /** True only when nothing is disproven **and** nothing is unproven. */
  readonly ok: boolean;
  readonly checked: number;
  readonly verified: number;
  readonly unanchored: number;
  /** Rows whose integrity is disproven — the findings that matter. */
  readonly tampered: readonly AuditAnchorResult[];
  readonly results: readonly AuditAnchorResult[];
}

/**
 * Verifies each audit row against the chain entry that commits to it.
 *
 * This is the link the two audit paths were missing. The forensic chain has always been
 * hash-linked and signed, so `verifyChainFull` could prove the chain itself was untouched —
 * but nothing tied a `meta.audit_log` row to it, so a row could be rewritten and every chain
 * check would still pass. Here the row's canonical payload is recomputed and compared with
 * what its anchor committed to, which closes that gap.
 *
 * **It is one half of a proof.** This shows each row matches its anchor; `verifyChainFull`
 * shows the anchors themselves are linked and signed. Run both — a chain whose entries were
 * forged wholesale would satisfy this check alone, because the forged entry would commit to
 * the forged row.
 */
export function verifyAuditAnchors(
  tenantId: string | null,
  rows: readonly AnchoredAuditEntry[],
  chain: readonly ChainedLogEntry[],
): AuditAnchorReport {
  const bySequence = new Map<number, ChainedLogEntry>();
  for (const entry of chain) bySequence.set(entry.sequenceNumber, entry);

  const results: AuditAnchorResult[] = [];
  for (const { entry, anchor } of rows) {
    results.push({
      auditId: entry.id,
      verdict: verdictFor(entry, anchor, bySequence),
      sequenceNumber: anchor?.sequenceNumber ?? null,
    });
  }

  const tampered = results.filter((r) => TAMPERED.has(r.verdict));
  const verified = results.filter((r) => r.verdict === "verified").length;
  const unanchored = results.filter((r) => r.verdict === "unanchored").length;
  return {
    tenantId,
    ok: tampered.length === 0 && unanchored === 0,
    checked: results.length,
    verified,
    unanchored,
    tampered,
    results,
  };
}

function verdictFor(
  entry: AuditLogEntry,
  anchor: AnchoredAuditEntry["anchor"],
  bySequence: ReadonlyMap<number, ChainedLogEntry>,
): AuditAnchorVerdict {
  if (anchor === null) return "unanchored";
  const chainEntry = bySequence.get(anchor.sequenceNumber);
  if (chainEntry === undefined) return "anchor_missing";
  // Checked before the payload: a row pointing at a different entry than the one it was
  // written with is a repointing, and saying "hash mismatch" would describe it wrongly.
  if (chainEntry.entryHash !== anchor.entryHash) return "anchor_repointed";
  const expected = sha256(canonicalAuditEntryPayload(entry));
  return chainEntry.payloadSha256 === expected ? "verified" : "hash_mismatch";
}

export function formatAuditAnchorReport(report: AuditAnchorReport): string {
  const lines: string[] = [
    `audit anchors for ${report.tenantId === null ? "the platform" : `tenant ${report.tenantId}`}` +
      `: ${report.ok ? "OK" : "FAILED"}`,
    `  checked: ${report.checked.toString()}` +
      `  verified: ${report.verified.toString()}` +
      `  unanchored: ${report.unanchored.toString()}` +
      `  tampered: ${report.tampered.length.toString()}`,
  ];
  for (const t of report.tampered) {
    const seq = t.sequenceNumber === null ? "-" : t.sequenceNumber.toString();
    lines.push(`  ${t.verdict}: audit ${t.auditId} (chain sequence ${seq})`);
  }
  return lines.join("\n");
}
