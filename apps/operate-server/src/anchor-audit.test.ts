import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import {
  ChainCheckpointSchema,
  ChainedLogEntrySchema,
  GENESIS_HASH,
  type ChainCheckpoint,
  type ChainedLogEntry,
} from "@crossengin/forensics";
import {
  PostgresChainCheckpointStore,
  type CheckpointScanOptions,
  type CheckpointScanOutcome,
} from "@crossengin/forensics-pg";
import { unreadableDetail, type PgConnection, type RowRead, type UnreadableRow } from "@crossengin/kernel-pg";

import {
  ANCHOR_DISAGREEMENT_KINDS,
  MAX_REPORTED_ANCHOR_REFUSALS,
  anchorAuditDisproves,
  anchorAuditHasFindings,
  auditAnchors,
  formatAnchorAudit,
  type AnchorAuditReport,
} from "./anchor-audit.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const AT = "2026-06-01T00:00:00.000Z";

/** A hash no entry in any fixture carries — the shape of ADR-0375's measured `root_hash := 'f'*64`. */
const FOREIGN_HASH = "f".repeat(64);

/**
 * A distinct, contract-valid sha256 hex per sequence. The correspondence reads `(sequenceNumber,
 * entryHash)` and nothing else, so one hash per sequence is the whole of what a fixture has to say —
 * and the four-hex prefix keeps which entry a hash belongs to legible in a failure message.
 */
function hashOf(sequenceNumber: number): string {
  return `${sequenceNumber.toString(16).padStart(4, "0")}${"ab".repeat(30)}`;
}

/**
 * One chain entry, parsed through its own contract so no fixture here is a shape the entry schema
 * would refuse.
 *
 * Parsed individually rather than through `ChainedLogSchema`, which enforces contiguity and linkage:
 * several fixtures below are deliberately a chain with its tail cut off, which is exactly what a
 * truncation leaves behind and what the witness rule exists to answer about.
 */
function entry(sequenceNumber: number, entryHash: string = hashOf(sequenceNumber)): ChainedLogEntry {
  return ChainedLogEntrySchema.parse({
    sequenceNumber,
    kind: "audit_event",
    recordedAt: AT,
    actorReference: "gateway",
    payloadSha256: "c".repeat(64),
    payloadSizeBytes: 12,
    priorEntryHash: sequenceNumber === 0 ? GENESIS_HASH : hashOf(sequenceNumber - 1),
    entryHash,
    signingKeyFingerprint: "d".repeat(64),
    signature: "signature",
  });
}

/** Entries `0..last` inclusive, each linked to the one before it. */
function chainTo(last: number): readonly ChainedLogEntry[] {
  return Array.from({ length: last + 1 }, (_, n) => entry(n));
}

/**
 * One checkpoint, parsed through its own contract. The default `rootHash` is the hash of the entry
 * at the same sequence, so a bare `checkpoint(n)` is an anchor that agrees with `chainTo(m >= n)`
 * and every disagreement in this file is a hash passed in deliberately.
 */
function checkpoint(
  sequenceNumber: number,
  rootHash: string = hashOf(sequenceNumber),
): ChainCheckpoint {
  return ChainCheckpointSchema.parse({
    sequenceNumber,
    rootHash,
    checkpointedAt: AT,
    checkpointedBy: "checkpoint-scheduler",
    provenance: "verified_full",
  });
}

function page(
  records: readonly ChainCheckpoint[],
  unreadable: readonly UnreadableRow[] = [],
): RowRead<ChainCheckpoint> {
  return { records, unreadable };
}

function refusedRow(n: number): UnreadableRow {
  return { identity: `refused-${n.toString()}`, detail: "provenance: invalid_enum_value" };
}

/** A `ZodError` for a value its schema refuses, so a fixture cannot stand in for a readable row. */
function parseFailure(schema: z.ZodTypeAny, value: unknown): ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("fixture parses, so it cannot stand in for a refused row");
  return result.error;
}

interface ScanScript {
  readonly pages: readonly RowRead<ChainCheckpoint>[];
  /**
   * What the store answers, overriding whatever the pages imply. Only the store can know
   * `complete` — no page carries it — and only the store holds the refusal total once the report's
   * list is capped, so the two figures have to be able to disagree for a test to say which source
   * the report quotes.
   */
  readonly outcome?: Partial<CheckpointScanOutcome>;
}

/**
 * A connection that serves nothing, which is the assertion rather than a shortcut.
 *
 * `auditAnchors` reads the store through `scanCheckpoints` alone, so a statement reaching the wire
 * here is the module having grown a second read — and a fake answering `{rows: []}` would hide
 * exactly that (ADR-0350's rule). There is no `assertBindArity` call for the same reason: this fake
 * does not interpret a statement, it refuses every one.
 */
function servesNothing(): PgConnection {
  const refuse = (): never => {
    throw new Error("auditAnchors issued a statement; it must read only through scanCheckpoints");
  };
  return { query: refuse, transaction: refuse, withAdvisoryLock: refuse, close: refuse };
}

/**
 * A checkpoint store whose scan is scripted, so the fold can be driven page by page.
 *
 * A subclass rather than a stand-in object, which is `RecordCountingCheckpointStore`'s reason one
 * module across: `auditAnchors` takes the concrete class, so the type stays honest with no cast and
 * every other method on the path is the real one — over a connection that refuses to serve, which
 * is what proves the override is the whole of what this module reads.
 */
class ScriptedCheckpointStore extends PostgresChainCheckpointStore {
  readonly calls: Array<{ readonly scope: string | null; readonly opts: CheckpointScanOptions }> =
    [];
  readonly outcomes: CheckpointScanOutcome[] = [];

  constructor(private readonly script: ScanScript) {
    super(servesNothing(), {});
  }

  override async scanCheckpoints(
    tenantId: string | null,
    onPage: (page: RowRead<ChainCheckpoint>) => void,
    opts: CheckpointScanOptions = {},
  ): Promise<CheckpointScanOutcome> {
    this.calls.push({ scope: tenantId, opts });
    let scanned = 0;
    let refusedCount = 0;
    for (const p of this.script.pages) {
      scanned += p.records.length + p.unreadable.length;
      refusedCount += p.unreadable.length;
      onPage(p);
    }
    const outcome: CheckpointScanOutcome = {
      scanned,
      refusedCount,
      complete: true,
      ...this.script.outcome,
    };
    this.outcomes.push(outcome);
    return outcome;
  }
}

async function auditScripted(
  scope: string | null,
  chain: readonly ChainedLogEntry[] | null,
  script: ScanScript,
): Promise<AnchorAuditReport> {
  return auditAnchors(scope, new ScriptedCheckpointStore(script), chain);
}

async function audit(
  scope: string | null,
  chain: readonly ChainedLogEntry[] | null,
  pages: readonly RowRead<ChainCheckpoint>[],
): Promise<AnchorAuditReport> {
  return auditScripted(scope, chain, { pages });
}

/** A report literal for the predicates and the formatter, which are pure over one. */
function reportOf(over: Partial<AnchorAuditReport> = {}): AnchorAuditReport {
  return {
    scope: TENANT_A,
    scanned: 0,
    complete: true,
    refused: [],
    refusedCount: 0,
    disagreeing: [],
    witnessSequence: null,
    ...over,
  };
}

describe("ANCHOR_DISAGREEMENT_KINDS", () => {
  it("names the two kinds and deliberately not a third for an anchor the chain does not reach", () => {
    // A third member here would be the truncation signal reported as a disagreement, which both
    // double-counts one fact and takes the witness away from `ChainTruncationCheck`. Asserted as the
    // exact pair rather than member by member, so a third added later fails here by name.
    expect(ANCHOR_DISAGREEMENT_KINDS).toEqual(["sequence_relocated", "root_hash_mismatch"]);
  });
});

describe("the correspondence rule", () => {
  it("calls an anchor whose root hash is the chain's entry at its own sequence a witness and no disagreement", async () => {
    const report = await audit(TENANT_A, chainTo(2), [page([checkpoint(1)])]);
    expect(report.disagreeing).toEqual([]);
    expect(report.witnessSequence).toBe(1);
  });

  it("calls an anchor raised above the chain's tail `sequence_relocated` and names where it belongs", async () => {
    // ADR-0375's measured `raised 4 -> 99`, which pre-fix answered
    // `verdict=compromised truncated=true witness=99 causes=[chain_truncated]` — a paging sev1
    // saying audit history was destroyed while every entry was present, naming the wrong table.
    // The anchor is excluded from the witness, which is what makes that `truncated` false.
    const report = await audit(TENANT_A, chainTo(4), [page([checkpoint(99, hashOf(4))])]);
    expect(report.disagreeing).toEqual([
      { kind: "sequence_relocated", sequenceNumber: 99, matchedAt: 4 },
    ]);
    expect(report.witnessSequence).toBeNull();
  });

  it("calls an anchor lowered beneath the chain's tail `sequence_relocated` too", async () => {
    // ADR-0375's measured `lowered 4 -> 2`, on the scope whose anchors are 1, 3 and 4. Pre-fix it
    // read `verdict=verified truncated=false witness=3 causes=[]`, and the witness is **3 either
    // way** — so what the fix recovers here is the cause and not the witness.
    const report = await audit(TENANT_A, chainTo(4), [
      page([checkpoint(1), checkpoint(2, hashOf(4)), checkpoint(3)]),
    ]);
    expect(report.disagreeing).toEqual([
      { kind: "sequence_relocated", sequenceNumber: 2, matchedAt: 4 },
    ]);
    expect(report.witnessSequence).toBe(3);
  });

  it("calls an anchor at a sequence the chain holds, whose root hash names no entry, `root_hash_mismatch`", async () => {
    // ADR-0375's face 2c: `root_hash := 'f'*64` on the tail anchor read `verified` on both modes,
    // because nothing compared a checkpoint's root hash to the chain at all.
    const report = await audit(TENANT_A, chainTo(4), [page([checkpoint(4, FOREIGN_HASH)])]);
    expect(report.disagreeing).toEqual([
      { kind: "root_hash_mismatch", sequenceNumber: 4, matchedAt: null },
    ]);
    expect(report.witnessSequence).toBeNull();
  });

  it("treats an anchor the chain does not reach as no disagreement at all, and keeps it a witness", async () => {
    // Neither clause can fire: no entry at 7 and no entry carrying its hash. That is the truncation
    // signal, which `ChainTruncationCheck` names — so reporting it here would be one fact as two
    // causes, and excluding it from the witness would disarm the check that needs it.
    const report = await audit(TENANT_A, chainTo(2), [page([checkpoint(7)])]);
    expect(report.disagreeing).toEqual([]);
    expect(report.witnessSequence).toBe(7);
  });

  it("prefers `sequence_relocated` for an anchor that satisfies both clauses at once", async () => {
    // The order fixture: the chain holds an entry at 1 **and** holds the anchor's root hash at 2, so
    // either clause could fire. The relocation is the more specific statement — it names where the
    // row belongs — where "these two hashes differ" sends an operator to compare hashes for a row
    // that just needs its sequence put back.
    //
    // This fixture is needed on top of the two live cases above because neither pins the order on
    // its own: `raised 4 -> 99` holds no entry at 99, so the mismatch clause's predicate is false
    // there whichever order the clauses are in.
    const relocated = await audit(TENANT_A, chainTo(2), [page([checkpoint(1, hashOf(2))])]);
    expect(relocated.disagreeing).toEqual([
      { kind: "sequence_relocated", sequenceNumber: 1, matchedAt: 2 },
    ]);

    // The premise, so the assertion above is the order and not an accident: the same sequence with a
    // hash no entry carries does reach the mismatch clause, which is only possible because the chain
    // holds an entry at 1.
    const mismatched = await audit(TENANT_A, chainTo(2), [page([checkpoint(1, FOREIGN_HASH)])]);
    expect(mismatched.disagreeing).toEqual([
      { kind: "root_hash_mismatch", sequenceNumber: 1, matchedAt: null },
    ]);
  });

  it("answers per anchor, so one page can carry both kinds and an agreement", async () => {
    const report = await audit(TENANT_A, chainTo(4), [
      page([checkpoint(1), checkpoint(2, hashOf(4)), checkpoint(3, FOREIGN_HASH)]),
    ]);
    expect(report.disagreeing).toEqual([
      { kind: "sequence_relocated", sequenceNumber: 2, matchedAt: 4 },
      { kind: "root_hash_mismatch", sequenceNumber: 3, matchedAt: null },
    ]);
    expect(report.witnessSequence).toBe(1);
  });

  it("treats every anchor on a scope whose chain is empty as unreached, and still asks", async () => {
    // `chain: []` is a different fact from `chain: null` and both are reachable: the scheduler holds
    // no chain, while the proof over a scope with no entries holds an empty one. Asked, so
    // `disagreeing` is `[]`; and no clause can fire against empty maps, so every anchor is the
    // maximal truncation signal rather than a disagreement.
    const report = await audit(TENANT_A, [], [page([checkpoint(1), checkpoint(4)])]);
    expect(report.disagreeing).toEqual([]);
    expect(report.witnessSequence).toBe(4);
  });

  it("still reports a disagreement when two entries share an entry hash, whatever `matchedAt` names", async () => {
    // `sequenceOfHash` collides only on a shared `entryHash`, which `hashChainStep` makes
    // practically impossible because the hash covers the sequence. The module's claim is that a
    // collision mis-names `matchedAt` and can never change the verdict — so what is pinned is the
    // verdict: the anchor is reported, and it is excluded from the witness, whichever of the two
    // sequences the map ended up holding.
    const shared = hashOf(2);
    const chain = [entry(0), entry(1), entry(2, shared), entry(3, shared)];
    const report = await audit(TENANT_A, chain, [page([checkpoint(1, shared)])]);
    expect(report.disagreeing).toHaveLength(1);
    expect(report.disagreeing?.[0]?.kind).toBe("sequence_relocated");
    expect([2, 3]).toContain(report.disagreeing?.[0]?.matchedAt);
    expect(report.witnessSequence).toBeNull();
  });

  it("does not let a refused row in a page cost the other rows in it their correspondence", async () => {
    // ADR-0373's rule inside this fold: the refusal and the correspondence are two axes over one
    // page, and a row the contract refuses carries no root hash to compare — so it is counted and
    // the readable rows beside it are still answered for.
    const report = await audit(TENANT_A, chainTo(4), [
      page([checkpoint(1), checkpoint(3, FOREIGN_HASH)], [refusedRow(0)]),
    ]);
    expect(report.refusedCount).toBe(1);
    expect(report.disagreeing).toEqual([
      { kind: "root_hash_mismatch", sequenceNumber: 3, matchedAt: null },
    ]);
    expect(report.witnessSequence).toBe(1);
  });
});

describe("witnessSequence", () => {
  it("excludes a relocated anchor, because its sequence is then not a fact", async () => {
    const report = await audit(TENANT_A, chainTo(4), [
      page([checkpoint(1), checkpoint(3, hashOf(4))]),
    ]);
    expect(report.witnessSequence).toBe(1);
  });

  it("excludes a mismatched anchor even when it is the last readable row the scan read", async () => {
    // ADR-0375's face 2b in miniature — `cut+lowered`, which read
    // `verdict=verified truncated=false witness=2 sigsChecked=3 causes=[]` over two destroyed
    // entries. The highest witness is therefore not the last row read, which is the whole reason
    // this figure is not `latest()` and not the tail of the scan.
    const report = await audit(TENANT_A, chainTo(4), [
      page([checkpoint(2), checkpoint(4, FOREIGN_HASH)]),
    ]);
    expect(report.witnessSequence).toBe(2);
  });

  it("keeps an anchor the chain does not reach, because that is what truncation looks like", async () => {
    const report = await audit(TENANT_A, chainTo(2), [page([checkpoint(1), checkpoint(7)])]);
    expect(report.witnessSequence).toBe(7);
  });

  it("carries a witness from an earlier page past a later page that contradicts its only row", async () => {
    // The fold is per audit and not per page, which is what lets the store stream: nothing but the
    // two maps, the capped refusals and this figure survives a page.
    const report = await audit(TENANT_A, chainTo(4), [
      page([checkpoint(2)]),
      page([checkpoint(4, FOREIGN_HASH)]),
    ]);
    expect(report.witnessSequence).toBe(2);
    expect(report.disagreeing).toHaveLength(1);
  });

  it("is null for a scope holding no checkpoints at all", async () => {
    // Both shapes a scope with nothing in it can take, because the store's own loop calls `onPage`
    // with an empty pair before it sees the page is short — so the fold must answer the same either
    // way and a test pinning one of them would be pinning the store's loop order.
    for (const pages of [[], [page([])]]) {
      const report = await audit(TENANT_A, chainTo(2), pages);
      expect(report.witnessSequence).toBeNull();
      expect(report.scanned).toBe(0);
      expect(report.disagreeing).toEqual([]);
    }
  });

  it("is null for a scope whose every row the contract refuses", async () => {
    // The correspondence was asked and found nothing — there was no readable anchor to ask about —
    // so `disagreeing` is `[]` and the refusal axis carries the whole finding. Two axes, and only
    // one of them has anything to say here.
    const report = await audit(TENANT_A, chainTo(2), [
      page([], [refusedRow(0), refusedRow(1), refusedRow(2)]),
    ]);
    expect(report.witnessSequence).toBeNull();
    expect(report.refusedCount).toBe(3);
    expect(report.disagreeing).toEqual([]);
    expect(anchorAuditDisproves(report)).toBe(true);
  });

  it("is the highest witness and not the last one the fold was handed", async () => {
    // `scanCheckpoints` orders by `(sequence_number, id) ASC`, so this page cannot arrive from it:
    // under that order the last witness **is** the highest one, and the exclusion above is the only
    // way the two differ. So this is a fence on the fold rather than a property of today's store —
    // it is what stops an `ORDER BY` changed one package across from silently turning the witness
    // into "the last row read".
    const report = await audit(TENANT_A, chainTo(5), [page([checkpoint(5), checkpoint(2)])]);
    expect(report.witnessSequence).toBe(5);
  });

  it("is the lowest of several readable anchors when the chain contradicts all the higher ones", async () => {
    // The witness is a **subset's** maximum — every readable anchor the chain does not contradict —
    // so it is not the highest readable anchor and must not be. This used to assert the relation
    // against `CheckpointScanOutcome.highestReadableSequence`, which the store computed and which
    // had **no reader in the workspace** (its other occurrences were fixtures producing it to
    // satisfy the type) *and* was a second derivation of this figure without the exclusion. ADR-0375
    // dropped it, so the property is stated over the fold's own answer: two higher anchors
    // contradicted, one lower anchor sound, and the witness is the sound one.
    const report = await audit(
      TENANT_A,
      chainTo(4),
      [
        page([checkpoint(1), checkpoint(3, hashOf(4))], [refusedRow(0)]),
        page([checkpoint(4, FOREIGN_HASH)]),
      ],
    );
    expect(report.witnessSequence).toBe(1);
    expect(report.disagreeing?.map((d) => d.sequenceNumber)).toEqual([3, 4]);
  });

  it("is the highest readable anchor when no chain was supplied, since nothing contradicts it", async () => {
    const report = await audit(TENANT_A, null, [page([checkpoint(1), checkpoint(4, FOREIGN_HASH)])]);
    expect(report.disagreeing).toBeNull();
    expect(report.witnessSequence).toBe(4);
  });
});

describe("the refusal cap", () => {
  const TOTAL = MAX_REPORTED_ANCHOR_REFUSALS + 10;

  async function manyRefused(): Promise<AnchorAuditReport> {
    // Spread across pages, because the cap is a property of the fold and not of one page.
    const rows = Array.from({ length: TOTAL }, (_, n) => refusedRow(n));
    const pages = [page([], rows.slice(0, 20)), page([], rows.slice(20, 45)), page([], rows.slice(45))];
    return audit(TENANT_A, chainTo(2), pages);
  }

  it("names at most the cap and still reports the whole figure", async () => {
    const report = await manyRefused();
    expect(report.refused).toHaveLength(MAX_REPORTED_ANCHOR_REFUSALS);
    expect(report.refusedCount).toBe(TOTAL);
    expect(report.scanned).toBe(TOTAL);
  });

  it("keeps the rows it met first, which under an ascending scan are the lowest sequences", async () => {
    const report = await manyRefused();
    expect(report.refused[0]?.identity).toBe("refused-0");
    expect(report.refused[MAX_REPORTED_ANCHOR_REFUSALS - 1]?.identity).toBe(
      `refused-${(MAX_REPORTED_ANCHOR_REFUSALS - 1).toString()}`,
    );
  });

  it("says in the formatter how many it did not name", async () => {
    const lines = formatAnchorAudit(await manyRefused()).join("\n");
    expect(lines).toContain(`${TOTAL.toString()} checkpoint row(s) the contract refuses`);
    expect(lines).toContain("… and 10 more");
  });

  it("names every refused row and adds no tally when there are fewer than the cap", async () => {
    const report = await audit(TENANT_A, chainTo(2), [page([], [refusedRow(0), refusedRow(1)])]);
    expect(report.refused).toHaveLength(2);
    expect(formatAnchorAudit(report).join("\n")).not.toContain("more");
  });
});

describe("a correspondence not asked for, against one asked and clean", () => {
  it("answers `null` with no chain in hand and `[]` with one", async () => {
    const pages = [page([checkpoint(1)])];
    expect((await audit(TENANT_A, null, pages)).disagreeing).toBeNull();
    expect((await audit(TENANT_A, chainTo(2), pages)).disagreeing).toEqual([]);
  });

  it("reads neither as a finding, because a question not asked is not evidence", () => {
    // The predicates treat `null` exactly as `[]`, deliberately: ADR-0372's rule is that an absence
    // of evidence is not evidence, so a correspondence nobody asked for must not answer
    // `compromised`. The distinction between the two lives in the formatter, where silence would
    // otherwise read as *asked and clean*.
    for (const disagreeing of [null, []]) {
      const report = reportOf({ disagreeing });
      expect(anchorAuditDisproves(report)).toBe(false);
      expect(anchorAuditHasFindings(report)).toBe(false);
    }
  });

  it("reads a disagreement found as a finding where one not asked for is not", () => {
    const found = reportOf({
      disagreeing: [{ kind: "root_hash_mismatch", sequenceNumber: 4, matchedAt: null }],
    });
    expect(anchorAuditDisproves(found)).toBe(true);
    expect(anchorAuditDisproves(reportOf({ disagreeing: null }))).toBe(false);
  });

  it("says so in the formatter for `null` and prints no correspondence line at all for `[]`", () => {
    const notAsked = formatAnchorAudit(reportOf({ disagreeing: null, scanned: 3 }));
    expect(notAsked.join("\n")).toContain("correspondence: not asked");

    const asked = formatAnchorAudit(reportOf({ disagreeing: [], scanned: 3 }));
    expect(asked.join("\n")).not.toContain("correspondence");
    expect(asked.join("\n")).not.toContain("DISAGREES");
    // One line and no more: a clean audit's whole output is its coverage, which is what makes the
    // not-asked line above a statement rather than noise.
    expect(asked).toHaveLength(1);
  });
});

describe("anchorAuditDisproves and anchorAuditHasFindings", () => {
  it("reads a scan the ceiling stopped as a finding that disproves nothing", () => {
    // `unproven` and not `compromised`: a count from a scan that stopped early is a lower bound, so
    // `refusedCount: 0` there is not the claim that there are none (ADR-0331, ADR-0372).
    const report = reportOf({ complete: false, scanned: 1_000 });
    expect(anchorAuditDisproves(report)).toBe(false);
    expect(anchorAuditHasFindings(report)).toBe(true);
  });

  it("reads a refused row as disproven", () => {
    const report = reportOf({ refused: [refusedRow(0)], refusedCount: 1 });
    expect(anchorAuditDisproves(report)).toBe(true);
    expect(anchorAuditHasFindings(report)).toBe(true);
  });

  it("reads a refusal the cap left unnamed as disproven, since the figure and not the list decides", () => {
    // A report round-tripped through a payload may carry the count with no rows beside it.
    const report = reportOf({ refused: [], refusedCount: 3 });
    expect(anchorAuditDisproves(report)).toBe(true);
  });

  it("reads a clean complete scan as neither", () => {
    const report = reportOf({ scanned: 4, witnessSequence: 3 });
    expect(anchorAuditDisproves(report)).toBe(false);
    expect(anchorAuditHasFindings(report)).toBe(false);
  });
});

describe("formatAnchorAudit", () => {
  it("names the scanned count, the coverage and the witness on its first line", () => {
    const lines = formatAnchorAudit(reportOf({ scanned: 4, witnessSequence: 3 }));
    expect(lines).toHaveLength(1);
    // `checkpoints:` and not `anchors:` — the live run of ADR-0375 found two lines reading
    // `anchors:` in one report, this one and `formatIntegrityProof`'s own figure for
    // `meta.audit_log` rows anchored in the chain, which an operator has to disambiguate before
    // they can act on either.
    expect(lines[0]).toContain("checkpoints: 4 row(s) scanned");
    expect(lines[0]).not.toContain("anchors:");
    expect(lines[0]).toContain("complete");
    expect(lines[0]).toContain("witness 3");
  });

  it("says an incomplete scan is incomplete and says a missing witness is none", () => {
    const lines = formatAnchorAudit(reportOf({ complete: false, scanned: 7 })).join("\n");
    expect(lines).toContain("INCOMPLETE");
    expect(lines).toContain("witness none");
  });

  it("marks a witness nobody checked as unchecked, because the number alone is two claims", () => {
    // Against a chain the witness is the highest anchor nothing contradicted; with no chain in hand
    // it is the highest *readable* one, which is `latest()`'s pre-ADR-0375 level of trust. Both are
    // honest and they are not the same claim, so the line says which — and `disagreeing` is the
    // discriminator, which is why this is one field and not two.
    const unchecked = formatAnchorAudit(
      reportOf({ scanned: 4, witnessSequence: 3, disagreeing: null }),
    ).join("\n");
    expect(unchecked).toContain("witness 3 (unchecked)");
    const checked = formatAnchorAudit(
      reportOf({ scanned: 4, witnessSequence: 3, disagreeing: [] }),
    ).join("\n");
    expect(checked).toContain("witness 3");
    expect(checked).not.toContain("unchecked");
    // `none` carries no qualifier either way: there is no witness to describe the trust in.
    expect(
      formatAnchorAudit(reportOf({ witnessSequence: null, disagreeing: null })).join("\n"),
    ).toContain("witness none");
  });

  it("carries no stored column value from a refused row, only the field and the issue code", () => {
    // ADR-0373's rule, pinned the way that increment pins `unreadableDetail` itself: the stored value
    // is in the error the store was handed, and `rowToCheckpoint` hands an out-of-enum `provenance`
    // to the parse to refuse — so this is the live path's own detail rather than an invented string.
    const STORED = "verified_by_hand_2026";
    const err = parseFailure(ChainCheckpointSchema, {
      sequenceNumber: 4,
      rootHash: hashOf(4),
      checkpointedAt: AT,
      checkpointedBy: "checkpoint-scheduler",
      provenance: STORED,
    });
    expect(err.message).toContain(STORED);
    const detail = unreadableDetail(err);
    expect(detail).toBe("provenance: invalid_enum_value");

    const lines = formatAnchorAudit(
      reportOf({ refused: [{ identity: "4", detail }], refusedCount: 1 }),
    ).join("\n");
    expect(lines).not.toContain(STORED);
    expect(lines).toContain("provenance: invalid_enum_value");
    // The identity is what a remedy's `WHERE` clause needs, and the only column of a refused row
    // this is allowed to print.
    expect(lines).toContain("checkpoint 4");
  });

  it("names a refused row that identifies nothing rather than inventing a handle", () => {
    const lines = formatAnchorAudit(
      reportOf({
        refused: [{ identity: null, detail: "sequence_number: invalid_type" }],
        refusedCount: 1,
      }),
    ).join("\n");
    expect(lines).toContain("<unidentified>");
  });

  it("names each disagreement by kind and sequence, and where the anchor belongs when it knows", () => {
    const lines = formatAnchorAudit(
      reportOf({
        disagreeing: [
          { kind: "sequence_relocated", sequenceNumber: 99, matchedAt: 4 },
          { kind: "root_hash_mismatch", sequenceNumber: 2, matchedAt: null },
        ],
      }),
    );
    expect(lines.join("\n")).toContain("DISAGREES WITH THE CHAIN: 2 anchor(s)");
    expect(lines.some((l) => l.includes("anchor at 99: sequence_relocated") && l.includes("entry at 4"))).toBe(true);
    // No `matchedAt`, so no clause about one: the mismatch says which hashes differ and nothing
    // about where the anchor belongs, because from here that is not decidable.
    expect(lines).toContain("    anchor at 2: root_hash_mismatch");
  });

  it("names the refusals and the disagreements together, since the two axes are independent", () => {
    const lines = formatAnchorAudit(
      reportOf({
        scanned: 3,
        refused: [refusedRow(0)],
        refusedCount: 1,
        disagreeing: [{ kind: "root_hash_mismatch", sequenceNumber: 2, matchedAt: null }],
      }),
    ).join("\n");
    expect(lines).toContain("REFUSED");
    expect(lines).toContain("DISAGREES WITH THE CHAIN");
  });
});

describe("auditAnchors reads the store through the scan and nothing else", () => {
  it("scans once, passing the scope and the caller's bounds straight through", async () => {
    const store = new ScriptedCheckpointStore({ pages: [page([checkpoint(1)])] });
    const report = await auditAnchors(TENANT_A, store, chainTo(2), { ceiling: 7, pageSize: 3 });
    expect(store.calls).toEqual([{ scope: TENANT_A, opts: { ceiling: 7, pageSize: 3 } }]);
    expect(report.scope).toBe(TENANT_A);
  });

  it("carries the platform scope as the null it was asked with", async () => {
    const store = new ScriptedCheckpointStore({ pages: [page([checkpoint(0)])] });
    const report = await auditAnchors(null, store, chainTo(0), {});
    expect(store.calls[0]?.scope).toBeNull();
    expect(report.scope).toBeNull();
  });

  it("quotes the scan's own coverage figures rather than counting the pages it was handed", async () => {
    // The store is the authority on both: no page carries `complete`, and the refusal total is the
    // loop's figure once the report's list is capped. Scripted to disagree with the pages so the
    // assertion says which source won.
    const report = await auditScripted(TENANT_A, chainTo(2), {
      pages: [page([checkpoint(1)])],
      outcome: { scanned: 9, refusedCount: 4, complete: false },
    });
    expect(report.scanned).toBe(9);
    expect(report.refusedCount).toBe(4);
    expect(report.complete).toBe(false);
    // And the page-derived halves are still the pages': one readable anchor, agreeing.
    expect(report.witnessSequence).toBe(1);
    expect(report.disagreeing).toEqual([]);
  });

  it("holds no checkpoint beyond the page it read", async () => {
    // Structural, because that is the only way to assert it: the report's keys are the whole of what
    // survives a page, and a key added later that carried anchors would fail here.
    const report = await audit(TENANT_A, chainTo(2), [page([checkpoint(1), checkpoint(2)])]);
    expect(Object.keys(report).sort()).toEqual([
      "complete",
      "disagreeing",
      "refused",
      "refusedCount",
      "scanned",
      "scope",
      "witnessSequence",
    ]);
  });

  it("lets a throw out of the scan reach its caller", async () => {
    // The scheduler files `outcome: "error"` for it and the proof's pass does the same, which both
    // need the throw rather than a report claiming a reading nobody took.
    class ThrowingStore extends PostgresChainCheckpointStore {
      override async scanCheckpoints(): Promise<CheckpointScanOutcome> {
        return Promise.reject(new Error("the anchor table is unreachable"));
      }
    }
    await expect(
      auditAnchors(TENANT_A, new ThrowingStore(servesNothing(), {}), chainTo(2)),
    ).rejects.toThrow("the anchor table is unreachable");
  });
});
