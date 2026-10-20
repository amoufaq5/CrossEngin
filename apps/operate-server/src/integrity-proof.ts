import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  type ChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection, UnreadableRow } from "@crossengin/kernel-pg";

import {
  anchorAuditHasFindings,
  auditAnchors,
  formatAnchorAudit,
  type AnchorAuditReport,
} from "./anchor-audit.js";
import { verifyAuditAnchors, type AuditAnchorReport } from "./audit-anchor.js";
import { IntegrityEscalationConfigSchema } from "./integrity-escalation-config.js";
import { PostgresAuditEmitter } from "./audit-log-store.js";
import {
  verifyChainFromCheckpoint,
  verifyChainFull,
  type ChainVerificationReport,
} from "./chain-verify.js";
import {
  PostgresIntegrityVerdictStore,
  integrityVerdictInputFor,
} from "./integrity-verdict-store.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export const IntegrityProofConfigSchema = z
  .object({
    schema: z.string().regex(SCHEMA_RE).default("meta"),
    intervalMs: z.number().int().positive().default(3_600_000),
    /** Actor recorded on the verdict chain entry. */
    verifiedBy: z.string().min(1).default("operate-server"),
    tenants: z.array(z.string().uuid()).default([]),
    /**
     * Also prove the platform chain — both halves, since ADR-0331 gave it audit rows.
     *
     * **Defaults to `true` as of ADR-0332**, together with `--checkpoint-config`'s, and the pairing
     * is the whole decision. Three escalators write platform-scope rows now, so a deployment that
     * did not opt in was writing rows **nothing verified** — ADR-0327's "built, correct, and read by
     * nothing" in a new place, and in the one table where the integrity proof is the only detector
     * there is.
     *
     * Flipping *one* of the two would be wrong rather than merely partial: ADR-0287 established that
     * tail removal is invisible to hash links, so the truncation check needs a checkpoint witness,
     * and proving a scope that is never checkpointed leaves that half silently unwitnessed. Flipping
     * both is safe because an empty chain answers `skipped_empty` rather than erroring, so a
     * deployment with no platform rows pays one cheap query per pass and hears nothing.
     *
     * An explicit `false` is still honoured; what changed is what silence means.
     */
    includePlatform: z.boolean().default(true),
    allTenants: z.boolean().default(false),
    tenantStatuses: z.array(z.string().min(1)).nonempty().optional(),
    /** How many of the most recent audit rows to prove per pass (the store clamps at 500). */
    auditRowLimit: z.number().int().positive().default(500),
    /**
     * Verify only the chain suffix after the latest checkpoint rather than folding from genesis.
     * On by default so the cost of a pass stays bounded as a chain grows (ADR-0252/0255).
     */
    fromCheckpoint: z.boolean().default(true),
    /**
     * Append the verdict to the chain as a `security_event`. On by default: a verdict that lives
     * only in a log line is lost, and one in an ordinary table could be deleted by the same
     * superuser who tampered with the audit log. In the chain, *editing* it or removing an
     * earlier one breaks a link. Removing the newest one does not — see `ChainTruncationCheck`
     * — which is why a checkpoint has to cover it before it is truly beyond reach.
     */
    recordVerdict: z.boolean().default(true),
    /**
     * Turn a `compromised` verdict into a declared incident and a page. Absent ⇒ findings are
     * reported through the callbacks and nothing else, which is where ADR-0287 left them.
     */
    escalation: IntegrityEscalationConfigSchema.optional(),
  })
  .strict();
export type IntegrityProofConfig = z.infer<typeof IntegrityProofConfigSchema>;

export function parseIntegrityProofConfig(json: unknown): IntegrityProofConfig {
  return IntegrityProofConfigSchema.parse(json);
}

export async function loadIntegrityProofConfig(path: string): Promise<IntegrityProofConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--integrity-proof-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--integrity-proof-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseIntegrityProofConfig(parsed);
}

/**
 * What a pass concluded about one scope.
 *
 * - `verified` — both halves proved: every audit row matches its anchor, and the chain those
 *   anchors live in is linked and signed.
 * - `unproven` — nothing is disproven, but some rows carry no anchor. The expected state of a
 *   deployment that predates ADR-0286, and **not** an alarm: absence of evidence.
 * - `compromised` — something is disproven. A row no longer matches its anchor, an anchor is
 *   gone, or the chain itself is broken or unsigned. This is the finding.
 */
export const INTEGRITY_VERDICTS = ["verified", "unproven", "compromised"] as const;
export type IntegrityVerdict = (typeof INTEGRITY_VERDICTS)[number];

/**
 * Whether entries the chain was already committed to have gone missing from its end.
 *
 * Hash chains detect modification and removal from the *middle* — both break a link. They do not
 * detect **truncation**: lopping entries off the tail leaves a shorter, perfectly-linked chain, and
 * `verifyChainSuffix` returns valid on an empty suffix. So the newest entries, including the most
 * recent verdict, could be deleted and every signature check would still pass.
 *
 * A checkpoint is the external witness that closes this. Once one exists at sequence N, the chain
 * must still hold an entry at N or beyond; a shorter chain has lost history it was committed to.
 * Before the first checkpoint there is nothing to compare against, which is why running the
 * checkpoint scheduler alongside this one is not optional.
 */
export interface ChainTruncationCheck {
  readonly checkpointSequence: number | null;
  readonly tailSequence: number | null;
  readonly truncated: boolean;
}

export interface IntegrityProofReport {
  /** Tenant id, or `null` for the platform chain. */
  readonly scope: string | null;
  readonly verdict: IntegrityVerdict;
  readonly verifiedAt: string;
  readonly chain: ChainVerificationReport;
  /**
   * `proveScopeIntegrity` always fills this now, for the platform chain as well (ADR-0331). The
   * field stays nullable because `meta.audit_integrity_verdicts` holds reports written while it
   * meant "the platform chain has no audit rows to anchor", and a stored row must keep parsing.
   */
  readonly anchors: AuditAnchorReport | null;
  readonly truncation: ChainTruncationCheck;
  /**
   * Chain entries the reader refused, over the **whole** chain — which the anchor half reads
   * unconditionally and the chain half, in bounded mode, does not.
   *
   * This exists because the first draft of this increment discarded them with a comment claiming
   * *"the chain half already carries them"*, and that premise is false in the mode this binary
   * defaults to: `verifyChainFromCheckpoint` reads `loadFrom(anchor + 1)`, so a refused row
   * **below** the anchor is absent from its `unreadable`, while the whole-chain read performed two
   * statements later has it. Measured through the real `proveScopeIntegrity` with a `verified_full`
   * anchor at 4 and a refused row at 2: `verdict = verified`, both lists empty, the row reported by
   * nothing — ADR-0371's class (a bounded pass skipping a prefix) reappearing for refused rows, in
   * the increment that exists to route them.
   *
   * It is kept apart from `anchors.unreadable` because the two are about different tables and
   * different identities: one names a `meta.audit_log` id, the other a chain sequence, and merging
   * them would hand an operator a list they cannot act on from.
   */
  readonly chainRowsRefused: readonly UnreadableRow[];
  /**
   * What this scope's whole anchor table says about itself: the rows the contract refuses, the
   * anchors the chain contradicts, how far the scan got, and the truncation witness the check above
   * reads.
   *
   * A **third** table, and the axis is separate from the two above for the reason they are separate
   * from each other: this one names a row in `meta.forensic_chain_checkpoints`, and its remedy is a
   * different row from any chain entry or audit row an operator would be sent to. Naming the table
   * is the whole value of the separation, since the identity is a sequence number either way and a
   * merged list would say which position without saying which table.
   *
   * It replaced `anchorRowsRefused: readonly UnreadableRow[]`, which was a list whose own doc
   * comment argued it held **at most one row by construction** — true, and the defect: the one row
   * was `latest()`'s, so a refused anchor was a finding only while it was the *newest*. Measured
   * live as the non-owner `serving` role on one scope with anchors at 1, 3 and 4: blanking
   * `checkpointed_by` at sequence 1 answered `verdict=verified anchorRefused=0` and the identical
   * statement at sequence 4 answered `verdict=compromised anchorRefused=1` — same column, same
   * role, same table, two rows, opposite verdicts. A report shaped as a list of refused rows could
   * not have carried the fix either, because the second face of that aperture is a *readable* row
   * that lies: `sequence_number`'s only CHECK is `>= 0`, so an anchor moved above the chain tail
   * manufactured a false `chain_truncated` and one moved below it hid a real truncation
   * (ADR-0375's Face 2).
   *
   * What makes it load-bearing rather than decorative is unchanged from the list it replaced:
   * `verifyChainFromCheckpoint` answers a refused anchor with a fold from genesis, which is the
   * correct *verification* and, alone, reads as a healthy full pass. The fold is why `chain.ok`
   * cannot carry this, and ADR-0373's own reason `chainRowsRefused` exists is why nothing else can:
   * the fact has to reach the verdict by an axis that pages.
   */
  readonly anchorAudit: AnchorAuditReport;
}

/**
 * An anchor audit that was **asked and found nothing**, for a caller building a report by hand.
 *
 * Exported for the test call sites `integrityVerdictFor`'s retyped parameter moved, and it is a
 * function rather than a frozen constant because `scope` is part of the report and a shared object
 * would have every fixture claiming one tenant's.
 *
 * `disagreeing: []` and deliberately not `null`: `null` is the claim that the correspondence was
 * **not asked** (ADR-0331), which is a different fact from a clean answer and is not what a fixture
 * asserting a clean verdict means. A caller that really holds no chain gets `null` from
 * `auditAnchors` itself and does not need this.
 */
export function noAnchorFindings(scope: string | null = null): AnchorAuditReport {
  return {
    scope,
    scanned: 0,
    complete: true,
    refused: [],
    refusedCount: 0,
    disagreeing: [],
    disagreeingCount: 0,
    witnessSequence: null,
  };
}

/**
 * The minimum the scheduler needs back from an escalation hook. Kept structural so this module
 * never imports `integrity-escalation.ts`, which imports this one — `IntegrityEscalation`
 * satisfies it without either side depending on the other's shape.
 */
export interface IntegrityEscalationOutcome {
  readonly kind: string;
  readonly incidentId: string | null;
}

export interface IntegrityProofPassResult {
  readonly scope: string | null;
  readonly outcome: "proved" | "skipped_empty" | "error";
  readonly report?: IntegrityProofReport;
  /** Sequence of the verdict entry appended to the chain, when one was. */
  readonly recordedAt?: number;
  readonly escalation?: IntegrityEscalationOutcome;
  readonly error?: unknown;
}

/**
 * The whole audit-integrity proof for one scope: four checks, none sufficient alone.
 *
 * ADR-0286 anchored each audit row in the forensic chain and noted that **neither half is a
 * proof alone**: the anchor check shows each row matches what was committed to, the chain check
 * shows those commitments are linked and signed. A wholesale forgery of chain *and* rows would
 * satisfy the anchor half by itself, because the forged entry would commit to the forged row.
 *
 * Running them live revealed a third gap they share — see {@link ChainTruncationCheck}. Cutting
 * entries off the chain's end leaves every link and signature valid, so truncation is asked about
 * separately, against a checkpoint.
 *
 * And a fourth, which is the one the other three *rest on*: nothing asked whether the checkpoint
 * the truncation check reads is itself sound. ADR-0375 added the anchor audit for that — a
 * cross-check of every readable anchor against the chain it claims to anchor — because an anchor is
 * a witness, and a witness nobody examines is a number a tenant can edit. It is listed last and is
 * a prerequisite of the third, which is why it runs before the tail is read.
 *
 * The platform chain (`scope === null`) is checked the same way as a tenant's, because
 * `audit_log.tenant_id` is nullable now and the three platform-scope escalators write rows into it
 * (ADR-0331). Skipping it — which is what this did while the column was NOT NULL, correctly, since
 * there was nothing to check — would leave the one table the forensics stack exists to protect
 * holding rows that nothing verifies: ADR-0327's "built, correct, and read by nothing" in the worst
 * possible place.
 */
export async function proveScopeIntegrity(
  scope: string | null,
  deps: {
    readonly logStore: PostgresChainLogStore;
    readonly checkpoints: PostgresChainCheckpointStore;
    readonly registry: PostgresKeyRegistry;
    readonly audit: PostgresAuditEmitter;
    readonly auditRowLimit: number;
    readonly fromCheckpoint: boolean;
    readonly now: () => Date;
  },
): Promise<IntegrityProofReport> {
  const chain = deps.fromCheckpoint
    ? await verifyChainFromCheckpoint(deps.logStore, deps.registry, deps.checkpoints, scope)
    : await verifyChainFull(deps.logStore, deps.registry, scope);

  // The anchor check needs the entries the rows point at, which a checkpoint-bounded suffix may not
  // contain, so it always reads the whole chain. The chain *half* stays bounded — which is why this
  // read's own refusals are carried out separately rather than assumed to be the chain half's: see
  // `chainRowsRefused`. An audit row pointing at a refused entry is `unanchored` to
  // `verifyAuditAnchors`, and ADR-0286 deliberately does not page on that, so the fact has to reach
  // the verdict by the axis that does.
  //
  // Read **here**, above the anchor audit, rather than two statements lower where it used to sit:
  // the audit cross-checks every anchor against the chain, so it needs these entries, and this
  // function already performed the read. A second read for the audit would be a second snapshot of
  // the same table, and an anchor compared against a chain the report does not carry is a finding
  // nobody can re-derive from the report.
  const chainRead = await deps.logStore.loadChain(scope);

  // `null` on a chain the reader refused a row of, and this is required rather than cautious. The
  // audit's two lookup maps are built from the entries that **parsed**, so over an incomplete chain
  // an anchor pointing at the refused entry finds no entry at its sequence and no entry carrying
  // its root hash — which `disagreementFor` reads as *the chain does not reach this anchor*, and
  // which would therefore hand the anchor a witness it has not earned, or, one sequence over, name
  // it `root_hash_mismatch`: a finding attributed to the wrong table. `chain_row_refused` already
  // answers `compromised` for that chain, so withholding the correspondence loses no verdict —
  // only a sentence that would have been false.
  const correspondenceChain = chainRead.unreadable.length > 0 ? null : chainRead.entries;

  // Neither verification path notices a chain that has been cut short, so ask separately — against
  // the **whole** anchor table rather than its newest row. `latest()` was the detector here until
  // ADR-0375 and was wrong in both directions at once: a refused anchor was a finding only while it
  // was the newest (so the other N−1 rows of a scope were unprotected), and a *readable* anchor was
  // trusted whatever it said, so one `UPDATE` of `sequence_number` under a tenant's own context
  // either manufactured a truncation or disabled the check. The scan reads every row and the
  // correspondence refuses to stand behind one the chain contradicts, which is what makes the
  // witness below a fact rather than a stored number.
  //
  // Both reads of this table are not one read, and the chain half **discards** the refusal it
  // catches — it answers with a fold from genesis and `fullBecause: "anchor_unreadable"` — where
  // this one keeps it. So a bounded pass can still report that reason beside a clean audit, if the
  // refused row is *repaired* between `verifyChainFromCheckpoint`'s `latest()` and this scan. That
  // residual is narrower than the one it replaces (a tamperer had only to append a readable row
  // above the refused one; now they have to fix it) and is left open for the reason it always was:
  // the other ordering — readable first, refused second — is the one that matters and already
  // answers `compromised`, since this report is what the verdict reads.
  const anchorAudit = await auditAnchors(scope, deps.checkpoints, correspondenceChain);

  // After the audit, so the witness is read before the tail it is compared against — the order
  // `latest()` and `tail()` were in. Widening the gap between them with a whole-table scan cannot
  // manufacture a finding: `truncated` needs `tail < witness`, so an append in the window only ever
  // clears the check and a delete in the window is a truncation that really happened.
  const tail = await deps.logStore.tail(scope);
  const truncation: ChainTruncationCheck = {
    checkpointSequence: anchorAudit.witnessSequence,
    tailSequence: tail?.sequenceNumber ?? null,
    truncated:
      anchorAudit.witnessSequence !== null &&
      (tail === null || tail.sequenceNumber < anchorAudit.witnessSequence),
  };

  const audit = await deps.audit.listAnchoredForScope(scope, { limit: deps.auditRowLimit });
  const anchors: AuditAnchorReport = verifyAuditAnchors(
    scope,
    audit.rows,
    chainRead.entries,
    audit.unreadable,
  );

  return {
    scope,
    verdict: integrityVerdictFor(
      chain,
      anchors,
      truncation,
      chainRead.unreadable,
      anchorAudit,
    ),
    verifiedAt: deps.now().toISOString(),
    chain,
    anchors,
    truncation,
    chainRowsRefused: chainRead.unreadable,
    anchorAudit,
  };
}

/**
 * Why a verdict is `compromised` — one member per condition, and the list the judgement is **built
 * from** rather than a description of one written elsewhere.
 *
 * It is a list because the escalation row named two of the original six, and the block asserting it
 * named one per branch was refuted by mutation: a seventh `compromised` branch added to
 * `integrityVerdictFor` with no key in the escalation `after` payload passed the entire suite. The
 * branches were a hand-written list of `if`s and the tests a hand-written list of `it`s with
 * nothing relating the two — ADR-0288's maintained list, and ADR-0351's documented hazard that
 * checked nothing.
 *
 * Named for the **fact** and never the field, because a cause outlives the shape of the report it
 * is read from and `chain.ok` has already been two fields.
 *
 * - `chain_truncated` — entries the chain was committed to are gone from its end. First, because a
 *   truncated chain still passes every link and signature check, so nothing else in the report
 *   would reveal it.
 * - `chain_broken_or_unsigned` — the chain's own verification failed, which disproves it whatever
 *   the rows say: the anchors it holds cannot then be trusted to attest to anything. **One** cause
 *   and not two, because `chain.ok` is the conjunction the condition reads and a report may carry
 *   `ok: false` with both halves true; which half failed travels in the escalation's `chain` key.
 * - `chain_row_refused` — a chain entry is stored in a shape the contract refuses. Its own cause
 *   rather than folded into the one above, because in bounded mode the chain half never read these
 *   rows: they come from the whole-chain read the anchor half performs, and a refused row below the
 *   anchor is invisible to `verifyChainFromCheckpoint` by construction. The bounded proof's trust
 *   is in the verification that produced the anchor, so a row that cannot be read *now* is either a
 *   row rewritten since, or one the anchoring verification was wrong about — both findings, and
 *   neither softer than a broken link.
 * - `checkpoint_row_refused` — the anchor is stored in a shape the contract refuses. The same
 *   judgement one table across, and it needs no separate argument because
 *   `PostgresChainCheckpointStore.record` begins with `ChainCheckpointSchema.parse`: no checkpoint
 *   this binary writes can be one it cannot read back, so a refused anchor was edited or written
 *   out of band exactly as a refused entry was. `verifyChainFromCheckpoint` already answers it by
 *   folding from genesis, which is the correct *verification* and, on its own, reads as a healthy
 *   full pass — so the fold is not sufficient and this is the axis that pages. It reads
 *   `refusedCount` and not the list beside it, because that list is capped at
 *   `MAX_REPORTED_ANCHOR_REFUSALS` and a cause gated on a capped list would stop firing if the cap
 *   were ever lowered to 0.
 * - `checkpoint_disagrees_with_chain` — a **readable** anchor says something the chain contradicts
 *   at that anchor's own sequence. Beside the refusal rather than folded into it, because the two
 *   are different acts with the same consequence: one row is malformed, the other is well-formed
 *   and false. A checkpoint is a *witness*, so an anchor the chain disagrees with is either a
 *   doctored witness or an altered entry — and which of the two is not decidable from here, which
 *   is why the cause names the disagreement and not a culprit.
 *
 *   Its own cause rather than `chain_truncated` is the load-bearing part, and it is the correction
 *   of a **false** `compromised` rather than the closing of a gap. `sequence_number`'s only CHECK
 *   is `>= 0` and this table's isolation arm is `ALL`-scope, so its `USING` doubles as its
 *   `WITH CHECK` (ADR-0374): one `UPDATE` under a tenant's own context, as the non-owner `serving`
 *   role, raised an anchor from 4 to 99 on a fully-converged deployment and the pass answered
 *   `verdict=compromised truncated=true witness=99 causes=[chain_truncated]`, with the formatter
 *   printing *"TRUNCATED: checkpoint at 99 but the chain ends at 4"* while **every entry was
 *   present** — a paging sev1 telling an operator that audit history was destroyed, naming the
 *   wrong table. Excluding a contradicted anchor from the witness is what stops that, and this
 *   cause is what keeps the row from reading clean once it is excluded.
 *
 *   Together with `checkpoint_row_refused` these two are exactly `anchorAuditDisproves`' disjuncts,
 *   and they are read apart rather than through it because each names a different act and lands at
 *   a different key in the escalation row. The cost of the split is that a *third* disjunct added
 *   to that predicate would reach the scheduler's findings hook and no cause here, so a verdict
 *   could read `verified` beside an anchor finding; a test asserts the two sides agree over the
 *   shapes this report can hold.
 * - `audit_row_tampered` — an audit row no longer matches the chain entry that commits to it.
 * - `audit_row_refused` — an audit row is stored in a shape the contract refuses. The one judgement
 *   here that had to be argued rather than copied, and it sits beside `audit_row_tampered` and not
 *   beside `unanchored`: an unanchored row is the *absence* of evidence — a deployment upgrading
 *   from before ADR-0286 has such rows for ever — while a row this deployment's own reader refuses
 *   is evidence of something, since `assertEmittable` parses through the same schema the reader
 *   does, so no write this binary can perform produces one. Deliberately **not** softer than
 *   `hash_mismatch`, because rewriting a row into a shape the contract refuses is *easier* than
 *   rewriting it into a valid one, so grading it below `compromised` would leave the cheaper attack
 *   as the one that does not page.
 *
 * The first six are in the order they were asked in before they were a list, so for any evidence
 * those six describe `causes[0]` is still the condition that used to answer first — a property
 * inserting a seventh member **in the middle** cannot disturb, because `compromiseCauses` filters
 * and a filter preserves relative order. `checkpoint_disagrees_with_chain` is the seventh and was
 * asked nowhere before, so it has no historical position to keep: it sits beside its sibling
 * because the two are one table's two failure modes and an operator meeting either goes to the same
 * rows, which is worth more than a precedence nothing measured.
 *
 * Every one of them is asked **before** the `anchors === null` guard; two — `audit_row_tampered`
 * and `audit_row_refused` — used to be asked after it, and hoisting them changed no answer, because
 * a null anchor half has no tampered or refused rows to find. What the hoist buys is that the guard
 * can never again be the reason a cause is not looked for, which is the mistake
 * `checkpoint_row_refused` was placed ahead of it to avoid.
 */
export const COMPROMISE_CAUSES = [
  "chain_truncated",
  "chain_broken_or_unsigned",
  "chain_row_refused",
  "checkpoint_row_refused",
  "checkpoint_disagrees_with_chain",
  "audit_row_tampered",
  "audit_row_refused",
] as const;
export type CompromiseCause = (typeof COMPROMISE_CAUSES)[number];

/**
 * The facts a compromise is judged from, and the one shape both readers hand over.
 *
 * Structural rather than an `IntegrityProofReport`, because `integrityVerdictFor` runs while that
 * report is being *built* — the verdict is one of its fields — so a cause function taking a report
 * could not be the one the verdict is computed through, and two implementations of this judgement
 * are exactly what the escalation row's two-of-six already cost. A whole `IntegrityProofReport`
 * satisfies it, so the escalator asks the same function about the same five fields.
 */
export interface CompromiseEvidence {
  readonly chain: ChainVerificationReport;
  readonly anchors: AuditAnchorReport | null;
  readonly truncation: ChainTruncationCheck;
  readonly chainRowsRefused: readonly UnreadableRow[];
  readonly anchorAudit: AnchorAuditReport;
}

/**
 * One predicate per cause.
 *
 * A total map, so an eighth condition cannot join this judgement without an eighth member of
 * `COMPROMISE_CAUSES` — which is in turn a compile error in `COMPROMISE_CAUSE_PAYLOAD_KEY` and in
 * the escalation fence's per-cause fixtures, so the key that explains the new cause and the test
 * proving that key explains it both have to be written. That is the whole mechanism: the branch
 * list **is** the cause list, where it used to be a list of `if`s with a hand-written list of `it`s
 * beside it and nothing joining them. The fence was exercised rather than assumed when the seventh
 * member landed: adding `checkpoint_disagrees_with_chain` to this map alone is `TS2353` here,
 * adding the enum member to clear that is `TS2741` at the payload key and at both suites' per-cause
 * fixtures, and each of those is a file whose author has to say what the new cause means.
 *
 * What no type can fence is a bare `if (…) return "compromised"` added to `integrityVerdictFor`
 * itself. There is exactly one such return and it is gated on this map; a test reads this module as
 * text and pins that count, which is the only fence available for a judgement made in a function
 * body (ADR-0357's shape).
 */
const COMPROMISE_CAUSE_HOLDS: Record<CompromiseCause, (evidence: CompromiseEvidence) => boolean> = {
  chain_truncated: (e) => e.truncation.truncated,
  chain_broken_or_unsigned: (e) => !e.chain.ok,
  chain_row_refused: (e) => e.chainRowsRefused.length > 0,
  checkpoint_row_refused: (e) => e.anchorAudit.refusedCount > 0,
  checkpoint_disagrees_with_chain: (e) =>
    e.anchorAudit.disagreeing !== null && e.anchorAudit.disagreeing.length > 0,
  audit_row_tampered: (e) => e.anchors !== null && e.anchors.tampered.length > 0,
  audit_row_refused: (e) => e.anchors !== null && e.anchors.unreadable.length > 0,
};

/**
 * Every cause this evidence exhibits, in precedence order.
 *
 * Exported because the escalation row has to name what drove the page and `integrityVerdictFor`'s
 * one-word answer cannot say which of seven. It returns all of them rather than the first, because
 * an operator meeting a truncated chain *and* a tampered row has two things to look at and a
 * first-match answer would name one.
 */
export function compromiseCauses(evidence: CompromiseEvidence): readonly CompromiseCause[] {
  return COMPROMISE_CAUSES.filter((cause) => COMPROMISE_CAUSE_HOLDS[cause](evidence));
}

/**
 * The verdict from every half. Exported because this is where the judgement lives, and the
 * distinction it draws is the one that decides whether anyone gets woken up.
 *
 * Its `compromised` half is `COMPROMISE_CAUSES` — see there for each condition's argument and for
 * why a list rather than a sequence of `if`s. What is left here is the three judgements that are
 * not findings.
 *
 * The fifth parameter is a whole `AnchorAuditReport` and was a `readonly UnreadableRow[]`.
 * ADR-0374 kept that shape *specifically* to spare 21 call sites in this app's tests, and that
 * convenience expired the moment the axis grew a second dimension: a report that can also say *this
 * anchor contradicts the chain* and *the scan did not reach the end* cannot be carried by a list of
 * refused rows, and passing the three alongside each other would be three parameters nothing keeps
 * in agreement. So the call sites moved, and `noAnchorFindings` is what they moved to.
 */
export function integrityVerdictFor(
  chain: ChainVerificationReport,
  anchors: AuditAnchorReport | null,
  truncation: ChainTruncationCheck,
  chainRowsRefused: readonly UnreadableRow[],
  anchorAudit: AnchorAuditReport,
): IntegrityVerdict {
  const causes = compromiseCauses({
    chain,
    anchors,
    truncation,
    chainRowsRefused,
    anchorAudit,
  });
  if (causes.length > 0) return "compromised";
  // A scan the ceiling stopped did not read the whole anchor table, so every count on that report is
  // a **lower bound** and `verified` would claim a reading nobody took — ADR-0372's vacuous axis, in
  // the one place that decides whether anybody is woken. Deliberately **not** a compromise cause:
  // nothing is disproven, an absence of evidence is not evidence (ADR-0372 again, read the other
  // way), and paging on a budget this deployment set itself would train everyone to raise the
  // ceiling rather than look.
  //
  // `unproven` and deliberately not a fourth verdict, which is a measurement and not a preference:
  // `INTEGRITY_VERDICTS` is mirrored by `STORED_INTEGRITY_VERDICTS` and constrained by
  // `meta.audit_integrity_verdicts`' own column CHECK (`verdict IN ('verified', 'unproven',
  // 'compromised')`), declared in `VALUE_SET_DOMAINS` — so a fourth member is a catalog change, a
  // declaration change and a CHECK whose widening every deployed database has to be re-planned for.
  // `unproven`'s own definition already covers this: *nothing is disproven, and something is not
  // established*.
  if (!anchorAudit.complete) return "unproven";
  if (anchors === null) return "verified";
  // `anchors.ok` also requires nothing unanchored; that is split out here, because an unanchored
  // row is unproven rather than disproven and must not page anyone. A deployment upgrading from
  // before ADR-0286 has such rows forever, and treating them as findings would make the whole
  // scheduler undeployable.
  return anchors.unanchored > 0 ? "unproven" : "verified";
}

/** The deterministic bytes the chain commits to for one verdict. */
export function integrityVerdictPayload(report: IntegrityProofReport): string {
  return JSON.stringify({
    kind: "audit_integrity_proof",
    scope: report.scope,
    verdict: report.verdict,
    verifiedAt: report.verifiedAt,
    chain: {
      ok: report.chain.ok,
      mode: report.chain.mode,
      checkpointSequence: report.chain.checkpointSequence,
      integrityValid: report.chain.integrity.valid,
      brokenAt: report.chain.integrity.brokenAt,
      signaturesValid: report.chain.signatures.valid,
    },
    truncation: {
      checkpointSequence: report.truncation.checkpointSequence,
      tailSequence: report.truncation.tailSequence,
      truncated: report.truncation.truncated,
    },
    anchors:
      report.anchors === null
        ? null
        : {
            checked: report.anchors.checked,
            verified: report.anchors.verified,
            unanchored: report.anchors.unanchored,
            tampered: report.anchors.tampered.map((t) => ({
              auditId: t.auditId,
              verdict: t.verdict,
              sequenceNumber: t.sequenceNumber,
            })),
          },
  });
}

export type IntegrityScopeSource = () =>
  | Promise<readonly (string | null)[]>
  | readonly (string | null)[];

export interface IntegrityProofSchedulerOptions {
  /** Runs both halves for one scope. Built from the stores by `buildIntegrityProofLifecycle`. */
  readonly prove: (scope: string | null) => Promise<IntegrityProofReport>;
  /** Appends the verdict to the chain. Omitted ⇒ verdicts are computed but not recorded. */
  readonly record?: (report: IntegrityProofReport) => Promise<number>;
  readonly scopes: IntegrityScopeSource;
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly runOnStart?: boolean;
  readonly onPass?: (report: IntegrityProofReport) => void;
  /** Fires only for `compromised` — the one outcome that means something is provably wrong. */
  readonly onFinding?: (report: IntegrityProofReport) => void;
  /**
   * Escalation, consulted on **every** proved pass rather than only on findings — a scope
   * returning to health is what closes an open incident, so recovery has to be observed too.
   */
  readonly escalate?: (report: IntegrityProofReport) => Promise<IntegrityEscalationOutcome>;
  readonly onError?: (err: unknown) => void;
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Periodically runs the audit-integrity proof per scope and records the verdict in the chain.
 *
 * ADR-0286 built both halves of the proof and left them unrun: a check nobody performs proves
 * nothing, and a tamper that nothing looks for is indistinguishable from no tamper. This is the
 * thing that looks.
 *
 * The verdict is appended to the chain **after** verifying, so it sits outside what it attests to
 * and the next pass covers it — an unbroken run of verdict entries is itself the evidence that
 * checking happened, which a log line could never be. A scope with no chain entries and no audit
 * rows is skipped rather than recorded, so an idle tenant does not accrue verdicts about nothing.
 *
 * A per-scope failure is routed to `onError` and the pass continues; one tenant never blocks the
 * rest. Mirrors `CheckpointScheduler`: the timer is `unref`'d and `start()` fires an immediate pass.
 */
export class IntegrityProofScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: IntegrityProofSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    if (this.opts.runOnStart !== false) void this.runOnce();
    this.handle = this.scheduler().setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  /** One proof pass over every scope. Never rejects — a per-scope error is captured + routed. */
  async runOnce(): Promise<readonly IntegrityProofPassResult[]> {
    const results: IntegrityProofPassResult[] = [];
    let scopes: readonly (string | null)[];
    try {
      scopes = await this.opts.scopes();
    } catch (err) {
      this.opts.onError?.(err);
      return results;
    }
    for (const scope of scopes) {
      try {
        const report = await this.opts.prove(scope);
        if (isEmptyScope(report)) {
          results.push({ scope, outcome: "skipped_empty" });
          continue;
        }
        this.opts.onPass?.(report);
        if (report.verdict === "compromised") this.opts.onFinding?.(report);
        const recorded = await this.opts.record?.(report);
        // After the verdict is in the chain: escalating first would risk paging about a finding
        // that no durable record backs.
        const escalation = await this.opts.escalate?.(report);
        results.push({
          scope,
          outcome: "proved",
          report,
          ...(recorded !== undefined ? { recordedAt: recorded } : {}),
          ...(escalation !== undefined ? { escalation } : {}),
        });
      } catch (err) {
        this.opts.onError?.(err);
        results.push({ scope, outcome: "error", error: err });
      }
    }
    return results;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

/**
 * Nothing to prove and nothing to record: no chain entries, no audit rows claiming any, and
 * nothing this pass could not read.
 *
 * `skipped_empty` is not a quiet outcome, it is a **claim** — and it is the only outcome that
 * discards the report. The scheduler pushes it and `continue`s past `onPass`, `onFinding`,
 * `record` and `escalate`, so a verdict computed here reaches no callback, no durable row, no
 * incident and not even `formatIntegrityProof`. What it claims is therefore *this pass found
 * nothing to verify* — and a row the contract refused is something: it **is** the finding
 * (ADR-0373), and it is already what `integrityVerdictFor` answers `compromised` for. A refused
 * row is the one thing that must never land on this outcome, because this is the one outcome from
 * which nothing escapes.
 *
 * It became reachable by the narrowest margin, in the increment that routed those rows rather than
 * dropping them: ADR-0373 made `anchors.checked` the number of rows **examined**, so `checked ===
 * 0` stopped meaning *there were no rows* and started coexisting with one refused row — and the
 * clause below went on reading the new figure with the old meaning. Measured live as a non-owner:
 * one `meta.audit_log` row with a blanked `operation`, for a scope holding no chain entries,
 * computed `compromised` and the scheduler threw the report away.
 *
 * **The fence that increment added was the wrong level, and so was wrong again one branch across.**
 * It extended `readEveryRowFound` to every refusal axis and argued at length about which of them
 * fire, without re-reading the other two conjuncts against `integrityVerdictFor` — where
 * `truncation.truncated` is asked **first** and is read by none of the three. So the *weaker*
 * evidence (an anchor that cannot be read) was kept and the *stronger* — a proven total truncation,
 * the thing ADR-0287 built the check for — was still thrown away. Measured live on a scope with no
 * chain entries, a readable checkpoint at 3 and no audit rows: `verdict=compromised`,
 * `truncated=true`, `outcome=skipped_empty`, `callbacks=[]`, and the formatter's "TRUNCATED:
 * checkpoint at 3 but the chain ends at null" printed by nobody. Only the *maximal* truncation was
 * lost — with one surviving entry the tail is non-null and the first conjunct already fails —
 * which is why a partial cut was visible and a total one was not.
 *
 * So the question is asked of the **verdict**, which is total over every condition, rather than of
 * a conjunct list that has to be revisited whenever a condition is added. `verified` is the one
 * verdict compatible with *nothing to verify*: `compromised` is a finding by definition, and
 * `unproven` says something exists that is not established, which is not nothing.
 *
 * That last clause used to carry a parenthetical calling `unproven` **unreachable** from a report
 * this function builds — `unanchored > 0` needs a row in `results` and `checked` is
 * `results.length`, so `noAuditRows` excluded it — and the next condition to arrive made it false:
 * ADR-0375's anchor-scan coverage answers `unproven` for a scope with no chain entries and no audit
 * rows at all, because the question it asks is about a third table. The conclusion it was offered
 * for survives and is better supported than when it was a theory: the clause is not there for a
 * case somebody enumerated, it is there so that no future condition needs this function edited.
 */
function isEmptyScope(report: IntegrityProofReport): boolean {
  // Keyed on the tail, NOT on how many signatures the chain half checked. In
  // `from_checkpoint` mode that count covers only the suffix after the checkpoint, so it is
  // legitimately 0 for a chain with plenty of entries once a checkpoint catches up to the tail
  // — and treating that as empty would silently stop proving the scope altogether.
  const chainEmpty = report.truncation.tailSequence === null;
  const noAuditRows = report.anchors === null || report.anchors.checked === 0;
  return report.verdict === "verified" && chainEmpty && noAuditRows && readEveryRowFound(report);
}

/**
 * Whether this pass could represent every row it read, over every axis of the report that can carry
 * a refusal.
 *
 * **Subsumed by the verdict clause in front of it**, and the honest statement is that it can no
 * longer change this predicate's answer for any report `proveScopeIntegrity` builds: each of the
 * four axes drives `integrityVerdictFor` away from `verified`, two of them directly
 * (`chain_row_refused`, and the anchor audit's own pair of causes), one through `chain.ok` —
 * `verifyChainSignatures` answers `valid: false` for a non-empty `unreadable` — and one through
 * `audit_row_refused`. The claim this comment used to make, that the anchor axis is the one that
 * *genuinely fires* here, was true for one commit and is not true now: that case is the verdict
 * clause's.
 *
 * The anchor conjunct is `anchorAuditHasFindings` and so is **wider** than the refused-row list it
 * replaced — it also refuses a skip for an anchor the chain contradicts and for a scan the ceiling
 * stopped. Both are right for this predicate's question, which is whether the pass can stand behind
 * what it read: a contradicted anchor is something found, and an unread tail is something not read,
 * and `skipped_empty` claims neither happened. It is the one conjunct here that is not purely about
 * rows the reader refused, which is why the name is now slightly narrower than the predicate; the
 * alternative was reading `refusedCount` alone and silently dropping the two new facts.
 *
 * It is retained for two reasons, and the first is not hypothetical. `verdict` is a **field on the
 * report**, and this predicate is handed reports by `opts.prove`, which is a seam: a caller can
 * supply a report whose verdict does not follow from its own content. Two tests in this module's
 * suite do exactly that, across three fixtures — each overrides a refusal axis on a fixture whose
 * verdict stays `verified` and asserts the pass is *not* skipped — and deleting this call is
 * measured to fail exactly those two, so here the assertion is this function's answer and nothing
 * else's. More generally it keeps the two kinds of evidence apart: the verdict is a **claim** and
 * the refusal lists are the **content**, which is ADR-0331's distinction inside one predicate.
 *
 * The second reason is the shape ADR-0340's `dischargeAbac` keeps: a guard a path can no longer
 * reach is kept when the redundancy is **one-directional**, and this one is — it can only ever
 * refuse a skip, never grant one. So an axis that never fires costs nothing, where an axis omitted
 * on the strength of what a read one layer down happens to do today is this defect again the day
 * that read starts parsing.
 *
 * That last clause is why the chain half's own `signatures.unreadable` is asked even though it
 * cannot be reached with a differing answer: `tail()` selects `sequence_number, entry_hash` raw and
 * parses nothing, so a chain holding any row at all — refused or not — answers a non-null
 * `tailSequence` and fails `isEmptyScope`'s first conjunct long before this.
 */
function readEveryRowFound(report: IntegrityProofReport): boolean {
  return (
    report.chainRowsRefused.length === 0 &&
    !anchorAuditHasFindings(report.anchorAudit) &&
    report.chain.signatures.unreadable.length === 0 &&
    (report.anchors === null || report.anchors.unreadable.length === 0)
  );
}

export function formatIntegrityProof(report: IntegrityProofReport): string {
  const scope = report.scope ?? "platform";
  const lines = [`audit integrity for ${scope}: ${report.verdict.toUpperCase()}`];
  // The mode alone cannot say whether a full fold was asked for or was a bounded pass refusing its
  // anchor, and the second is the finding. This is the only consumer that runs unattended, so the
  // reason is named here or nowhere; a bounded pass carries none and reads exactly as before.
  const anchorage =
    report.chain.fullBecause === null
      ? report.chain.mode
      : `${report.chain.mode}: ${report.chain.fullBecause}`;
  // The reason is printed, not just the position: `verifyChainIntegrity` and
  // `unreadableEntryVerdict` both answer `{valid: false, brokenAt}`, so without it a chain entry
  // the contract refuses reads identically to a broken hash link on the one surface that runs
  // unattended — and the two send an operator to opposite remedies (go and look at a present,
  // malformed row, versus go and look for a deleted one).
  const integrityPhrase = report.chain.integrity.valid
    ? "valid"
    : `BROKEN at ${String(report.chain.integrity.brokenAt)}` +
      (report.chain.integrity.reason === undefined ? "" : ` (${report.chain.integrity.reason})`);
  lines.push(
    `  chain [${anchorage}]: integrity ${integrityPhrase}` +
      `, signatures ${report.chain.signatures.valid ? "valid" : "INVALID"}` +
      ` (${report.chain.signatures.checked.toString()} checked)`,
  );
  // The whole-chain read's refusals, which in bounded mode the chain half never saw. Named here
  // because this is the only unattended surface and the verdict alone cannot say which of three
  // axes failed.
  for (const u of report.chainRowsRefused) {
    lines.push(`  unreadable chain entry ${u.identity ?? "<unidentified>"} (${u.detail})`);
  }
  if (report.truncation.truncated) {
    lines.push(
      `  TRUNCATED: checkpoint at ${String(report.truncation.checkpointSequence)}` +
        ` but the chain ends at ${String(report.truncation.tailSequence)}`,
    );
  } else if (report.truncation.checkpointSequence === null) {
    // Two reasons the check cannot run, and they are not interchangeable — which is why the second
    // arm is gated rather than printed unconditionally: "no checkpoint yet — run the checkpoint
    // scheduler" is the remedy that cannot work for a scope that *has* anchors, since `record` is
    // `ON CONFLICT (tenant_id, sequence_number) DO NOTHING` so running the scheduler leaves an
    // edited row exactly where it is (ADR-0334 — a remedy that cannot work is worse than naming
    // none).
    //
    // The witness is the audit's now, not `latest()`'s, so `checkpointSequence === null` says *no
    // anchor this audit will stand behind* rather than *the newest anchor could not be read*: it
    // covers a scope with no checkpoints at all, one whose every row the contract refuses, and one
    // whose every row the chain contradicts. The first is the only one the scheduler fixes; the
    // other two are named by the audit's own lines below, so this arm points there rather than
    // guessing which.
    lines.push(
      anchorAuditHasFindings(report.anchorAudit)
        ? "  truncation: not checkable (no checkpoint this audit will stand behind — see below)"
        : "  truncation: not checkable (no checkpoint yet — run the checkpoint scheduler)",
    );
  }
  // Beside the chain and anchor refusals rather than inside the `anchors !== null` block, because
  // this axis is answered on every pass: the anchor table is read before the audit rows are looked
  // at, so a scope with no anchored rows at all still reports what its checkpoints say.
  //
  // Printed when there is something to act on **or** when the truncation check fired, which keeps
  // the unattended line count of a healthy scope exactly what it was — the block this replaces was
  // a loop over refused rows and so was silent on a clean pass too.
  //
  // The `truncated` disjunct is not symmetry: without it, the one report that most needs the anchor
  // table described is the one that withholds it. `chain_truncated` is raised **from the witness**,
  // and a two-column edit (lower or raise a `sequence_number` *and* set a `root_hash` the chain
  // cannot contradict) leaves the audit clean, so `anchorAuditHasFindings` is false while the
  // report says `TRUNCATED: checkpoint at 99 but the chain ends at 4`. Measured against this
  // module: an operator was told audit history had been destroyed and given no line saying how many
  // anchors exist, which one claims that sequence, or that the audit stood behind it.
  //
  // A findings gate therefore withholds **two** lines on a clean pass, not one: the unconditional
  // `checkpoints: N row(s) scanned…` summary and the *correspondence was not asked* line. The
  // second is sound for the reports this binary produces — `proveScopeIntegrity` passes `null` for
  // the chain only when the reader refused one of its rows, and those rows are printed above and
  // drive the verdict — and that is a statement about the producer rather than about the type,
  // because `opts.prove` is a seam (see `readEveryRowFound`) and a caller may hand over a report
  // whose content does not follow from how this binary would have built it.
  //
  // Indenting these lines into this report is what found `formatAnchorAudit`'s label: its first
  // line opened `anchors:` and so did the anchor half's below, about `meta.audit_log` rows anchored
  // **in** the chain — two lines about two tables under one prefix, which is the merge ADR-0373
  // refused as data and would have given away in output. It reads `checkpoints:` now, which is the
  // live run of this increment paying for itself before a deployment met the report.
  if (anchorAuditHasFindings(report.anchorAudit) || report.truncation.truncated) {
    for (const line of formatAnchorAudit(report.anchorAudit)) lines.push(`  ${line}`);
  }
  if (report.anchors !== null) {
    lines.push(
      `  anchors: checked ${report.anchors.checked.toString()}` +
        `, verified ${report.anchors.verified.toString()}` +
        `, unanchored ${report.anchors.unanchored.toString()}` +
        `, tampered ${report.anchors.tampered.length.toString()}` +
        `, unreadable ${report.anchors.unreadable.length.toString()}`,
    );
    for (const t of report.anchors.tampered) {
      lines.push(`    ${t.verdict}: audit ${t.auditId}`);
    }
    // The refused rows are named here and nowhere else, which is ADR-0371's split: a diagnostic
    // belongs where diagnostics are read, and the durable record carries only what the digest
    // covers — so the *fact* travels in `verdict`, which is both signed and projected, while the
    // ids travel in the line an operator sees. Adding a count to the stored report would have to
    // move `integrityVerdictPayload`, `StoredIntegrityReportSchema`, `canonicalStoredReport` and
    // `storedIntegrityReportFor` together or break the parity that lets a reader confirm the row's
    // content *is* the committed content — the exact trap ADR-0371 reverted a field out of.
    for (const u of report.anchors.unreadable) {
      lines.push(`    unreadable: audit ${u.identity ?? "<unidentified>"} (${u.detail})`);
    }
  }
  return lines.join("\n");
}

export interface IntegrityProofLifecycleOptions {
  readonly signer: ChainSigner;
  readonly registry: PostgresKeyRegistry;
  readonly scheduler?: IntervalScheduler;
  /** Overrides the config's static tenant list with a live source (may include `null`). */
  readonly tenants?: IntegrityScopeSource;
  readonly runOnStart?: boolean;
  readonly onPass?: (report: IntegrityProofReport) => void;
  readonly onFinding?: (report: IntegrityProofReport) => void;
  readonly escalate?: (report: IntegrityProofReport) => Promise<IntegrityEscalationOutcome>;
  readonly onError?: (err: unknown) => void;
  readonly now?: () => Date;
}

export interface IntegrityProofLifecycle {
  readonly scheduler: IntegrityProofScheduler;
  runOnce(): Promise<readonly IntegrityProofPassResult[]>;
}

/** The scopes from a static config: its tenant ids, plus the platform chain when opted in. */
export function integrityConfigScopes(
  config: IntegrityProofConfig,
): readonly (string | null)[] {
  const scopes: (string | null)[] = [...config.tenants];
  if (config.includePlatform) scopes.push(null);
  return scopes;
}

export function buildIntegrityProofLifecycle(
  conn: PgConnection,
  config: IntegrityProofConfig,
  opts: IntegrityProofLifecycleOptions,
): IntegrityProofLifecycle {
  const logStore = new PostgresChainLogStore(conn, opts.signer, { schema: config.schema });
  const checkpoints = new PostgresChainCheckpointStore(conn, { schema: config.schema });
  // A reader, not the anchoring emitter: this verifies what was written, and must never write.
  const audit = new PostgresAuditEmitter(conn, { schema: config.schema });
  // Built only when the verdict is being recorded, so a pass that records nothing allocates
  // nothing — and, more to the point, so there is no store sitting here that nothing calls, which
  // is the state this whole table was in.
  const verdicts = config.recordVerdict
    ? new PostgresIntegrityVerdictStore(conn, { schema: config.schema })
    : null;
  const scopes: IntegrityScopeSource = opts.tenants ?? (() => integrityConfigScopes(config));
  const now = opts.now ?? ((): Date => new Date());

  const scheduler = new IntegrityProofScheduler({
    prove: (scope) =>
      proveScopeIntegrity(scope, {
        logStore,
        checkpoints,
        registry: opts.registry,
        audit,
        auditRowLimit: config.auditRowLimit,
        fromCheckpoint: config.fromCheckpoint,
        now,
      }),
    ...(config.recordVerdict
      ? {
          record: async (report: IntegrityProofReport): Promise<number> => {
            const entry = await logStore.append({
              tenantId: report.scope,
              kind: "security_event",
              actorReference: config.verifiedBy,
              recordedAt: report.verifiedAt,
              payload: integrityVerdictPayload(report),
            });
            // And the queryable row, which until ADR-0333 nothing wrote: `record()` and
            // `integrityVerdictInputFor` were called by nothing but their own unit test, so
            // `meta.audit_integrity_verdicts` was empty in every deployment and every
            // `--audit-verdict-routes` answer was "no verifications" — for a table that exists to
            // make "show me last month's verifications" answerable. The chain entry above was the
            // whole of what `recordVerdict` recorded.
            //
            // Under the same flag rather than a new one, because `recordVerdict` already means
            // "record the verdict": a second flag would let a deployment turn recording on and
            // still get no record, which is the silence this increment is about.
            //
            // The anchor comes from the entry just appended, and both halves of it — ADR-0318's
            // rule that half an anchor is worse than none, which `record()` enforces. The entry
            // hash was always on the returned `ChainedLogEntry`; this callback discarded it and
            // returned only the sequence, so the seam was never missing, just unread.
            if (verdicts !== null) {
              try {
                await verdicts.record(
                  integrityVerdictInputFor(report, {
                    chainEntryHash: entry.entryHash,
                    chainSequenceNumber: entry.sequenceNumber,
                  }),
                );
              } catch (err) {
                // Reported, never thrown: the chain entry has committed, so the verification *is*
                // recorded where tamper-evidence lives. Raising here would turn a successful
                // verification into a failed pass and skip the next scope, losing the anchored
                // entry's value to protect a projection of it. Same shape as `appendPagedNote`
                // (ADR-0327) — the durable half has landed, so the convenience half must not be
                // able to undo it.
                //
                // Named here as well as handed to `opts.onError`, because that callback is shared by
                // every failure in a pass and logs the error alone: "pass error: …" does not say
                // that the *verification succeeded* and only its queryable projection was lost,
                // which is the one distinction an operator reading this line needs. It is also
                // optional on the seam, so a caller that omits it would otherwise get silence.
                console.warn(
                  `[integrity-proof] scope=${report.scope ?? "platform"} verified, but its` +
                    ` queryable verdict row could not be written (the chain entry is committed and` +
                    ` is the record of record): ${String(err)}`,
                );
                opts.onError?.(err);
              }
            }
            return entry.sequenceNumber;
          },
        }
      : {}),
    scopes,
    intervalMs: config.intervalMs,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.runOnStart !== undefined ? { runOnStart: opts.runOnStart } : {}),
    ...(opts.onPass !== undefined ? { onPass: opts.onPass } : {}),
    ...(opts.onFinding !== undefined ? { onFinding: opts.onFinding } : {}),
    ...(opts.escalate !== undefined ? { escalate: opts.escalate } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return { scheduler, runOnce: () => scheduler.runOnce() };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
