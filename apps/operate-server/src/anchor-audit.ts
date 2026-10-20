import type { ChainCheckpoint, ChainedLogEntry } from "@crossengin/forensics";
import type { PostgresChainCheckpointStore } from "@crossengin/forensics-pg";
import type { RowRead, UnreadableRow } from "@crossengin/kernel-pg";

/**
 * How a readable checkpoint disagrees with the chain it anchors.
 *
 * **Two kinds and deliberately not three.** A checkpoint whose sequence the chain does not reach,
 * and whose root hash matches no entry anywhere, is the *truncation* signal —
 * `ChainTruncationCheck`'s whole subject — so it is not a disagreement here and must stay a
 * witness. Folding it in would report one fact as two causes and would take the witness away from
 * the check that needs it, which is the opposite of what this audit is for.
 *
 * - `sequence_relocated` — the chain holds no entry at this anchor's sequence carrying this root
 *   hash, and holds one somewhere **else** that does. So the anchor's `sequence_number` was moved,
 *   and `matchedAt` says where the anchor really belongs. Measured live as the non-owner `serving`
 *   role: that column's only CHECK is `>= 0`, and this table's isolation arm is `ALL`-scope so its
 *   `USING` doubles as its `WITH CHECK` (ADR-0374) — so one `UPDATE` under a tenant's own context
 *   moves it. Raised above the chain tail it manufactures a **false** `chain_truncated`, which is a
 *   paging sev1 telling an operator that audit history was destroyed while every entry is present;
 *   lowered it hides a real truncation, and that one read `verified` with the formatter printing
 *   "integrity valid, signatures valid (3 checked)" over two destroyed entries.
 * - `root_hash_mismatch` — the chain holds an entry at this anchor's sequence and its hash is not
 *   the anchor's, and no entry anywhere carries the anchor's. Either the anchor or the entry was
 *   altered; which one is not decidable from here, and saying so is better than guessing.
 */
export const ANCHOR_DISAGREEMENT_KINDS = ["sequence_relocated", "root_hash_mismatch"] as const;
export type AnchorDisagreementKind = (typeof ANCHOR_DISAGREEMENT_KINDS)[number];

export interface AnchorDisagreement {
  readonly kind: AnchorDisagreementKind;
  readonly sequenceNumber: number;
  /** For `sequence_relocated`, the sequence whose entry carries this anchor's root hash. */
  readonly matchedAt: number | null;
}

/**
 * What one scope's anchor table says about itself, read as a **set** rather than as its newest row.
 *
 * ADR-0374 routed a refused checkpoint row into the integrity verdict as `compromised`, and the
 * detector it used is `PostgresChainCheckpointStore.latest(scope)` — one row. So the finding existed
 * only while the refused row was the *newest*, and on a scope holding N checkpoints the other N−1
 * could be blanked with no verdict change at all. Measured live, one scope with anchors at 1, 3 and
 * 4: blanking `checkpointed_by` at sequence 1 answered `verdict=verified anchorRefused=0`, and the
 * identical statement at sequence 4 answered `verdict=compromised anchorRefused=1`. The scheduler's
 * refusal-to-anchor protected exactly the one row a tamperer need not choose, and paid for it with a
 * permanent fold from genesis and a permanently unanswerable truncation check.
 */
export interface AnchorAuditReport {
  readonly scope: string | null;
  readonly scanned: number;
  /**
   * Whether the scan reached the end of this scope's checkpoints. `false` makes every count below a
   * **lower bound**, which is why `integrityVerdictFor` refuses to answer `verified` on it:
   * `refusedCount: 0` from a scan that stopped early is not the claim that there are none
   * (ADR-0372's vacuous axis, and ADR-0331's claim-versus-nobody-looked).
   */
  readonly complete: boolean;
  /** Capped at `MAX_REPORTED_ANCHOR_REFUSALS`; `refusedCount` is the whole figure. */
  readonly refused: readonly UnreadableRow[];
  readonly refusedCount: number;
  /**
   * `null` means the correspondence was **not asked** — never "none found". Asked only when a whole
   * chain was supplied *and* its reader refused none of its rows, because the two lookup maps are
   * built from the entries that parsed: over a chain with a refused row, an anchor pointing at that
   * row would be named `root_hash_mismatch`, which is a finding attributed to the wrong table. A
   * refused chain row already answers `compromised` on its own axis, so nothing is lost but a
   * sentence that would have been false.
   *
   * Capped at `MAX_REPORTED_ANCHOR_DISAGREEMENTS`; `disagreeingCount` is the whole figure.
   */
  readonly disagreeing: readonly AnchorDisagreement[] | null;
  /**
   * How many anchors disagree, `null` exactly when `disagreeing` is — so the two are one fact and a
   * reader cannot mistake the cap for the count.
   *
   * It exists because the sibling axis had a cap and this one did not, and the cap's own reason
   * applies here **with a benign trigger rather than a tamperer**: a restore from backup, or any
   * change to `canonicalEntryBytes`, makes *every* anchor disagree at once. Uncapped, an hourly
   * unattended `console.error` then carries one line per anchor up to `CHECKPOINT_SCAN_CEILING`.
   */
  readonly disagreeingCount: number | null;
  /**
   * The highest readable checkpoint sequence this audit will stand behind as a truncation witness.
   *
   * An anchor the chain **contradicts at its own sequence** is excluded, because its sequence is
   * then not a fact: a relocated anchor is where somebody put it, and a mismatched one is of
   * unestablished content. An anchor the chain simply does not **reach** is kept, because that is
   * exactly what truncation looks like from here and excluding it would disarm the check this
   * figure exists to feed.
   *
   * It supersedes `latest()` as the truncation witness, which is a strict improvement and not only
   * a wider read: `latest()` answers the highest sequence, so a single refused newest row left the
   * check with `null` while an older readable anchor sat directly beneath it, and a refused anchor
   * therefore disabled truncation detection for the scope (ADR-0374's open end 7).
   *
   * **Where `disagreeing` is `null` this is an *unchecked* witness** — no chain was in hand, so no
   * anchor was *not contradicted* and every readable one counts. That is exactly `latest()`'s old
   * level of trust, which is the right answer for a caller that cannot do better and the wrong one
   * to mistake for the checked figure, so a consumer whose claim depends on the difference reads
   * `disagreeing` beside it. Nothing does today: the scheduler passes no chain and ignores the
   * witness, and `proveScopeIntegrity` — the only consumer of `truncated` — always holds the whole
   * chain. Deliberately *not* two fields, because both answers feed one question and a consumer
   * that wants the stronger one has the discriminator on the same report.
   */
  readonly witnessSequence: number | null;
}

/**
 * How many refused rows a report carries by name.
 *
 * A cap and not the whole list, because the scan's own bound is the ceiling and a tamperer editing
 * every row would otherwise put that many `UnreadableRow`s on a report that is logged, formatted
 * and passed to an escalation payload. `refusedCount` is the figure; these are the handles an
 * operator starts from, which is what `UnreadableRow.identity` is for.
 */
export const MAX_REPORTED_ANCHOR_REFUSALS = 50;

/**
 * The same cap on the disagreement axis, and the same figure for the same reason — one number
 * rather than two, because the two lists are read by one operator in one report and a difference
 * between them would be a distinction nobody asked for.
 */
export const MAX_REPORTED_ANCHOR_DISAGREEMENTS = 50;

/** The two lookups the correspondence rule needs, built once per audit. */
interface ChainIndex {
  readonly hashAt: Map<number, string>;
  readonly sequenceOfHash: Map<string, number>;
}

function indexChain(entries: readonly ChainedLogEntry[]): ChainIndex {
  const hashAt = new Map<number, string>();
  const sequenceOfHash = new Map<string, number>();
  for (const e of entries) {
    hashAt.set(e.sequenceNumber, e.entryHash);
    // Collides only if two entries share an `entryHash`, which `hashChainStep` makes practically
    // impossible because the hash covers the sequence and the prior hash. A collision would
    // mis-name `matchedAt` and could never change a verdict, since every arm it decides between is
    // a disagreement.
    sequenceOfHash.set(e.entryHash, e.sequenceNumber);
  }
  return { hashAt, sequenceOfHash };
}

/**
 * What the chain says about one readable anchor. `null` means it agrees, or that the chain does not
 * reach it — both of which leave it a witness; see `ANCHOR_DISAGREEMENT_KINDS` for why the second
 * is not a disagreement.
 *
 * The clauses are in this order because each is a more specific statement than the next: an anchor
 * whose root hash names a real entry elsewhere has a *location*, which is strictly more than
 * "these two hashes differ", and naming the weaker fact would send an operator to compare hashes
 * when the row simply needs its sequence put back.
 *
 * The final fall-through is this rule's measured limit and not only its truncation arm: it is also
 * what a **two-column** `UPDATE` produces. Setting `sequence_number` and `root_hash` in one
 * statement — lowering an anchor onto a surviving entry and taking that entry's hash with it — hides
 * a real truncation behind a report byte-identical to a healthy scope's, and raising one past the
 * tail with a hash the chain does not hold restores the false `chain_truncated` the one-column form
 * no longer produces. Both measured live as a non-owner (ADR-0375). It cannot be narrowed from here:
 * an anchor the chain does not reach *is* the truncation signature, so this table alone cannot
 * separate the two, and closing it needs evidence held elsewhere — the chain's own memory of a prior
 * witness, or an anchor table that is itself chained.
 */
function disagreementFor(
  checkpoint: ChainCheckpoint,
  index: ChainIndex,
): AnchorDisagreement | null {
  const seq = checkpoint.sequenceNumber;
  if (index.hashAt.get(seq) === checkpoint.rootHash) return null;
  const matchedAt = index.sequenceOfHash.get(checkpoint.rootHash);
  if (matchedAt !== undefined) {
    return { kind: "sequence_relocated", sequenceNumber: seq, matchedAt };
  }
  if (index.hashAt.has(seq)) {
    return { kind: "root_hash_mismatch", sequenceNumber: seq, matchedAt: null };
  }
  return null;
}

/**
 * Reads one scope's whole anchor table and, where a chain is supplied, asks whether every readable
 * anchor agrees with it.
 *
 * The scan streams: `scanCheckpoints` hands over a page at a time and this holds nothing beyond the
 * refusals it reports and the two maps, which is the whole reason the store takes a callback rather
 * than returning rows (ADR-0367's `drainList` rule — the caller decides what it keeps).
 *
 * `chain` is `null` for a caller that holds none, and the two callers that pass `null` do so for
 * different reasons: `CheckpointScheduler`'s verifier loads the chain internally and does not hand
 * it back, and `verify-chain --from-checkpoint` deliberately does not read the prefix. Both get the
 * refusal half, which needs no chain, and `disagreeing: null` says the other half was not asked.
 */
export async function auditAnchors(
  scope: string | null,
  checkpoints: PostgresChainCheckpointStore,
  chain: readonly ChainedLogEntry[] | null,
  opts: { readonly ceiling?: number; readonly pageSize?: number } = {},
): Promise<AnchorAuditReport> {
  const index = chain === null ? null : indexChain(chain);
  const refused: UnreadableRow[] = [];
  // Accumulated unconditionally and **published conditionally**, so the one invariant that matters
  // here — a non-null `disagreeing` exactly when a chain was supplied — is established by the
  // return rather than maintained by two places agreeing. Written the other way (a nullable array
  // and a `?.push`) the guard reads as a check and is one that cannot fire, which is coverage it
  // does not provide; and if it ever could, it would silently drop a finding.
  const disagreements: AnchorDisagreement[] = [];
  let disagreementCount = 0;
  let witnessSequence: number | null = null;

  const onPage = (page: RowRead<ChainCheckpoint>): void => {
    for (const row of page.unreadable) {
      if (refused.length < MAX_REPORTED_ANCHOR_REFUSALS) refused.push(row);
    }
    for (const checkpoint of page.records) {
      if (index !== null) {
        const disagreement = disagreementFor(checkpoint, index);
        if (disagreement !== null) {
          disagreementCount += 1;
          if (disagreements.length < MAX_REPORTED_ANCHOR_DISAGREEMENTS) {
            disagreements.push(disagreement);
          }
          continue;
        }
      }
      // A running maximum rather than the last readable row of the last page, which the scan's
      // ascending `ORDER BY` would otherwise make the same answer: excluding a contradicted anchor
      // means the highest witness is not always the last row read.
      if (witnessSequence === null || checkpoint.sequenceNumber > witnessSequence) {
        witnessSequence = checkpoint.sequenceNumber;
      }
    }
  };

  const outcome = await checkpoints.scanCheckpoints(scope, onPage, opts);
  return {
    scope,
    scanned: outcome.scanned,
    complete: outcome.complete,
    refused,
    refusedCount: outcome.refusedCount,
    disagreeing: index === null ? null : disagreements,
    disagreeingCount: index === null ? null : disagreementCount,
    witnessSequence,
  };
}

/**
 * Something in this scope's anchor table is **disproven**: a row the contract refuses, or an anchor
 * the chain contradicts at its own sequence.
 *
 * Separate from `anchorAuditHasFindings` because the two have different consequences, which is the
 * distinction ADR-0372 is about: this one is `compromised` and coverage this audit did not reach is
 * `unproven`, and an absence of evidence is not evidence.
 */
export function anchorAuditDisproves(report: AnchorAuditReport): boolean {
  // Both axes read their **count** and not their list, because both lists are capped: past the cap
  // a list-length read would be a verdict computed from the reporting bound rather than from the
  // table. It cannot currently differ — a non-empty count has a non-empty list under either cap —
  // and that is exactly why it has to be written the right way round now rather than when a cap of
  // zero, or a per-axis cap, makes the two disagree.
  return (
    report.refusedCount > 0 || (report.disagreeingCount !== null && report.disagreeingCount > 0)
  );
}

/** Anything an operator has to act on, including a scan the ceiling stopped. */
export function anchorAuditHasFindings(report: AnchorAuditReport): boolean {
  return anchorAuditDisproves(report) || !report.complete;
}

/**
 * The report for a human.
 *
 * `detail` is `unreadableDetail`'s output — a field path and an issue code — and **no stored column
 * value** ever reaches these lines, which is ADR-0373's rule rather than this function's taste: a
 * `ZodError`'s own `message` is the JSON of its issues and an `invalid_enum_value` carries
 * `received`, so printing it would put the stored value into a log line, an HTTP body and an
 * incident note.
 *
 * The `disagreeing === null` case gets a line of its own, because silence there reads as *asked and
 * clean* — which is the conflation this whole module keeps apart in its data and would then give
 * away in its output.
 */
export function formatAnchorAudit(report: AnchorAuditReport): readonly string[] {
  const lines: string[] = [];
  const coverage = report.complete ? "complete" : "INCOMPLETE (the ceiling stopped the scan)";
  // The witness says whether it was **checked**, because the number alone is two different claims:
  // against a chain it is the highest anchor nothing contradicted, and with no chain in hand it is
  // the highest readable one, which is `latest()`'s old level of trust.
  const witness =
    report.witnessSequence === null
      ? "none"
      : `${report.witnessSequence.toString()}${report.disagreeing === null ? " (unchecked)" : ""}`;
  // Labelled `checkpoints:` and **not** `anchors:`, which is what the live run of ADR-0375 found the
  // moment `formatIntegrityProof` indented these lines into its report: that report already carries
  // an `anchors: checked N, verified N, unanchored N…` line, which is about `meta.audit_log` rows
  // anchored **in** the chain, and two lines reading `anchors:` about two different tables is a
  // report an operator has to disambiguate before they can act on it.
  lines.push(
    `checkpoints: ${report.scanned.toString()} row(s) scanned, ${coverage}, witness ${witness}`,
  );
  if (report.refusedCount > 0) {
    lines.push(`  REFUSED: ${report.refusedCount.toString()} checkpoint row(s) the contract refuses`);
    for (const u of report.refused) {
      lines.push(`    checkpoint ${u.identity ?? "<unidentified>"} (${u.detail})`);
    }
    if (report.refusedCount > report.refused.length) {
      lines.push(`    … and ${(report.refusedCount - report.refused.length).toString()} more`);
    }
  }
  if (report.disagreeing === null) {
    lines.push("  correspondence: not asked (no fully-readable chain in hand)");
    return lines;
  }
  const disagreeingCount = report.disagreeingCount ?? 0;
  if (disagreeingCount === 0) return lines;
  lines.push(`  DISAGREES WITH THE CHAIN: ${disagreeingCount.toString()} anchor(s)`);
  for (const d of report.disagreeing) {
    const where = d.matchedAt === null ? "" : `, whose root hash is the entry at ${d.matchedAt.toString()}`;
    lines.push(`    anchor at ${d.sequenceNumber.toString()}: ${d.kind}${where}`);
  }
  if (disagreeingCount > report.disagreeing.length) {
    lines.push(`    … and ${(disagreeingCount - report.disagreeing.length).toString()} more`);
  }
  return lines;
}

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
 * checkpoint scheduler alongside the integrity proof is not optional.
 *
 * It lives **here** rather than with `IntegrityProofReport`, which declared it: this is a statement
 * about the anchor table versus the chain's tail, and the witness it compares is this module's
 * answer. `integrity-proof.ts` re-exports the type, so no consumer moved (ADR-0371's reason for
 * moving `ChainTail` to the module that owns what a checkpoint is made of).
 */
export interface ChainTruncationCheck {
  readonly checkpointSequence: number | null;
  readonly tailSequence: number | null;
  readonly truncated: boolean;
}

/**
 * The truncation verdict over a witness and a tail — **one** definition, two callers.
 *
 * It was computed inline in `proveScopeIntegrity` and nowhere else, so `verify-chain` — the command
 * an operator runs by hand to ask whether a scope's trail is intact — did not compute it at all. It
 * holds the witness (it prints it) and never read the tail, so a scope with a checkpoint at
 * sequence 7 and **zero** chain entries reported `OK`, `integrity: valid`,
 * `signatures: valid (0 checked)`, `witness 7` and exit 0. ADR-0375 says that state is one only the
 * tamper produces: nothing in the workspace deletes a chain entry, and the Article 17 erasure
 * *retains* that table. Every fact was on the page and the verdict contradicted them.
 *
 * Extracted rather than spelled a second time in the command, which is this repo's recurring
 * finding (ADR-0362: four spellings of one confinement rule, and the accurate comment describing the
 * defective one).
 *
 * `tailSequence === null` is a chain with no entries at all, and with a witness in hand that is the
 * **strongest** form of the finding rather than a special case: an anchor commits to a sequence the
 * chain no longer reaches by any amount.
 */
export function chainTruncation(
  witnessSequence: number | null,
  tailSequence: number | null,
): ChainTruncationCheck {
  return {
    checkpointSequence: witnessSequence,
    tailSequence,
    truncated:
      witnessSequence !== null && (tailSequence === null || tailSequence < witnessSequence),
  };
}

/**
 * The truncation check as an operator reads it — a line when there is something to say, and nothing
 * when the question could not be asked.
 *
 * Three states and each needs its own sentence, because the quiet one is the dangerous conflation:
 * a **proven** truncation names both figures, a witness the chain reaches is one clean axis and
 * says so, and *no witness* is a question nobody could answer — printing "not truncated" for that
 * would be the claim this whole family refuses (ADR-0372: an absence of evidence is not evidence).
 */
export function formatChainTruncation(check: ChainTruncationCheck): readonly string[] {
  if (check.checkpointSequence === null) {
    return [
      "truncation: not checkable (no checkpoint yet — run the checkpoint scheduler)",
    ];
  }
  if (!check.truncated) {
    return [
      `truncation: none — the chain reaches the witness at ${check.checkpointSequence.toString()}`,
    ];
  }
  const tail =
    check.tailSequence === null
      ? "the chain holds NO ENTRIES AT ALL"
      : `the chain ends at ${check.tailSequence.toString()}`;
  return [
    `TRUNCATED: a checkpoint witnesses sequence ${check.checkpointSequence.toString()} and ${tail}`,
    "  entries the chain was committed to are gone; a hash fold cannot see this, which is what the",
    "  checkpoint exists for",
  ];
}

/**
 * Whether a verification examined anything at all.
 *
 * `verifyChainIntegrity([])` and `verifyChainSignatures([])` are **both vacuously valid**, so a
 * scope holding no entries folds to `ok: true` and the headline read `OK`. That is two facts wearing
 * one word: a scope where nothing has yet been audited, and one whose entries were destroyed along
 * with its checkpoints. Where a witness survives, `chainTruncation` separates them conclusively;
 * where it does not, **nothing in this table can** — closing that needs the chain's own memory of a
 * prior witness, which makes one pass's verdict an input to the next (ADR-0375's open end).
 *
 * So the state is *named* rather than resolved: the command reports it, and exits 0, because a
 * genuinely new scope has nothing wrong with it and the repo's exit vocabulary has no third value
 * (2 is a usage error). What it no longer does is print the word an operator reads as "verified".
 */
export function verificationExaminedNothing(
  signaturesChecked: number,
  check: ChainTruncationCheck,
): boolean {
  return signaturesChecked === 0 && !check.truncated;
}
