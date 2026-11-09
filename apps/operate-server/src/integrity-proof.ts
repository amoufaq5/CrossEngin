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
  chainTruncation,
  formatAnchorAudit,
  type ChainTruncationCheck,
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
  attestedWitnessFrom,
  integrityVerdictInputFor,
} from "./integrity-verdict-store.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import {
  compareWitnessMemory,
  formatWitnessMemory,
  witnessMemoryShowsAnchors,
  witnessMemoryShowsHistory,
  witnessMemoryUnproven,
  type WitnessMemoryCheck,
  type WitnessMemorySource,
} from "./witness-memory.js";

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
    /** Absent means `chainScopeStatuses`' wide set; see `CHAIN_SCOPE_TENANT_STATUSES`. */
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

/**
 * What `--integrity-proof` mounts: the schema's own defaults plus `allTenants`, and nothing else.
 *
 * `DEFAULT_CHECKPOINT_CONFIG`'s shape and its reasons, which hold a notch harder here: the empty
 * config this replaces resolves to the platform chain alone, and a pass over an empty scope is
 * discarded entirely — so `--integrity-proof-config` over `{}` is a control that reports healthy
 * over a population it never read, which is this repository's most-found defect class. `escalation`
 * stays absent, so a deployment that wants a page declares the alert policy itself.
 */
export const DEFAULT_INTEGRITY_PROOF_CONFIG: IntegrityProofConfig =
  IntegrityProofConfigSchema.parse({ allTenants: true });

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
 * Re-exported from `anchor-audit.ts`, which owns the witness this check compares and now owns the
 * check (see `chainTruncation` there for why, and for the caller it was missing).
 */
export type { ChainTruncationCheck } from "./anchor-audit.js";

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
  /**
   * What a **prior** verdict attested about this scope, and whether this pass agrees with it.
   *
   * The fourth axis, and the first that is not a reading of a table *now*. Every axis above is a
   * single-pass check over `(chain, anchors, audit rows)`, and two edits produce a state that is
   * internally consistent — so each of them is right and none of them can refuse those two. See
   * `witness-memory.ts` for the pair and the live measurements.
   *
   * Deliberately **not** in `canonicalStoredReport`/`integrityVerdictPayload`: adding a field there
   * changes the bytes every stored verdict's digest was computed over, which is the parity ADR-0371
   * reverted a field to preserve. The *verdict* this axis can change is already in those bytes; the
   * reasoning behind it is a diagnostic, rendered where diagnostics are read, exactly as
   * `fullBecause` is.
   */
  readonly witnessMemory: WitnessMemoryCheck;
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
    /**
     * What a prior verdict attested about this scope, for the one axis that is about history.
     *
     * **Optional**, and its absence is `not_recorded` — a value on the report and a line in the
     * unattended output, so the omission is observable. That is what keeps it clear of ADR-0386's
     * trap, which is an optional field whose default makes its own omission *unobservable*; here a
     * deployment that records no verdicts says so on every pass. `buildIntegrityProofLifecycle`
     * supplies it exactly when `recordVerdict` is on, which is the same condition that builds the
     * store — so the producer exists precisely when there is something to read (ADR-0341's rule).
     */
    readonly witnessMemory?: WitnessMemorySource;
  },
): Promise<IntegrityProofReport> {
  // Read order is part of this proof, and the rule is **directional**: of two reads whose values
  // are then compared, the side that must be the LARGER is read second.
  //
  // Every table read here is append-only for every writer that ships — and the premise is measured
  // over all **four** tables this function reads rather than the two an earlier version of this
  // parenthetical named, which were precisely the two the rule does *not* turn on. Through
  // `scanWorkspaceSql()` over 940 files, `meta.forensic_chain_entries`,
  // `meta.forensic_chain_checkpoints`, `meta.audit_log` and `meta.audit_integrity_verdicts` each
  // carry **one `INSERT` and zero `UPDATE`/`conflict_update`** statements, with no `DELETE FROM`,
  // `TRUNCATE` or `UPDATE <table>` anywhere in non-test source; both `record` methods are
  // `ON CONFLICT … DO NOTHING`; all four carry `retainedRecordNoTenantDelete` and are
  // `RETAINED_SHARED_TABLES` members, so the Article 17 erasure retains them and ADR-0400's fence
  // denies a tenant-context `DELETE`. **The scope of the premise is "every writer that ships" and
  // not "everything a tamperer can do"**: all four tables' isolation arm is `ALL`-scope with a NULL
  // `WITH CHECK`, so a tenant-context `UPDATE` is reachable on each, and dropping that qualifier
  // turns the premise into a claim it does not support (the harness in ADR-0407 measures 20.99%
  // forging once it is relaxed).
  //
  // So an honest write landing between two reads can only ADD rows — which makes a containment or an
  // inequality easier to satisfy when the containing side is read later, and MANUFACTURES a finding
  // when it is read earlier. The comparisons, each with the read that must come second:
  //
  //   a prior verdict's chain entry  ∈   the chain        → the chain, after the baseline
  //   each audit row's chain entry   ∈   the chain        → the chain, after the rows
  //   a prior verdict's witness      ≤   the anchor scan  → the scan, after the baseline
  //   the anchor witness             ≤   the tail         → the tail, after the anchor scan
  //   each anchor                    ~   the chain        → order-free
  //
  // The fourth was already right and says so at its own read. The fifth is order-free because
  // `disagreementFor` treats an anchor the chain does not reach as the truncation check's subject
  // rather than as a disagreement — so a newer anchor than this snapshot is benign there by design,
  // which is the same asymmetry the second comparison does **not** have.
  //
  // **The third pair is real, is the one an earlier version of this list omitted, and needs no
  // fence of its own** — the omission mattered because it is a *second* false-positive class from
  // the same inverted read: `compareWitnessMemory` compares `attestedWitness` against
  // `current.checkpointSequence`, which comes from the anchor scan below, so the pre-fix order
  // forged `witness_regressed` / `ANCHORS LOST` on an honest sibling replica anchoring one entry
  // and recording the verdict attesting it (measured: OLD `witness_regressed` compromised at
  // checkpointSequence 3 against NEW `consistent` verified at 7, every entry and every anchor
  // present in both arms). It is satisfied **for free and structurally**: `auditAnchors` takes
  // `correspondenceChain`, which is derived from `chainRead`, so the scan cannot be hoisted above
  // the chain read without a compile error — therefore any order satisfying the first pair
  // satisfies this one. That implication is the fence, which is why there is no test for it, and it
  // is stated here because an edit giving `auditAnchors` its own chain read — which the comment at
  // the `loadChain` below explicitly contemplates refusing — would re-open the forgery with every
  // test green.
  //
  // The first three pairs were inverted — **three pairs over two reads**, which is why the count of
  // moved statements understates the classes closed — and each was measured forging a paging `sev1`
  // on a chain that verifies by hand. The two claim reads are here, first, for that reason; between
  // themselves the order is free, because neither is compared against the other.
  //
  // What the reorder does **not** buy is a shorter detection latency, and the symmetry is worth
  // stating because ADR-0407 claimed dominance for one comparison and then the other, and had to
  // withdraw both. It does not: a persistent tamper is caught by the first pass whose relevant read
  // follows it — the claim-side read for a row or verdict edit, the containing-side read for a chain
  // edit — and there is exactly one such read per interval under **either** order, so the expected
  // latency is half an interval both ways. Moving a read shifts *which* pass catches a given instant
  // and nothing else. So the whole gain is the false positives, and the cost is that each order
  // defers the other's class by one pass — with one asymmetry that is not in the reorder's favour:
  // the deferred class (an edited audit row) has exactly **one** detector in the workspace, since
  // `canonicalAuditEntryPayload` has two non-test call sites, the writer and `verifyAuditAnchors`'
  // recompute, while a chain edit also fails `verifyChainIntegrity` as a sequence gap or
  // `verifyChainSignatures` over bytes that cover `payloadSha256`.
  const priorVerdict = deps.witnessMemory === undefined ? null : await deps.witnessMemory(scope);

  // Read **before** the chain, which is the whole of the second fix. `verdictFor` answers
  // `anchor_missing` for a row whose anchor sequence is absent from the chain it was handed,
  // `anchor_missing` is in `TAMPERED`, and `audit_row_tampered` is a compromise cause — so a row
  // committed between the chain read and this one was read as a tampered audit row. It is not a
  // narrow window: `listAnchoredForScope` is `ORDER BY occurred_at DESC LIMIT n`, so it reads the
  // NEWEST rows, which is exactly the population written while the pass runs, and the gap used to
  // span the whole paged anchor scan. `emit` appends the chain entry and inserts the row in ONE
  // transaction, so a row visible here has its entry visible too, and a chain read afterwards holds
  // it — which is what makes this ordering a proof rather than a smaller window.
  //
  // Measured on one replica, one process, no tamper, with `--audit-read-routes` driving the emitter
  // (every recorded read writes an anchored row): **90 of 140 verdicts `compromised`** while rows
  // were being emitted against **0 of 84** on the same server with nothing emitting, zero audit
  // rows whose anchor was really absent, and the report itself printing `integrity valid, signatures
  // valid` one line above `COMPROMISED`.
  const audit = await deps.audit.listAnchoredForScope(scope, { limit: deps.auditRowLimit });

  const chain = deps.fromCheckpoint
    ? await verifyChainFromCheckpoint(deps.logStore, deps.registry, deps.checkpoints, scope)
    : await verifyChainFull(deps.logStore, deps.registry, scope);

  // The anchor check needs the entries the rows point at, which a checkpoint-bounded suffix may not
  // contain, so it always reads the whole chain. The chain *half* stays bounded — which is why this
  // read's own refusals are carried out separately rather than assumed to be the chain half's: see
  // `chainRowsRefused`.
  //
  // The sentence that used to end this paragraph — *"an audit row pointing at a refused entry is
  // `unanchored` to `verifyAuditAnchors`, and ADR-0286 deliberately does not page on that, so the
  // fact has to reach the verdict by the axis that does"* — is **false, and in the direction that
  // understates**. `verdictFor` answers `unanchored` only for `anchor === null`; a row whose anchor
  // sequence is absent from the entries that *parsed* answers `anchor_missing`, which is in
  // `TAMPERED`, so it reaches the verdict as `audit_row_tampered` and does page. The verdict is
  // unchanged, because `chain_row_refused` already answers `compromised` for such a chain — what is
  // wrong is the **attribution**: an operator is sent to the audit row when the chain row is the
  // one the reader refused. The targeted repair is the `correspondenceChain === null` rule applied
  // to a third consumer, and it is not free (withholding the whole check would lose every other
  // row's `hash_mismatch`), so it is named as a follow-up rather than guessed at here.
  //
  // Read **here**: below the two claim reads above, because the rows and the baseline are compared
  // *against* these entries and the containing side is read second; and above the anchor audit,
  // rather than two statements lower where it used to sit, because that audit cross-checks every
  // anchor against the chain and this function already performed the read. A second read for the
  // audit would be a second snapshot of the same table, and an anchor compared against a chain the
  // report does not carry is a finding nobody can re-derive from the report.
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
  // `latest()` and `tail()` were in. This is the third comparison in the rule at the top of this
  // function, and the one that was already right: `truncated` needs `tail < witness`, so the tail
  // is the side that must be the larger and is therefore read second. Widening the gap between them
  // with a whole-table scan cannot manufacture a finding — an append in the window only ever clears
  // the check and a delete in the window is a truncation that really happened.
  //
  // Reading them the other way round would forge `chain_truncated` **with honest writers only**,
  // which is worth stating because the fix above moves two other reads and this one must not move
  // with them: an anchor ahead of this pass's chain snapshot is deliberately not a disagreement
  // (clause 4 of `disagreementFor`), so it counts toward the witness — and measured against a tail
  // read one statement too early, `chainTruncation(7, 5)` answers `truncated: true`.
  const tail = await deps.logStore.tail(scope);
  const truncation = chainTruncation(anchorAudit.witnessSequence, tail?.sequenceNumber ?? null);

  const anchors: AuditAnchorReport = verifyAuditAnchors(
    scope,
    audit.rows,
    chainRead.entries,
    audit.unreadable,
  );

  // Compared against `correspondenceChain` rather than `chainRead.entries` for the reason the audit
  // is: over a chain the reader refused a row of, an entry the prior verdict names may be one of
  // the refused ones, and calling that *the chain no longer holds it* would attribute a finding to
  // the wrong table. `chain_row_refused` already answers `compromised` for such a chain, so
  // withholding this costs no verdict.
  //
  // The **comparison** is here, last, where it always was; the **read** is at the top of this
  // function. The comment that used to stand here conflated the two — *"read after the anchor audit
  // and the tail, so the comparison is against figures this pass has already settled"* — which is a
  // reason for when the comparison is made and no reason at all for when the value is read, and it
  // put the two sides of the comparison in the wrong temporal order: an attestation read LATER than
  // this pass's chain can name an entry the chain was read too early to hold. Measured across two
  // replicas over one scope: 19 of 240 verdicts `compromised` on a sound chain (ADR-0406), and the
  // same inversion forges `witness_regressed` as well, which that ADR did not name.
  const witnessMemory = compareWitnessMemory({
    read: priorVerdict,
    current: truncation,
    chain: correspondenceChain,
    currentScanComplete: anchorAudit.complete,
  });

  return {
    scope,
    verdict: integrityVerdictFor(
      chain,
      anchors,
      truncation,
      chainRead.unreadable,
      anchorAudit,
      witnessMemory,
    ),
    verifiedAt: deps.now().toISOString(),
    chain,
    anchors,
    truncation,
    chainRowsRefused: chainRead.unreadable,
    anchorAudit,
    witnessMemory,
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
  // The two memory causes come **last**, and the precedence is the whole reason to care: a genuine
  // truncation with the anchors left alone exhibits `chain_truncated` *and* nothing else, while the
  // same truncation with the anchors lowered onto it exhibits only these. So an operator meeting a
  // real cut is still sent to the chain, and one meeting a laundered cut is sent to the anchor
  // table and the prior verdict — which are the two rows that were edited.
  "witness_regressed",
  "verdict_disagrees_with_chain",
] as const;
export type CompromiseCause = (typeof COMPROMISE_CAUSES)[number];

/**
 * The facts a compromise is judged from, and the one shape both readers hand over.
 *
 * Structural rather than an `IntegrityProofReport`, because `integrityVerdictFor` runs while that
 * report is being *built* — the verdict is one of its fields — so a cause function taking a report
 * could not be the one the verdict is computed through, and two implementations of this judgement
 * are exactly what the escalation row's two-of-six already cost. A whole `IntegrityProofReport`
 * satisfies it, so the escalator asks the same function about the same facts.
 *
 * (That last sentence said "the same five fields" and the count is **six** since the memory axis
 * landed. It is a count of this interface's own members, which is exactly the quantity that goes
 * stale — so it names the facts rather than counting them now.)
 */
export interface CompromiseEvidence {
  readonly chain: ChainVerificationReport;
  readonly anchors: AuditAnchorReport | null;
  readonly truncation: ChainTruncationCheck;
  readonly chainRowsRefused: readonly UnreadableRow[];
  readonly anchorAudit: AnchorAuditReport;
  /**
   * **Required**, so nothing reaches this judgement holding no answer on the one axis that is about
   * history rather than about a table. A whole `IntegrityProofReport` satisfies it, which is what
   * keeps the escalator asking the same function about the same facts; a fixture that omits it is a
   * compile error, which is the fence rather than a permissive default it could inherit.
   */
  readonly witnessMemory: WitnessMemoryCheck;
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
  // Two causes for one axis, because the two findings send an operator to different rows: a
  // regression says the anchor table holds less than it did, and a contradiction says the chain no
  // longer holds the entry a prior verdict was anchored in. Either alone refuses the lowering
  // attack, which is why both are here rather than one `witnessMemoryDisproves`.
  //
  // Each names its outcome, so what no *type* can fence is a ninth `WITNESS_MEMORY_OUTCOMES` member
  // graded `disproves` and named by neither predicate — which would be `compromised` to
  // `witness-memory.ts` and invisible to this judgement. `integrity-proof.test.ts` closes that by
  // asserting the two sets agree in both directions: every outcome graded `disproves` is named by
  // exactly one cause here, and every cause here names a real outcome.
  witness_regressed: (e) => e.witnessMemory.outcome === "witness_regressed",
  verdict_disagrees_with_chain: (e) => e.witnessMemory.outcome === "prior_verdict_contradicted",
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
  witnessMemory: WitnessMemoryCheck,
): IntegrityVerdict {
  const causes = compromiseCauses({
    chain,
    anchors,
    truncation,
    chainRowsRefused,
    anchorAudit,
    witnessMemory,
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
  // The memory axis's own non-finding: a prior verdict exists and cannot be trusted, so this axis
  // established nothing. Graded `unproven` rather than `compromised` for the asymmetry argued at
  // `WITNESS_MEMORY_GRADE` — the verdict row is a *projection* whose writer swallows a failed write
  // and calls the chain entry the record of record, and ADR-0373's forward hazard (a required field
  // added to a `.strict()` stored shape) would otherwise be a paging sev1 caused by a schema
  // evolution. The other five non-finding outcomes carry no claim at all and reach neither arm.
  if (witnessMemoryUnproven(witnessMemory)) return "unproven";
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
  /**
   * Fires when a tick finds a pass already in flight and performs none.
   *
   * **Required**, where `onPass` and `onFinding` are not, and the asymmetry is the whole reason the
   * callback exists rather than a counter: a skipped pass is a skipped *detection*, and the only
   * state in which that is fatal — a scope whose fold never fits the interval, so every tick skips
   * — is precisely the state in which no other callback ever fires again. A counter with a getter
   * would be read by `onPass`, which that scope never reaches; silence would then be
   * indistinguishable from a healthy quiet deployment, and `[integrity-proof]` would be true of the
   * timer and false of the verification (ADR-0374's rule: a detector going quiet is the dangerous
   * direction). `CheckpointSchedulerOptions.onRefused` is required for the same shape of reason.
   *
   * It fires on **every** skipped tick and is deliberately not deduplicated. For a stuck scope that
   * is the signal and not noise: the line an operator needs is that the proof has not run, repeated
   * for as long as it has not run.
   */
  readonly onPassSkipped: (reason: IntegrityPassSkipReason) => void;
}

/**
 * Why a tick performed no pass. One member today, and an enum rather than a bare call so a second
 * reason (a circuit breaker, a maintenance window) cannot arrive as an unexplained silence.
 */
export const INTEGRITY_PASS_SKIP_REASONS = ["pass_already_in_flight"] as const;
export type IntegrityPassSkipReason = (typeof INTEGRITY_PASS_SKIP_REASONS)[number];

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
  private inFlight = false;

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

  /**
   * One proof pass over every scope. Never rejects — a per-scope error is captured + routed.
   *
   * A pass already in flight makes this a no-op returning `[]`, and the guard is not cost hygiene
   * copied from the sibling scheduler — it bounds the **heap**, which is what binds here.
   * `proveScopeIntegrity` loads the whole chain **unconditionally** (see its `loadChain`, read
   * above the anchor audit because the audit cross-checks every anchor against it), so a checkpoint
   * bounds the signature CPU and not the memory: one pass holds one scope's entire chain whatever
   * `fromCheckpoint` answers. `intervalMs` is therefore no lever at all on the quantity that binds
   * — it changes how often a pass runs and not what one pass holds — so peak heap is identical at a
   * one-hour and a six-hour interval and only the overlap count moves it.
   *
   * Three changes composed to make this reachable rather than theoretical, all of them ADR-0406's:
   * `--integrity-proof` is defaulted on in the shipped compose, the scope set widened from
   * `["active"]` to all five `TENANT_STATUSES` so retired tenants are scopes, and that ADR's own
   * open question 3 records that an **idle** retired scope re-folds on *every* pass for ever,
   * because `record`'s `ON CONFLICT … DO NOTHING` never replaces its anchor and nothing will ever
   * append to it. So k overlapping passes hold k whole chains, and the failure is not a wrong
   * verdict but the detector going down.
   *
   * The cost is stated rather than discovered: a guarded tick is a **skipped detection**, so this
   * trades latency for survival and is adaptive rather than free — which is why `onPassSkipped` is
   * required. It also does **not** cover the other overlap: both schedulers default `runOnStart`
   * and `node.ts` starts them back to back unawaited, so at boot a checkpoint pass and a proof pass
   * run concurrently, each holding a chain. That is two schedulers rather than one and no
   * per-scheduler guard can see it; sequencing them would make a memory property depend on a start
   * order in a third file, which is the shape ADR-0371 refused for soundness.
   */
  async runOnce(): Promise<readonly IntegrityProofPassResult[]> {
    const results: IntegrityProofPassResult[] = [];
    if (this.inFlight) {
      this.opts.onPassSkipped("pass_already_in_flight");
      return results;
    }
    this.inFlight = true;
    try {
      return await this.pass(results);
    } finally {
      this.inFlight = false;
    }
  }

  private async pass(
    results: IntegrityProofPassResult[],
  ): Promise<readonly IntegrityProofPassResult[]> {
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
  // A scope a prior verdict attested history for is **not** a scope with nothing to verify, whatever
  // its three tables now hold. Without this clause the strongest form of the anchor `DELETE` is the
  // quietest thing a tamperer can do: destroy a tenant's chain *and* its anchors and every axis
  // answers `verified`, so this predicate called it new and the pass **discarded the report** —
  // measured through the real `IntegrityProofScheduler` as `outcome: "skipped_empty"` with zero
  // callbacks, no `onPass`, no `onFinding`, no stored row and no escalation.
  //
  // It reads the memory's *figures* rather than its outcome, and that is the load-bearing part: by
  // the time this is asked the verdict is already `compromised` for a regression, so the verdict
  // clause above would have caught that case on its own. What this clause adds is the one the
  // verdict cannot reach — a prior verdict that is `prior_unanchored` or `unverifiable_here`, which
  // carry no claim and so leave the verdict `verified` while still *proving* the scope had history.
  //
  // The residual is stated rather than hidden: a scope destroyed before anything ever attested it
  // has no memory to refute "this scope is new", and is genuinely indistinguishable from one.
  const hadHistory = witnessMemoryShowsHistory(report.witnessMemory);
  return (
    report.verdict === "verified" &&
    chainEmpty &&
    noAuditRows &&
    !hadHistory &&
    readEveryRowFound(report)
  );
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
    //
    // A **third** arm since the memory axis, and it is the one the register named this whole class
    // for: *"run the checkpoint scheduler"* is the remedy that cannot work for a scope whose
    // anchors were **destroyed**, and until there was a memory nothing could tell that scope from
    // one that has simply never been anchored. Worse than useless, because running the scheduler
    // *re-anchors at the then-current tail* — measured, `ON CONFLICT … DO NOTHING` does not fire
    // for a row that is gone — which puts a fresh witness past the destroyed entries and makes the
    // truncation permanently unprovable. So the one arm that used to send an operator to the
    // scheduler is now the arm that tells them not to.
    // `witnessMemoryShowsAnchors` and **not** `witnessMemoryShowsHistory`, which is what stood here
    // and which is a wider question: history is *a tail or a witness*, and a prior verdict attesting
    // only a tail belongs to a scope that has a chain, has been verified, and has never been
    // anchored. For that scope the sentence below was false in both halves — it HAD no anchors, and
    // running the scheduler is exactly the remedy — so the one arm written to stop an operator
    // destroying the evidence was telling the one operator who should run the scheduler not to.
    // The configuration that reaches it is **the two schedulers covering different scopes** — a
    // deployment running the proof with no checkpoint scheduler, or two configs differing in
    // `tenants`, `includePlatform` or `tenantStatuses` — and *not* a checkpoint pass that found
    // nothing to anchor, which is what this comment claimed as a live measurement until ADR-0407's
    // review: that pass skipped on `tail === null`, so its scope's chain was empty, so the baseline
    // attests no tail either and this arm is never reached. See `witnessMemoryShowsAnchors` for the
    // derivation and for the two residuals the narrowing leaves. The false arm falls through to the
    // sentence below, which names the right remedy for it.
    lines.push(
      witnessMemoryShowsAnchors(report.witnessMemory)
        ? "  truncation: not checkable, and this scope HAD anchors — do NOT run the checkpoint" +
          " scheduler, which would anchor past the gap and make this unprovable"
        : anchorAuditHasFindings(report.anchorAudit)
          ? "  truncation: not checkable (no checkpoint this audit will stand behind — see below)"
          : "  truncation: not checkable (no checkpoint yet — run the checkpoint scheduler)",
    );
  }
  // The memory axis, silent on `consistent` — see `formatWitnessMemory` for why that one is the
  // only silent outcome.
  for (const line of formatWitnessMemory(report.witnessMemory)) lines.push(line);
  // Beside the chain and anchor refusals rather than inside the `anchors !== null` block, because
  // this axis is answered on every pass: `anchorAudit` is a **required** field that
  // `proveScopeIntegrity` computes unconditionally, so a scope with no anchored rows at all still
  // reports what its checkpoints say. (The reason given here until ADR-0407 was *"the anchor table
  // is read before the audit rows are looked at"*, which that increment **inverted** — the rows are
  // read first now — in the one increment whose whole subject is read order. The conclusion was
  // always right and the reason was always the wrong one: an ordering cannot establish that a field
  // is present, only that its value is fresher than something, and what this placement needs is
  // that the field exists.)
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
  /** Required here too, so the compile error reaches the one non-test construction site. */
  readonly onPassSkipped: (reason: IntegrityPassSkipReason) => void;
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
        // Supplied exactly when the store exists, which is `recordVerdict` — so the reader and the
        // writer of this memory are turned on by one flag and a deployment cannot hold one without
        // the other. `attestedWitnessFrom` owns the catch, because `rowToRecord` **throws** for a
        // stored verdict the contract refuses or one that disagrees with itself, and letting that
        // escape here would make the pass file `outcome: "error"` — no verdict, no finding, no
        // page. That is ADR-0374's defect exactly, on a read this increment adds to the hourly
        // path, so the refusal is routed at the seam rather than left to whoever calls it.
        ...(verdicts !== null
          ? { witnessMemory: (s: string | null) => attestedWitnessFrom(verdicts, s) }
          : {}),
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
    // Not a conditional spread: required on both interfaces, so there is no absent case — and a
    // spread here is the shape ADR-0386 found silently dropping a field past the excess-property
    // check.
    onPassSkipped: opts.onPassSkipped,
  });

  return { scheduler, runOnce: () => scheduler.runOnce() };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
