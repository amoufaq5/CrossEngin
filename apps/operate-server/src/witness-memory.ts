import type { ChainedLogEntry } from "@crossengin/forensics";

import type { ChainTruncationCheck } from "./anchor-audit.js";

/**
 * What a **prior** verdict attested about this scope's anchor table, and whether this pass's
 * reading of that table is consistent with it.
 *
 * Every check over the anchor table before this one was a single-pass check over
 * `(anchors, chain)`, and two edits produce a state that is *internally consistent* — so no amount
 * of care inside one pass can refuse them. Measured live as the non-owner `serving` role on
 * PG 16.15, six entries and anchors at 1, 3 and 5:
 *
 *   - **The two-column lowering.** Destroy entries 3..5, then `UPDATE … SET sequence_number = …,
 *     root_hash = …` the two stranded anchors down onto surviving entries, taking those entries'
 *     hashes with them. `verdict=verified witness=2 tail=2 truncated=false disagree=[]` — three
 *     destroyed entries, and a report byte-identical to a healthy scope that only ever held two.
 *     `disagreementFor`'s **agreement** arm, not its fall-through: the anchor really does agree
 *     with the chain that survives. (`disagreementFor`'s own comment attributes this to the
 *     fall-through, which is true of the *raising* form and false of this one.)
 *   - **The anchor `DELETE`.** `DELETE FROM meta.forensic_chain_checkpoints WHERE tenant_id = $1` —
 *     3 rows as `serving`, because that table's isolation arm is `ALL`-scope so its `USING` doubles
 *     as its `WITH CHECK` and it carries no `DELETE` arm. `witness=null`, every count 0, and
 *     `formatChainTruncation` prints *"not checkable (no checkpoint yet — run the checkpoint
 *     scheduler)"* for a scope whose checkpoints were destroyed (ADR-0334's remedy that cannot
 *     work). Worse than that sentence: with the chain *also* cut it reads `verified` while hiding a
 *     real truncation, and with the chain cut to **nothing** `isEmptyScope` answers true and the
 *     pass **discards the report entirely** — measured through the real `IntegrityProofScheduler`,
 *     `outcome: "skipped_empty"` with **zero** callbacks: no `onPass`, no `onFinding`, no stored
 *     row, no escalation. Total destruction is quieter than tamper.
 *
 * What refutes both is the deployment's own prior verdict, and the figures are already in the
 * **signed** bytes: `canonicalStoredReport` and `integrityVerdictPayload` commit
 * `truncation.checkpointSequence` *and* `truncation.tailSequence`, so a stored verdict attests the
 * **pair**. (ADR-0375's open end names only the witness; the tail is what makes the second detector
 * below possible.) `recordVerdict` defaults to `true`, so the memory exists wherever
 * `--integrity-proof-config` is passed.
 *
 * The chain stores `payload_sha256` and **no payload column**, so the figures are *pinned* by the
 * chain and *readable* only from the verdict row. That makes the trust argument three-legged, and
 * the third leg is the one that had no caller:
 *
 *   1. the row's `report` against its own `payload_sha256` — `storedReportMismatches`, which runs
 *      inside `rowToRecord` on every read and **throws**;
 *   2. the row's `payload_sha256` against the chain entry it names — **this module**, and
 *      `storedReportMismatches`' own comment is the specification for it: *"editing both still
 *      leaves a digest that no longer matches the chain entry, which is the point of keeping the
 *      proof outside this table"*;
 *   3. the chain entry against its hash links and signature — what the pass already does.
 *
 * So a tamperer who lowers the anchors must also edit the verdict row (leg 1 catches it), and its
 * digest (leg 2), and the chain entry carrying that digest (leg 3 — which breaks `entry_hash`,
 * because `canonicalEntryBytes` covers `payload_sha256`, and therefore the signature).
 */
export const WITNESS_MEMORY_OUTCOMES = [
  /** No verdict store was supplied, so this deployment records no verdicts to remember. */
  "not_recorded",
  /** The store was asked and holds no verdict for this scope: a first pass. */
  "no_prior_verdict",
  /**
   * The newest stored verdict could not be read, or does not agree with itself.
   *
   * One outcome for two causes on purpose, because they are not separable at the read and their
   * remedy is the same — look at that row. `rowToRecord` throws a `ZodError` for a shape the
   * contract refuses and a plain `Error` for a `storedReportMismatches` disagreement, and a
   * deployment cannot tell a schema evolution from a tamper from here.
   */
  "prior_unreadable",
  /**
   * The newest stored verdict carries no chain anchor, so nothing pins its figures.
   *
   * Reachable without tamper: `record()` swallows a failed row write, and a pass configured
   * `recordVerdict: false` appended nothing, so a row from such a pass has both halves null.
   * ADR-0286's rule — an unanchored row is unproven and not disproven.
   */
  "prior_unanchored",
  /**
   * Its chain entry is outside the entries this pass loaded, so the comparison is not available
   * *here*. A bounded pass reads only the suffix after the anchor, which is the whole point of
   * being bounded; this says so rather than folding the prefix to answer a side question.
   */
  "unverifiable_here",
  /**
   * The chain does not hold the entry the prior verdict was anchored in, or holds it carrying a
   * different payload digest.
   *
   * **A second detector for the lowering attack, independent of the witness**: the prior verdict's
   * own chain entry sits at some sequence, and a truncation that removes it is refuted by its
   * absence whatever the anchor table was edited to say.
   */
  "prior_verdict_contradicted",
  /** The attested figures are consistent with what this pass read. */
  "consistent",
  /**
   * A prior verdict attested a **higher** witness than this pass can find.
   *
   * The finding this module exists for. Measured against the committed tree with the workspace's
   * own SQL scanner rather than a pattern: both forensic tables carry **one `INSERT` and no
   * `UPDATE`, `DELETE` or `TRUNCATE` statement anywhere**, `record` is `ON CONFLICT … DO NOTHING`
   * so no checkpoint row is ever modified, and both are `PLATFORM_RECORD_TABLES`, so the Article 17
   * erasure **retains** them. Nothing lawfully removes or lowers an anchor.
   *
   * The parenthetical that used to stand here — *"the only reapers are the idempotency and
   * design-job ones and the dangling-link pruner"* — is understated as a delete census: the scanner
   * finds **8 `DELETE` references over 6 tables**, the three named plus
   * `notification_fax_observations`, `notification_preferences` and `tenant_data_keys`. The three
   * unnamed are request-driven rather than scheduled sweeps, so the clause survives as a census of
   * *scheduled reapers* and read as a complete one, which it is not. What the argument needs is the
   * first paragraph's claim about these two tables, which is exact.
   *
   * **`witnessSequence` is nonetheless not monotone, which an adversarial measurement found and
   * which this outcome is gated for.** `auditAnchors` excludes a contradicted anchor from the
   * witness, and that exclusion is conditional on a chain being supplied — which
   * `proveScopeIntegrity` decides for itself, passing `null` whenever the chain reader refused a
   * row. Measured on one *unchanged* anchor table (anchors at 3 and 5, the one at 5 carrying
   * sequence 1's hash): **witness 3 with a chain and 5 without**. So two passes can read one table
   * and disagree.
   *
   * It is not a false-compromise path, and the reason is worth stating rather than trusting: the
   * exclusion fires only for a *disagreement*, so the lower reading always carries
   * `checkpoint_disagrees_with_chain` — measured, `causes = ["checkpoint_disagrees_with_chain"]` —
   * and that is already `compromised`. What the non-monotonicity can produce is a **redundant
   * second cause** on an already-compromised pass, which is two true statements about one scope.
   *
   * The one reading that *would* have been unsound is a regression concluded from a witness that is
   * a **lower bound**, because a cause outranks `!anchorAudit.complete` — measured: a memory cause
   * on an incomplete scan answers `compromised` where the scan alone answers `unproven`. So the
   * comparison is gated on the current scan having finished, and an unfinished one answers
   * `witness_not_comparable` instead.
   */
  "witness_regressed",
  /**
   * This pass's witness is a **lower bound**, so a drop cannot be concluded from it.
   *
   * `auditAnchors` scans ascending to `CHECKPOINT_SCAN_CEILING`, so a cut scan reads the *oldest*
   * rows and its witness is the highest among those. Comparing that against an attested witness
   * would read a coverage gap as a destroyed anchor — and because a cause outranks `!complete`,
   * it would page. `unproven` is already this pass's verdict on that axis; this says why on the one
   * line that is about history.
   */
  "witness_not_comparable",
] as const;
export type WitnessMemoryOutcome = (typeof WITNESS_MEMORY_OUTCOMES)[number];

/**
 * What each outcome licenses, over the same three-valued axis `integrityVerdictFor` already answers
 * on — which is ADR-0372's distinction made explicit rather than inferred from a boolean.
 *
 * `prior_unreadable` is **`unproven` and not `disproves`**, which is the one grade worth arguing.
 * Its two siblings one table over are `compromised` (ADR-0373 for a chain row, ADR-0374 for an
 * anchor row) and the asymmetry is deliberate: those are rows *in the table being verified*, while
 * this is a row in a **projection** whose own writer calls the chain entry "the record of record"
 * and swallows a failed write. Grading the projection's health `compromised` would let a failed
 * `record()` page somebody, and it would make ADR-0373's stated forward hazard — a required field
 * added to a `.strict()` stored shape turning every stored row unreadable — a paging `sev1` caused
 * by a schema evolution.
 *
 * The cost is stated rather than hidden: a tamperer who corrupts the prior verdict row degrades
 * this axis from `compromised` to `unproven`. That is strictly better than the state it replaces
 * (`verified`, silently), it is visible on the hourly line and in `--audit-verdict-routes`, and
 * `storedReportMismatches` names the field that disagrees — so the corruption is itself evidence
 * rather than a clean exit.
 */
export const WITNESS_MEMORY_GRADE: Readonly<
  Record<WitnessMemoryOutcome, "disproves" | "unproven" | "no_claim">
> = {
  not_recorded: "no_claim",
  no_prior_verdict: "no_claim",
  prior_unreadable: "unproven",
  prior_unanchored: "no_claim",
  unverifiable_here: "no_claim",
  prior_verdict_contradicted: "disproves",
  consistent: "no_claim",
  witness_regressed: "disproves",
  // `no_claim` and not `unproven`, because the thing it cannot establish is already `unproven` from
  // `!anchorAudit.complete` — grading it again here would be one fact answered twice, and the
  // second answer would be the one a reader could not trace to the scan.
  witness_not_comparable: "no_claim",
};

/** The figures a prior verdict attested, as the stored row carries them. */
export interface AttestedWitness {
  readonly witnessSequence: number | null;
  readonly tailSequence: number | null;
  readonly verifiedAt: string;
  /** The digest the chain entry committed to, or null for a row written without one. */
  readonly payloadSha256: string | null;
  readonly chainEntryHash: string | null;
  readonly chainSequenceNumber: number | null;
}

/**
 * What a read of the prior verdict answered — three outcomes, because the refusal must be **routed
 * rather than thrown**.
 *
 * `rowToRecord` throws for a stored verdict the contract refuses, and this read is new on the
 * hourly path: letting it escape would make the pass file `outcome: "error"` and so produce no
 * verdict, no finding and no page. That is ADR-0374's defect precisely — a tamper disabling the
 * detector — and it would be committed by the increment that exists to close its sibling. The seam
 * catches it and names it, exactly as `verifyChainFromCheckpoint` catches `CheckpointRowUnreadable`.
 */
export type AttestedWitnessRead =
  | { readonly kind: "attested"; readonly attested: AttestedWitness }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * Reads the newest verdict a scope has stored. Supplied exactly when a deployment records verdicts,
 * so its absence means `not_recorded` rather than a default that cannot be distinguished from a
 * clean answer (ADR-0386's trap: an optional field whose default makes its own omission
 * unobservable — here the omission is on the report and on the boot line).
 */
export type WitnessMemorySource = (
  scope: string | null,
) => Promise<AttestedWitnessRead>;

export interface WitnessMemoryCheck {
  readonly outcome: WitnessMemoryOutcome;
  /** The attested witness, when one was read. `null` carries no claim about the table. */
  readonly attestedWitness: number | null;
  readonly attestedTail: number | null;
  readonly attestedAt: string | null;
  /** Why, for the outcomes that have something to say. Never a value from the chain or a row. */
  readonly detail: string | null;
}

function noClaim(outcome: WitnessMemoryOutcome, detail: string | null): WitnessMemoryCheck {
  return { outcome, attestedWitness: null, attestedTail: null, attestedAt: null, detail };
}

/**
 * A memory that was **not consulted**, for a caller building a report by hand.
 *
 * `noAnchorFindings`' shape and its reason: the required field is what forces every call site to
 * say what it holds, and a fixture asserting something about another axis needs a way to say *this
 * one carries no claim* without inventing figures. A function rather than a frozen constant for the
 * same reason that one is — it is returned into reports a test then mutates.
 *
 * `not_recorded` and deliberately not `consistent`: `consistent` asserts a prior verdict was read
 * and agreed, which is a claim no fixture passing this means to make, and it is the one outcome
 * `formatWitnessMemory` is silent on — so a fixture built from it would be asserting the clean
 * answer rather than the absent one.
 */
export function noWitnessMemory(): WitnessMemoryCheck {
  return noClaim("not_recorded", null);
}

/**
 * Compares a prior verdict's attested figures against this pass's reading of the anchor table.
 *
 * `chain` is the entries this pass loaded, or `null` when it holds none it can compare against —
 * which is the same provenance rule `integrity-proof.ts` applies to the correspondence half, for
 * the same reason: a comparison against an incomplete chain would attribute a finding to the wrong
 * table.
 *
 * The order of the clauses is the order of what can be established. Trustworthiness first, because
 * a figure read out of a row nothing pins is not evidence; then the comparison. A reader following
 * this function should know that the **regression is the decisive clause and the contradiction is
 * independent of it** — either alone refuses the lowering attack.
 */
export function compareWitnessMemory(input: {
  readonly read: AttestedWitnessRead | null;
  readonly current: ChainTruncationCheck;
  readonly chain: readonly ChainedLogEntry[] | null;
  /**
   * Whether this pass's anchor scan reached the end. **Required**, because a regression concluded
   * from a lower-bound witness would page — see `witness_not_comparable` for the measurement.
   */
  readonly currentScanComplete: boolean;
}): WitnessMemoryCheck {
  const { read, current, chain } = input;
  if (read === null) return noClaim("not_recorded", null);
  if (read.kind === "none") return noClaim("no_prior_verdict", null);
  if (read.kind === "unreadable") return noClaim("prior_unreadable", read.detail);

  const a = read.attested;
  const base = {
    attestedWitness: a.witnessSequence,
    attestedTail: a.tailSequence,
    attestedAt: a.verifiedAt,
  };

  // Both halves or neither, which is the rule the row is written under (ADR-0318: half an anchor is
  // worse than none) and which `storedReportMismatches` already refuses a row for. Read here as a
  // pair so a row carrying one half cannot reach the comparison on the strength of the other.
  if (a.chainEntryHash === null || a.chainSequenceNumber === null || a.payloadSha256 === null) {
    return { ...base, outcome: "prior_unanchored", detail: null };
  }
  if (chain === null) {
    return { ...base, outcome: "unverifiable_here", detail: "this pass holds no chain to compare" };
  }
  const entry = chain.find((e) => e.sequenceNumber === a.chainSequenceNumber);
  if (entry === undefined) {
    // Absent is conclusive only over a chain read from the beginning. A caller handing a *window* —
    // the suffix after an anchor — holds no opinion about an entry below it, and calling that a
    // destroyed entry would make every such pass on a healthy deployment report a compromise. So
    // the guard is on the window and **not** on the chain being empty, which an earlier draft of
    // this clause also excused and which the live A6 arm refuted: an empty chain read from genesis
    // is a *complete reading of a chain that holds nothing*, and against an anchored prior verdict
    // it is the strongest contradiction there is — because `record()` appends the chain entry and
    // only then stores the row, so **the verdict's own anchor proves an entry existed**. Excusing
    // it answered `verified` for a scope whose chain and anchors had both been destroyed, which is
    // precisely the state this module was built to stop reading as new.
    const lowest = chain[0]?.sequenceNumber;
    return lowest !== undefined && lowest > 0
      ? {
          ...base,
          outcome: "unverifiable_here",
          detail: `the verdict's chain entry is below this pass's window`,
        }
      : {
          ...base,
          outcome: "prior_verdict_contradicted",
          detail: `the chain holds no entry at the sequence a prior verdict was anchored in`,
        };
  }
  if (entry.payloadSha256 !== a.payloadSha256 || entry.entryHash !== a.chainEntryHash) {
    return {
      ...base,
      outcome: "prior_verdict_contradicted",
      detail: "the chain entry a prior verdict names commits to different content",
    };
  }

  // The witness comparison, over figures the chain now pins.
  //
  // Gated on this pass's scan having finished: a cut scan's witness is the highest among the
  // *oldest* rows it reached, so a comparison against it would read a coverage gap as a destroyed
  // anchor — and since a cause outranks `!anchorAudit.complete`, it would page. Only the **current**
  // side needs the gate: an attested witness that was itself a lower bound can only make this
  // comparison harder to trip, which is the safe direction.
  if (a.witnessSequence !== null) {
    if (!input.currentScanComplete) {
      return { ...base, outcome: "witness_not_comparable", detail: null };
    }
    if (current.checkpointSequence === null) {
      return {
        ...base,
        outcome: "witness_regressed",
        detail: "a prior verdict attested a witness and this scope's anchor table now has none",
      };
    }
    if (current.checkpointSequence < a.witnessSequence) {
      return {
        ...base,
        outcome: "witness_regressed",
        detail: "this scope's highest uncontradicted anchor is below one a prior verdict attested",
      };
    }
  }
  return { ...base, outcome: "consistent", detail: null };
}

/** Whether this axis **disproves** something — `compromised`, beside the other causes. */
export function witnessMemoryDisproves(check: WitnessMemoryCheck): boolean {
  return WITNESS_MEMORY_GRADE[check.outcome] === "disproves";
}

/** Whether this axis leaves something unestablished — `unproven`, never `verified`. */
export function witnessMemoryUnproven(check: WitnessMemoryCheck): boolean {
  return WITNESS_MEMORY_GRADE[check.outcome] === "unproven";
}

/**
 * Whether a scope that looks empty **had history**, which is the question `isEmptyScope` could not
 * ask.
 *
 * A scope whose chain and anchors are both destroyed answers `verified` on every axis and is then
 * discarded as nothing-to-verify — measured through the real scheduler as `skipped_empty` with zero
 * callbacks. A prior verdict attesting any history refutes "this scope is new", so the pass must
 * report it rather than skip it. It is a separate predicate from the two above because the
 * consequence is different: this one decides whether the report is *published at all*.
 */
export function witnessMemoryShowsHistory(check: WitnessMemoryCheck): boolean {
  return check.attestedTail !== null || check.attestedWitness !== null;
}

/**
 * Whether a prior verdict attested **anchors**, which is a narrower question than history and the
 * one a remedy turns on.
 *
 * A scope can have a chain, a stored verdict and no checkpoint ever written, and such a verdict
 * attests a `tailSequence` with a null `witnessSequence`. So `witnessMemoryShowsHistory` is true of
 * it and *this* is false, which is the distinction `formatIntegrityProof`'s truncation arm needs:
 * for a scope whose anchors were **destroyed**, running the checkpoint scheduler anchors past the
 * gap and makes the truncation permanently unprovable, while for a scope that has simply never been
 * anchored, running it is the remedy. The wider predicate sent both to the first sentence.
 *
 * **What reaches that state is the two schedulers covering different scopes, and not — as this
 * comment said until ADR-0407's review — a checkpoint pass that "found nothing to anchor".** That
 * mechanism is self-contradictory: `CheckpointScheduler` skips a scope on `tail === null` and on
 * nothing else, so a pass with nothing to anchor saw an **empty** chain, which means
 * `attestedTail === null` too and `witnessMemoryShowsHistory` is false — the arm is never reached.
 * The reachable configurations are a deployment running the proof with no checkpoint scheduler at
 * all, the two configs differing in `tenants`, `includePlatform` or `tenantStatuses` (each an
 * independent field on the two schemas), and — the one a later pass found this enumeration short
 * by, in the comment correcting an enumeration — a checkpoint pass whose outcome is **`error`** on
 * every tick: that writes no anchor and changes no verdict, while the integrity proof is a separate
 * scheduler and goes on storing `verified` baselines, so the scope accumulates an attested tail with
 * no attested witness. Of `CHECKPOINT_PASS_OUTCOMES`' four members three are non-anchoring, and
 * `refused_unverified` is the one of the three that cannot produce it, because a failed verification
 * makes the proof store `compromised` and `latestBaseline` admits only a `verified` row.
 *
 * Two residuals, both stated rather than closed, because **neither predicate is total over the
 * question an operator is asking** — *did this scope ever have anchors?* — which cannot be answered
 * from a baseline's own figures and needs the chain's memory of a prior witness (ADR-0375's open
 * end 2). (1) `attestedWitness` is null for **three** outcomes and not one: `not_recorded`,
 * `no_prior_verdict` and `prior_unreadable` all return through `noClaim`, so a scope whose newest
 * baseline was *tampered* — itself a finding, graded `unproven` — gets the destructive remedy
 * offered, and one edit suppresses both the witness figure and the predicate that reads it. Not a
 * regression: `witnessMemoryShowsHistory` is null for the same three, so the wide predicate did the
 * same. (2) The narrowing is **strict**, so it stops protecting one state the wide predicate
 * covered by accident: a scope whose anchors were destroyed and whose newest verified, anchored
 * baseline predates its first anchor now reads as never-anchored. Bounded, because every pass after
 * a destruction answers `compromised` and so is not a baseline, which normally leaves the last
 * pre-destruction pass — attesting a non-null witness — as the newest one.
 *
 * Kept as its own function rather than inlined, because the two questions have one shape and
 * opposite consequences: `witnessMemoryShowsHistory` decides whether a report is **published**
 * (ADR-0399's `isEmptyScope` gate, where any history refutes *this scope is new*, so the wide
 * reading is the right one there) and this one decides which **remedy** is printed.
 */
export function witnessMemoryShowsAnchors(check: WitnessMemoryCheck): boolean {
  return check.attestedWitness !== null;
}

const OUTCOME_PHRASES: Readonly<Record<WitnessMemoryOutcome, string>> = {
  not_recorded: "no verdict is recorded, so there is no prior reading to compare against",
  no_prior_verdict: "no prior verdict for this scope yet",
  prior_unreadable: "the newest stored verdict could not be read or disagrees with itself",
  prior_unanchored: "the newest stored verdict carries no chain anchor, so nothing pins its figures",
  unverifiable_here: "the newest stored verdict is outside this pass's window",
  witness_not_comparable:
    "this pass's anchor scan did not finish, so its witness is a lower bound and a drop cannot be read from it",
  prior_verdict_contradicted: "the chain contradicts a prior verdict's own anchor",
  consistent: "consistent with the newest stored verdict",
  witness_regressed: "ANCHORS LOST: a prior verdict attested more history than this table now holds",
};

/**
 * The memory as an operator reads it — a line when there is something to say, and **nothing** when
 * the axis is consistent.
 *
 * Silent on `consistent` because that is the healthy steady state on every pass of every scope, and
 * a line per scope per hour saying so is the noise an operator filters, taking the findings with it.
 * Every other outcome prints, including the three that carry no claim: *what was not examined* is
 * exactly the thing this stack keeps finding nobody said (ADR-0372).
 */
export function formatWitnessMemory(check: WitnessMemoryCheck): readonly string[] {
  if (check.outcome === "consistent") return [];
  const head = `witness memory: ${OUTCOME_PHRASES[check.outcome]}`;
  if (check.outcome === "witness_regressed") {
    // The detail is a **sentence**, so it gets its own line rather than being composed into one.
    // Composed it read *"attested witness 5 at …, and this pass found a prior verdict attested a
    // witness and this scope's anchor table now has none"* — ungrammatical and repeating its own
    // first clause, on a line an operator reads under a paging sev1. Found by printing it live
    // rather than by reading the template.
    return [
      `  ${head}`,
      `    a prior verdict at ${String(check.attestedAt)} attested witness` +
        ` ${String(check.attestedWitness)} and tail ${String(check.attestedTail)}`,
      `    ${check.detail ?? "this pass found less"}`,
      "    nothing in this workspace deletes or lowers a checkpoint, so this has no lawful cause",
    ];
  }
  return check.detail === null ? [`  ${head}`] : [`  ${head} (${check.detail})`];
}
