import {
  tombstoneMatchesAttestations,
  verifyTombstoneHashes,
  type GdprDeletionRequest,
} from "@crossengin/tenant-lifecycle";

import { isAnchoredByChain } from "./deletion-pipeline.js";
import type { PostgresDeletionRequestStore } from "./deletion-request-store.js";
import {
  TOMBSTONE_SCAN_MAX_LIMIT,
  type PostgresTombstoneStore,
  type StoredTombstone,
} from "./tombstone-store.js";

/**
 * Resolving a deletion request that a run left `in_progress`, from evidence rather than from a guess.
 *
 * ADR-0321 built the handle and named what it did not finish: a run that threw something other than
 * the pipeline's own refusal leaves the request `in_progress` forever, because *that process* cannot
 * know whether the deletion committed and re-running on an assumption is how a tenant gets deleted
 * twice. `dueForExecution` only looks at `verified`, so such a request is then never seen again by
 * anything, and an operator resolves it by hand in SQL.
 *
 * **The evidence settles it, and this is the whole decision.** The pipeline writes the tombstone in
 * the *same transaction* as the `DROP SCHEMA` (ADR-0319), and ADR-0321 put the request's id on the
 * tombstone as `relatedDeletionRequestId`. Therefore:
 *
 *   **a tombstone naming the request exists ⟺ that request's deletion committed.**
 *
 * So nothing here infers from the tenant's schema being absent, or from a log line, or from how long
 * ago the run was: it asks the tombstone table one question. A process that died between the commit
 * and the status write left the answer behind in the database.
 *
 * **Presence and absence are not symmetric, and that asymmetry is the second decision.** A tombstone
 * is conclusive the moment it exists, at any age — recording a deletion that demonstrably happened
 * destroys nothing. An *absence* is only an inference, because "not committed" and "not committed
 * yet" look identical: a pipeline still running right now has written no tombstone either. So
 * `never_committed` is gated behind a staleness window, is never applied automatically, and is
 * reported as a distinct verdict so a caller can see it is reasoning from silence.
 *
 * The same shape as ADR-0315's two answers to "what if we cannot tell?" — each correct for its
 * position, and deliberately not reconciled into one rule.
 */

export const RECONCILIATION_VERDICTS = [
  /** Exactly one tombstone names the request: the deletion committed. Conclusive at any age. */
  "completed_by_evidence",
  /**
   * No tombstone names it and it has been stranded longer than the window, so the transaction did
   * not commit and the tenant is untouched. An inference from absence, not evidence.
   */
  "never_committed",
  /**
   * More than one tombstone names it. The premise above is broken, so nothing is chosen — two
   * deletions of one tenant is a finding, not a row to pick from.
   */
  "ambiguous_evidence",
  /** Stranded for less than the window and no tombstone: a run may still be in flight. */
  "too_recent",
  /**
   * A tombstone names the request and does **not** stand up — its hashes disagree with its content,
   * its scope disagrees with the attestations stored beside it, or nothing in the chain witnesses it.
   * Never applied: the request's `completionSha256` is the platform's claim about a proof, and
   * copying a digest off a record that fails verification launders the defect into a second row.
   */
  "evidence_unverified",
  /** Not `in_progress` at all, so there is nothing to reconcile. */
  "not_stranded",
] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

/**
 * Why a stored tombstone does not stand up.
 *
 * `scope_tampered` is the one the forensic chain **cannot** catch, and it is the reason this check
 * exists at all. The chain entry commits to the two digests and the identity, never the scope
 * (ADR-0318, deliberately — a scope can name every table a tenant held and every integrity pass
 * rereads the chain). And `proofSha256` commits to `contentManifestSha256` rather than to the scope
 * itself. So editing a stored row's `scope` column leaves `proofOk` true and the chain intact:
 * `contentManifestOk` and `tombstoneMatchesAttestations` are the only two things in the system that
 * can see it.
 */
export const EVIDENCE_DEFECTS = [
  /**
   * `contentManifestSha256` does not match what the record's own proof version says it covers.
   *
   * The name is narrower than the check and stays that way. The digest commits to the manifest as a
   * whole, so `contentManifestOk` is one boolean over everything that version signs: the scope, plus
   * whatever keys that tag added to it — `PROOF_VERSION_COVERAGE` is where that set is written down,
   * and each tag has added one (ADR-0329's capability declaration, ADR-0331's retention claim,
   * ADR-0351's record-storage declaration). It cannot say *which* key moved, so splitting this per
   * key would mean reporting a distinction nothing can make — and the count of keys is deliberately
   * not restated here, because a number in this comment goes stale on the next tag.
   */
  "scope_tampered",
  /** `proofSha256` does not match the record's own identity and manifest digest. */
  "proof_mismatch",
  /** The scope disagrees with the attestations stored beside it. */
  "scope_disagrees_with_attestations",
  /** No chain entry witnesses it, or the record does not commit to the one that does. */
  "unwitnessed",
] as const;
export type EvidenceDefect = (typeof EVIDENCE_DEFECTS)[number];

export interface EvidenceCheck {
  readonly ok: boolean;
  readonly defects: readonly EvidenceDefect[];
  /**
   * `null` when the row carries no attestations to compare against — "cannot say" rather than
   * "disagrees" (ADR-0318's habit). It does **not** disqualify: the hashes still establish that the
   * record is internally intact and commits to its own scope, which is what completing a *request*
   * needs. A row with no evidence beside it predates `attestations` or was not written by the
   * pipeline, and that is worth seeing without stranding the request over it.
   */
  readonly matchesAttestations: boolean | null;
}

/**
 * Whether a stored tombstone stands up well enough to close a GDPR request against it.
 *
 * Pure, and computed from the record already in hand rather than through `store.verify` — which
 * re-reads the row, so the digest written to the request could differ from the one that was checked.
 */
export function verifyStoredEvidence(stored: StoredTombstone): EvidenceCheck {
  const hashes = verifyTombstoneHashes(stored.record);
  const matchesAttestations =
    stored.attestations.length === 0
      ? null
      : tombstoneMatchesAttestations(stored.record, stored.attestations);
  const defects: EvidenceDefect[] = [];
  if (!hashes.contentManifestOk) defects.push("scope_tampered");
  if (!hashes.proofOk) defects.push("proof_mismatch");
  if (matchesAttestations === false) defects.push("scope_disagrees_with_attestations");
  // A tombstone nothing witnessed is a row, not a proof: without the chain entry anybody with write
  // access to the table could have inserted it. `isAnchoredByChain` is the stronger question than
  // "is `chain_entry_hash` set" — it also requires the record's own anchors to name that entry, so a
  // column set without the record committing to it does not pass.
  if (!isAnchoredByChain(stored)) defects.push("unwitnessed");
  return { ok: defects.length === 0, defects, matchesAttestations };
}

/**
 * Whether a stored tombstone is worth reporting, and the sentence that says why.
 *
 * **One rule, one place.** The sweep's `continue` and the targeted `verifyTombstone` have to agree
 * exactly, because the second is what a caller holds up to close an episode the first opened — a
 * targeted check that was stricter would never close anything, and one that was laxer would close an
 * episode whose finding still stands. So the condition lives here and both read it.
 *
 * A `dangling` reference is not an `EvidenceDefect`: the proof itself is intact and the row it names
 * is gone. It is reported all the same, because a request row deleted out from under a proof is the
 * one thing no other direction of the audit can see.
 */
export type TombstoneStanding =
  | { readonly ok: true; readonly detail: null }
  | { readonly ok: false; readonly detail: string };

export function tombstoneStanding(
  reference: TombstoneReferenceState,
  relatedDeletionRequestId: string | null,
  check: EvidenceCheck,
): TombstoneStanding {
  const parts: string[] = [];
  if (!check.ok) parts.push(`does not verify: ${check.defects.join(", ")}`);
  if (reference === "dangling") {
    parts.push(`names deletion request ${relatedDeletionRequestId ?? ""}, which does not exist`);
  }
  return parts.length === 0 ? { ok: true, detail: null } : { ok: false, detail: parts.join("; ") };
}

/** Verdicts whose evidence stands on its own, so applying them needs no operator judgement. */
export function isConclusive(verdict: ReconciliationVerdict): boolean {
  return verdict === "completed_by_evidence";
}

/** Verdicts a human has to look at. */
export function needsOperator(verdict: ReconciliationVerdict): boolean {
  return (
    verdict === "never_committed" ||
    verdict === "ambiguous_evidence" ||
    verdict === "evidence_unverified"
  );
}

/**
 * How long a request must have been `in_progress` before an absence of evidence is taken to mean
 * anything. Deliberately far longer than any pipeline run: the cost of waiting is a row that stays
 * visible on a list, and the cost of being wrong is a request marked `rejected` while its deletion
 * was still committing.
 */
export const DEFAULT_STRANDED_AFTER_MS = 3_600_000;

export interface ReconciliationResult {
  readonly requestId: string;
  readonly tenantId: string;
  readonly verdict: ReconciliationVerdict;
  /** The tombstone the evidence points at, when there is exactly one. */
  readonly tombstoneId: string | null;
  /** Every tombstone naming the request, so an ambiguous verdict can be investigated. */
  readonly tombstoneIds: readonly string[];
  /** The verification of the tombstone the evidence points at, when there is exactly one. */
  readonly evidence: EvidenceCheck | null;
  /** Whether the verdict was written to the request. */
  readonly applied: boolean;
  /** Whether the tenant row was retired as part of applying it. `null` when not attempted. */
  readonly tenantRetired: boolean | null;
  readonly strandedForMs: number;
  readonly detail: string | null;
}

export interface ReconcilerOptions {
  readonly requests: PostgresDeletionRequestStore;
  readonly tombstones: PostgresTombstoneStore;
  /**
   * Retires the tenant row. Optional: a run that died after the commit may also have died before
   * retiring the row, and reconciliation is the only thing that will ever notice.
   */
  readonly retire?: (tenantId: string) => Promise<boolean>;
  readonly strandedAfterMs?: number;
  readonly clock?: () => Date;
  readonly onReconciled?: (result: ReconciliationResult) => void;
}

/**
 * Reads the evidence for stranded requests and, where it is conclusive, records it.
 *
 * `applyNeverCommitted` is the one thing a caller may authorise that the evidence does not: marking a
 * request `rejected` because no tombstone names it. It is off by default and belongs to an operator
 * looking at the row, never to a scheduler.
 */
export class DeletionReconciler {
  private readonly opts: ReconcilerOptions;

  constructor(opts: ReconcilerOptions) {
    this.opts = opts;
  }

  private now(): Date {
    return (this.opts.clock ?? ((): Date => new Date()))();
  }

  private window(): number {
    return this.opts.strandedAfterMs ?? DEFAULT_STRANDED_AFTER_MS;
  }

  /** The verdict alone, writing nothing. */
  async assess(request: GdprDeletionRequest): Promise<ReconciliationResult> {
    return this.assessWith(request, await this.evidenceFor(request));
  }

  private async evidenceFor(request: GdprDeletionRequest): Promise<readonly StoredTombstone[]> {
    return request.status === "in_progress"
      ? this.opts.tombstones.findForRequest(request.id)
      : [];
  }

  private assessWith(
    request: GdprDeletionRequest,
    found: readonly StoredTombstone[],
  ): ReconciliationResult {
    const base = {
      requestId: request.id,
      tenantId: request.tenantId,
      evidence: null,
      applied: false,
      tenantRetired: null,
    };
    const strandedForMs =
      request.inProgressAt === null
        ? 0
        : Math.max(0, this.now().getTime() - new Date(request.inProgressAt).getTime());

    if (request.status !== "in_progress") {
      return {
        ...base,
        verdict: "not_stranded",
        tombstoneId: null,
        tombstoneIds: [],
        strandedForMs,
        detail: `status is ${request.status}`,
      };
    }

    const ids = found.map((t) => t.record.id);

    if (found.length > 1) {
      return {
        ...base,
        verdict: "ambiguous_evidence",
        tombstoneId: null,
        tombstoneIds: ids,
        strandedForMs,
        detail: `${found.length.toString()} tombstones name this request`,
      };
    }
    const only = found[0];
    if (only !== undefined) {
      const check = verifyStoredEvidence(only);
      if (!check.ok) {
        // The deletion did commit — the row is here — but this record cannot be used to close the
        // request, because the request's `completionSha256` is the platform's claim about a proof.
        // Reported, never applied: a human has a tampered or unwitnessed tombstone to deal with, and
        // that is a bigger problem than a request stuck `in_progress`.
        return {
          ...base,
          verdict: "evidence_unverified",
          evidence: check,
          tombstoneId: only.record.id,
          tombstoneIds: ids,
          strandedForMs,
          detail: `tombstone ${only.record.id} does not verify: ${check.defects.join(", ")}`,
        };
      }
      // Conclusive, and conclusive immediately: the tombstone and the drop committed together, so its
      // existence is not a hint about what probably happened.
      return {
        ...base,
        verdict: "completed_by_evidence",
        evidence: check,
        tombstoneId: only.record.id,
        tombstoneIds: ids,
        strandedForMs,
        detail: null,
      };
    }
    if (strandedForMs < this.window()) {
      return {
        ...base,
        verdict: "too_recent",
        tombstoneId: null,
        tombstoneIds: [],
        strandedForMs,
        detail: `stranded for ${strandedForMs.toString()}ms; the window is ${this.window().toString()}ms`,
      };
    }
    return {
      ...base,
      verdict: "never_committed",
      tombstoneId: null,
      tombstoneIds: [],
      strandedForMs,
      detail: "no tombstone names this request, so its transaction did not commit",
    };
  }

  /**
   * Assesses one request and writes the verdict where it may.
   *
   * `completed_by_evidence` is applied whatever the caller asked, because it is a record of something
   * that already happened and withholding it leaves a deleted tenant's request reading `in_progress`.
   */
  async reconcileOne(
    request: GdprDeletionRequest,
    opts: { readonly applyNeverCommitted?: boolean } = {},
  ): Promise<ReconciliationResult> {
    const found = await this.evidenceFor(request);
    const assessed = this.assessWith(request, found);
    const only = found[0];
    if (assessed.verdict === "completed_by_evidence" && only !== undefined) {
      return this.report(await this.applyCompleted(request, assessed, only));
    }
    if (assessed.verdict === "never_committed" && opts.applyNeverCommitted === true) {
      await this.opts.requests.transition(request.id, "rejected", {
        at: this.now().toISOString(),
        rejectedReason: `reconciled: ${assessed.detail ?? "no tombstone"}`.slice(0, 500),
      });
      return this.report({ ...assessed, applied: true });
    }
    return this.report(assessed);
  }

  private async applyCompleted(
    request: GdprDeletionRequest,
    assessed: ReconciliationResult,
    evidence: StoredTombstone,
  ): Promise<ReconciliationResult> {
    await this.opts.requests.transition(request.id, "completed", {
      at: this.now().toISOString(),
      // Both off the tombstone itself, never recomputed: the digest a completed request commits to
      // has to be the one the stored proof carries, or the join ADR-0321 added is a lie.
      tombstoneId: evidence.record.id,
      completionSha256: evidence.record.proofSha256,
    });
    // A run that died after the commit may also have died before retiring the row, and nothing else
    // will ever notice — the deletion is not in any queue any more.
    const retired = this.opts.retire === undefined ? null : await this.retireQuietly(request.tenantId);
    return { ...assessed, applied: true, tenantRetired: retired };
  }

  private async retireQuietly(tenantId: string): Promise<boolean | null> {
    try {
      return (await this.opts.retire?.(tenantId)) ?? null;
    } catch {
      // The request is already recorded `completed` against a real tombstone; failing the whole
      // reconciliation over the row's status would undo the part that was worth doing.
      return null;
    }
  }

  /**
   * Reconciles every `in_progress` request. Conclusive verdicts only.
   *
   * Deliberately **not** filtered to the staleness window: the window governs the *inference from
   * absence*, not the listing. A request whose pipeline committed and whose status write then failed
   * is conclusive immediately, and that is the case worth fixing promptly — ADR-0321's
   * `completed_unrecorded`. A request still being worked right now appears here too and comes back
   * `too_recent`, which writes nothing.
   */
  async reconcileStranded(limit = 25): Promise<readonly ReconciliationResult[]> {
    const stranded = await this.opts.requests.stranded(this.now().toISOString(), limit);
    const results: ReconciliationResult[] = [];
    for (const request of stranded) {
      results.push(await this.reconcileOne(request));
    }
    return results;
  }

  /**
   * The other direction: `completed` requests whose proof no longer stands up.
   *
   * ADR-0322 closed the stranded case and left this one open — a request completed against a
   * tombstone that has since been deleted or edited was found by nothing, because reconciliation only
   * ever looked at `in_progress`. A completed request is the platform's standing claim that an
   * Article 17 erasure was carried out and can be evidenced; this is the audit of that claim.
   *
   * Returns **only** the findings. A listing of every completed request grows without bound and says
   * nothing; "which completed deletions can no longer be proven" is a page an operator can act on.
   */
  async auditCompleted(limit = 100): Promise<readonly EvidenceAudit[]> {
    const completed = await this.opts.requests.completedWithTombstone(limit);
    const findings: EvidenceAudit[] = [];
    for (const request of completed) {
      const named = request.tombstoneId;
      if (named === null) continue; // The contract forbids it; the store would have refused the row.
      const stored = await this.opts.tombstones.read(named);
      if (stored === null) {
        findings.push({
          requestId: request.id,
          tenantId: request.tenantId,
          tombstoneId: named,
          present: false,
          digestMatches: false,
          check: null,
          detail: "the tombstone this request was completed against no longer exists",
        });
        continue;
      }
      const check = verifyStoredEvidence(stored);
      // A third question the stranded path never has to ask: the request carries its own copy of the
      // digest, so the two can disagree even when both records are internally intact.
      const digestMatches = request.completionSha256 === stored.record.proofSha256;
      if (check.ok && digestMatches) continue;
      findings.push({
        requestId: request.id,
        tenantId: request.tenantId,
        tombstoneId: named,
        present: true,
        digestMatches,
        check,
        detail: digestMatches
          ? `tombstone does not verify: ${check.defects.join(", ")}`
          : "the request's completionSha256 does not match the tombstone's proof",
      });
    }
    return findings;
  }

  /**
   * The third direction: every tombstone, whether or not anything names it.
   *
   * Both other directions start from a *request* — `reconcileStranded` walks `in_progress` ones and
   * `auditCompleted` walks `completed` ones — so a tombstone written by the synchronous deletion
   * route of ADR-0320 is examined by neither, because it has no request at all. That is not a small
   * gap: `verifyStoredEvidence` is the **only** detector for a tampered `scope`, since `proofSha256`
   * commits to `contentManifestSha256` and the chain entry commits to the two digests and the
   * identity — **neither commits to the scope** (ADR-0323). For these tombstones nothing looked.
   *
   * **Findings only, and this one writes nothing at all.** ADR-0323 established that
   * `evidence_unverified` is a verdict nothing may apply — not a scheduler and not an operator —
   * because `acceptNeverCommitted` authorises an inference from an *absence* of evidence and says
   * nothing about a record that lies. A sweep that found a tampered scope has even less standing
   * than that: it starts from no request, so there is nothing whose status it could be right about,
   * and the only honest act is to report the row.
   */
  async auditTombstones(
    input: { readonly limit?: number; readonly afterTombstoneId?: string | null } = {},
  ): Promise<TombstoneAuditPage> {
    // Clamped to the store's own cap, not merely floored: asking for more than the store will serve
    // yields a short page, and a short page is how this reports the end of the table.
    const limit = Math.max(
      1,
      Math.min(TOMBSTONE_SCAN_MAX_LIMIT, Math.trunc(input.limit ?? DEFAULT_TOMBSTONE_AUDIT_LIMIT)),
    );
    const page = await this.opts.tombstones.scanAll({
      limit,
      afterTombstoneId: input.afterTombstoneId ?? null,
    });
    const findings: TombstoneAudit[] = [];
    for (const stored of page) {
      const named = stored.record.relatedDeletionRequestId ?? null;
      const reference = await this.referenceStateOf(named);
      const check = verifyStoredEvidence(stored);
      // Every defect is reported, **including** on a tombstone a request names, rather than leaving
      // the referenced ones to `auditCompleted`. Suppressing them would be wrong twice over: that
      // direction walks only `status = 'completed'` requests under its own limit, so a tombstone
      // whose request sits `in_progress`, `rejected` or `deferred` would fall through both; and it
      // would make this sweep's coverage depend on another sweep's filter. A duplicate finding is
      // noise a caller can drop on the tombstone id — a missed one is not recoverable at all.
      const standing = tombstoneStanding(reference, named, check);
      if (standing.ok) continue;
      findings.push({
        tombstoneId: stored.record.id,
        tenantId: stored.record.tenantId,
        reference,
        relatedDeletionRequestId: named,
        check,
        detail: standing.detail,
      });
    }
    const last = page[page.length - 1];
    return {
      // What this call actually verified, never what it hoped to: "we examined 4,000 and found
      // nothing" is a claim an auditor can be given, and it cannot be made from the absence of a
      // log line (ADR-0323).
      examined: page.length,
      findings,
      // A page shorter than the limit is the end of the table, not a boundary — a cursor here would
      // make the caller ask again for nothing, forever.
      nextAfterTombstoneId: page.length < limit || last === undefined ? null : last.record.id,
    };
  }

  /**
   * How a tombstone is reached. At most one lookup, and none for an unreferenced one — the majority
   * case the sweep exists for.
   */
  private async referenceStateOf(
    relatedDeletionRequestId: string | null,
  ): Promise<TombstoneReferenceState> {
    if (relatedDeletionRequestId === null) return "unreferenced";
    return (await this.opts.requests.read(relatedDeletionRequestId)) === null
      ? "dangling"
      : "referenced";
  }

  /**
   * One tombstone, asked about by id: does it exist, does it stand up **now**, and how is it reached.
   *
   * The sweep cannot answer this. It covers one page per tick and laps, so a page that came back
   * clean says nothing about any particular row — the row may simply not have been on it. That is why
   * ADR-0328 left `onTombstoneResolved` without a caller: closing an escalated episode needs evidence
   * about *that* tombstone, and the only thing a clean page establishes is a count.
   *
   * **What a caller is entitled to conclude.** On `verified`: this row exists and the sweep would
   * report nothing for it, so an episode opened against this tombstone may be closed — this is the
   * proof `onTombstoneResolved` asks for. On `unverified`: the finding still stands, with `check` and
   * `reference` saying which of the two reasons it is. On `absent`: **nothing may be closed**. A
   * tombstone that is gone is not a tombstone that verifies; it is the Article 17 proof itself having
   * been deleted, which is a worse fact than a tampered scope and the one a naive "it no longer
   * appears in the findings" check would read as recovery.
   *
   * A caller is **not** entitled to conclude anything about the tenant's data from any of the three:
   * this reads the proof, not what the proof is about.
   *
   * Writes nothing, like its sibling. ADR-0323's rule is that `evidence_unverified` is a verdict
   * nothing may apply; a lookup by id has even less standing than a sweep, because a caller chose the
   * row.
   */
  async verifyTombstone(tombstoneId: string): Promise<TombstoneVerification> {
    const stored = await this.opts.tombstones.read(tombstoneId);
    if (stored === null) {
      return {
        tombstoneId,
        outcome: "absent",
        tenantId: null,
        reference: null,
        relatedDeletionRequestId: null,
        check: null,
        detail: "no tombstone with this id is stored",
      };
    }
    const named = stored.record.relatedDeletionRequestId ?? null;
    const reference = await this.referenceStateOf(named);
    const check = verifyStoredEvidence(stored);
    const standing = tombstoneStanding(reference, named, check);
    return {
      tombstoneId: stored.record.id,
      outcome: standing.ok ? "verified" : "unverified",
      tenantId: stored.record.tenantId,
      reference,
      relatedDeletionRequestId: named,
      check,
      detail: standing.detail,
    };
  }

  private report(result: ReconciliationResult): ReconciliationResult {
    this.opts.onReconciled?.(result);
    return result;
  }
}

/** One finding from `auditCompleted`: a completed request whose proof no longer stands up. */
export interface EvidenceAudit {
  readonly requestId: string;
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly present: boolean;
  readonly digestMatches: boolean;
  /** `null` when the tombstone is gone, so there was nothing to check. */
  readonly check: EvidenceCheck | null;
  readonly detail: string;
}

/**
 * How a tombstone is reached, which is an operational fact distinct from whether it verifies.
 *
 * The three are genuinely different problems and collapsing them would lose the one this direction
 * was built for: `unreferenced` is a tombstone **no other audit can see**, and `dangling` is a
 * request row deleted out from under a proof — not the same thing as never having had one.
 */
export const TOMBSTONE_REFERENCE_STATES = [
  /** No `relatedDeletionRequestId`: every tombstone the synchronous deletion route writes. */
  "unreferenced",
  /** Names a deletion request that exists. */
  "referenced",
  /** Names a deletion request that is not there. */
  "dangling",
] as const;
export type TombstoneReferenceState = (typeof TOMBSTONE_REFERENCE_STATES)[number];

/** How many tombstones one `auditTombstones` page verifies when the caller does not say. */
export const DEFAULT_TOMBSTONE_AUDIT_LIMIT = 100;

/** One finding from `auditTombstones`: a stored tombstone that does not stand up on its own terms. */
export interface TombstoneAudit {
  readonly tombstoneId: string;
  readonly tenantId: string;
  readonly reference: TombstoneReferenceState;
  readonly relatedDeletionRequestId: string | null;
  /** Always present: unlike `auditCompleted`, this direction starts from the record itself. */
  readonly check: EvidenceCheck;
  readonly detail: string;
}

export interface TombstoneAuditPage {
  /**
   * How many tombstones this page verified. The findings alone cannot say it, and "nothing was
   * found" is only a claim if the number of records looked at comes with it.
   */
  readonly examined: number;
  readonly findings: readonly TombstoneAudit[];
  /** The cursor for the next page, or `null` when the sweep reached the end of the table. */
  readonly nextAfterTombstoneId: string | null;
}

/**
 * What `verifyTombstone` can answer. Three outcomes, not two, and the third is the point.
 *
 * `absent` is a fact of its own: a proof that has been deleted is neither verified nor unverified,
 * and folding it into either would let a caller close an episode because the row it was about is no
 * longer there to fail. A row that cannot be found is the strongest finding this module has.
 */
export const TOMBSTONE_VERIFICATION_OUTCOMES = [
  /** No row holds this id. Closes nothing; the proof is gone. */
  "absent",
  /** Stored, and the sweep would report nothing for it. The only outcome that closes an episode. */
  "verified",
  /** Stored, and the sweep's finding still stands — see `check` and `reference` for which. */
  "unverified",
] as const;
export type TombstoneVerificationOutcome = (typeof TOMBSTONE_VERIFICATION_OUTCOMES)[number];

/** One targeted verification. `tenantId`, `reference` and `check` are null exactly when `absent`. */
export interface TombstoneVerification {
  /** The id asked about, which is the record's own id whenever one was found. */
  readonly tombstoneId: string;
  readonly outcome: TombstoneVerificationOutcome;
  readonly tenantId: string | null;
  /**
   * Carried rather than left for the caller to work out, because an episode's key depends on it
   * (ADR-0328): a referenced tombstone's episode is keyed on the **request** and an unreferenced
   * one's on the tombstone, so a caller that guessed would close the wrong episode or none.
   */
  readonly reference: TombstoneReferenceState | null;
  readonly relatedDeletionRequestId: string | null;
  readonly check: EvidenceCheck | null;
  /** Null exactly when `verified` — there is nothing to say about a row that stands up. */
  readonly detail: string | null;
}

/** Re-exported so a caller need not reach into the tombstone module for the one type it reads. */
export type { StoredTombstone };
