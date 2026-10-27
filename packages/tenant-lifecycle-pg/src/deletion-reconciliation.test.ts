import type { PgConnection } from "@crossengin/kernel-pg";
import {
  DEADLINE_STANDINGS,
  DEADLINE_STANDING_FACTS,
  DEFAULT_DEADLINE_WARNING_DAYS,
  assembleTombstone,
  type DeletionAttestation,
  type DeletionRequestStatus,
  type GdprDeletionRequest,
  type TombstoneRecordStorageDeclaration,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEADLINE_AUDIT_LIMIT,
  DEFAULT_STRANDED_AFTER_MS,
  DEFAULT_TOMBSTONE_AUDIT_LIMIT,
  DeletionReconciler,
  RECONCILIATION_VERDICTS,
  EVIDENCE_DEFECTS,
  TOMBSTONE_REFERENCE_STATES,
  TOMBSTONE_VERIFICATION_OUTCOMES,
  formatDeadlineFinding,
  isConclusive,
  needsOperator,
  tombstoneStanding,
  verifyStoredEvidence,
  type DeadlineFinding,
  type ReconciliationResult,
  type ReconcilerOptions,
} from "./deletion-reconciliation.js";
import {
  DeletionRequestCommittedUnreadable,
  PostgresDeletionRequestStore,
  REQUEST_COLUMNS,
  type UnreadableRequestRow,
} from "./deletion-request-store.js";
import {
  PostgresTombstoneStore,
  TOMBSTONE_COLUMNS,
  TOMBSTONE_SCAN_MAX_LIMIT,
  type StoredTombstone,
  type TombstoneAnchorer,
  type TombstoneScanPage,
} from "./tombstone-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const REQ = "dreq_abcdefgh1234";
const TOMB = "tomb_aaaabbbbccccdddd";

const NOW = "2026-10-03T14:00:00.000Z";

function requestOf(over: Partial<GdprDeletionRequest> = {}): GdprDeletionRequest {
  return {
    id: REQ,
    tenantId: TENANT,
    subjectIdentifier: "subject@example.test",
    legalBasis: "article_17_right_to_erasure",
    status: "in_progress",
    submittedAt: "2026-10-01T00:00:00.000Z",
    submittedBy: "subject@example.test",
    deadlineAt: "2026-10-28T00:00:00.000Z",
    verificationMethod: "email_link",
    verifiedAt: "2026-10-02T00:00:00.000Z",
    verifiedBy: "support-1",
    // Two hours before NOW, so past the default window unless a test says otherwise.
    inProgressAt: "2026-10-03T12:00:00.000Z",
    completedAt: null,
    completionSha256: null,
    rejectedAt: null,
    deferredUntil: null,
    deadlineExtendedAt: null,
    retentionObligations: ["none"],
    retainedDataCategories: [],
    tombstoneId: null,
    ...over,
  } as GdprDeletionRequest;
}

const CHAIN_HASH = "c".repeat(64);

const ATTESTATION: DeletionAttestation = {
  subsystem: "tenant_schema",
  outcome: "erased",
  scope: { schemas: ["t_abc"], tables: ["t_abc.invoice"], rowCount: 17, storageBytes: 8192 },
  attestedBy: "tenant-lifecycle-pg/deletion:alice",
  attestedAt: "2026-10-03T11:00:00.000Z",
};

/**
 * The second performed subsystem's report (ADR-0329). `nothing_to_erase` so it composes nothing
 * into the scope — every scope assertion in this file is about `tenant_schema`, and the record has
 * to carry a `shared_tables` attestation now because the contract refuses declaring it absent.
 */
const SHARED_ATTESTATION: DeletionAttestation = {
  subsystem: "shared_tables",
  outcome: "nothing_to_erase",
  attestedBy: "operate-server/shared-table-erasure",
  attestedAt: "2026-10-03T11:00:00.000Z",
};

/**
 * The record-storage declaration the v4 bytes sign (ADR-0351), shared by every fixture here so a
 * test that varies it is visibly varying one decision.
 *
 * `relationCount` is spelled out, unlike the pipeline's half of the seam: these fixtures call
 * `assembleTombstone` directly, and the derivation from a target list is the pipeline's job.
 */
const RECORD_STORAGE: TombstoneRecordStorageDeclaration = {
  model: "typed_tables",
  schema: "public",
  relationCount: 2,
};

/**
 * A **real** tombstone, assembled the way the pipeline assembles one and anchored the way the store
 * anchors one — not a stub. The verification under test is the real hash arithmetic, so a fixture
 * that merely looked like a record would have tested nothing.
 */
function tombstoneOf(id = TOMB): StoredTombstone {
  const assembled = assembleTombstone({
    id,
    kind: "data_subject_erasure",
    tenantId: TENANT,
    relatedDeletionRequestId: REQ,
    deletedAt: "2026-10-03T11:00:00.000Z",
    executedBy: "system:deletion-runner",
    approvedBy: "system:retention-policy",
    anchors: [
      {
        kind: "internal_audit_log",
        reference: "pending-chain-append",
        anchoredAt: "2026-10-03T11:00:00.000Z",
      },
    ],
    // `shared_tables` erases and attests (ADR-0329); the contract refuses declaring it absent.
    capabilities: { tenant_schema: "erases", shared_tables: "erases", object_storage: "absent", backups: "absent", search_indexes: "absent", caches: "absent" },
    recordStorage: RECORD_STORAGE,
    attestations: [ATTESTATION, SHARED_ATTESTATION],
  });
  if (!assembled.ok) throw new Error(`fixture does not assemble: ${JSON.stringify(assembled.refusals)}`);
  return {
    // The store replaces the caller's anchors with the chain entry it appended (ADR-0318). Anchors are
    // not part of the content manifest, which is why it can.
    record: {
      ...assembled.record,
      anchors: [
        {
          kind: "internal_audit_log",
          reference: CHAIN_HASH,
          anchoredAt: "2026-10-03T11:00:00.000Z",
        },
      ],
    },
    attestations: [ATTESTATION, SHARED_ATTESTATION],
    // What `rowToStoredTombstone` answers for the row this fixture describes: a real evidence array
    // that parses. `unreadable` is what the mapper reports for a column holding anything that is
    // not a list of attestations, and `destroyedEvidence` below is the fixture for it.
    attestationsRead: "parsed",
    chainEntryHash: CHAIN_HASH,
    chainSequenceNumber: 7,
  };
}

/** The honest fixture's real proof digest, so an assertion cannot drift from the arithmetic. */
const PROOF = tombstoneOf().record.proofSha256;

/**
 * The same record whose `attestations` column was **destroyed** rather than edited — what the
 * mapper answers for `'{}'`, `'null'`, `'"x"'` or an element the contract refuses.
 *
 * `attestations: []` beside `attestationsRead: "unreadable"` is the shape that matters: the array is
 * empty because nothing could be read from it, not because the proof was written with no evidence,
 * and the old reading could not tell those apart.
 */
function destroyedEvidence(): StoredTombstone {
  return { ...tombstoneOf(), attestations: [], attestationsRead: "unreadable" };
}

/**
 * The same fixture with a real statutory retention in its proof (ADR-0330, signed by ADR-0331).
 *
 * Assembled rather than patched, because the retention claim is inside the v3 bytes now: spreading
 * the three fields over a finished record would produce a proof that does not verify, which is the
 * state these tests exist to tell apart from an honest one.
 */
function retainingTombstone(): StoredTombstone {
  const retention: DeletionAttestation = {
    subsystem: "backups",
    outcome: "retained",
    retentionObligation: "tax_records_7y",
    retainedDataReference: "backup-vault://2026",
    attestedBy: "operate-server/backups",
    attestedAt: "2026-10-03T11:00:00.000Z",
  };
  const attestations = [ATTESTATION, SHARED_ATTESTATION, retention];
  const assembled = assembleTombstone({
    id: TOMB,
    kind: "data_subject_erasure",
    tenantId: TENANT,
    relatedDeletionRequestId: REQ,
    deletedAt: "2026-10-03T11:00:00.000Z",
    executedBy: "system:deletion-runner",
    approvedBy: "system:retention-policy",
    anchors: [
      {
        kind: "internal_audit_log",
        reference: "pending-chain-append",
        anchoredAt: "2026-10-03T11:00:00.000Z",
      },
    ],
    capabilities: {
      tenant_schema: "erases",
      shared_tables: "erases",
      object_storage: "absent",
      backups: "retains",
      search_indexes: "absent",
      caches: "absent",
    },
    recordStorage: RECORD_STORAGE,
    attestations,
  });
  if (!assembled.ok) {
    throw new Error(`fixture does not assemble: ${JSON.stringify(assembled.refusals)}`);
  }
  return {
    record: {
      ...assembled.record,
      anchors: [
        {
          kind: "internal_audit_log",
          reference: CHAIN_HASH,
          anchoredAt: "2026-10-03T11:00:00.000Z",
        },
      ],
    },
    attestations,
    attestationsRead: "parsed",
    chainEntryHash: CHAIN_HASH,
    chainSequenceNumber: 7,
  };
}

/** The same record with its scope edited in place — the tamper the chain cannot see. */
function tamperedTombstone(): StoredTombstone {
  const honest = tombstoneOf();
  return {
    ...honest,
    record: { ...honest.record, scope: { ...honest.record.scope, rowCount: 1 } },
  };
}

/**
 * A tombstone naming **no** deletion request — what the synchronous route of ADR-0320 writes, and
 * the whole class ADR-0327 exists for. `data_subject_erasure` cannot be one (the contract requires
 * the reference), so this is the `tenant_deletion` the erasure route produces.
 */
function unreferencedTombstone(id = "tomb_unref0001aaaa"): StoredTombstone {
  const assembled = assembleTombstone({
    id,
    kind: "tenant_deletion",
    tenantId: TENANT,
    deletedAt: "2026-10-03T11:00:00.000Z",
    executedBy: "operator:alice",
    approvedBy: "operator:bob",
    anchors: [
      {
        kind: "internal_audit_log",
        reference: "pending-chain-append",
        anchoredAt: "2026-10-03T11:00:00.000Z",
      },
    ],
    // `shared_tables` erases and attests (ADR-0329); the contract refuses declaring it absent.
    capabilities: { tenant_schema: "erases", shared_tables: "erases", object_storage: "absent", backups: "absent", search_indexes: "absent", caches: "absent" },
    recordStorage: RECORD_STORAGE,
    attestations: [ATTESTATION, SHARED_ATTESTATION],
  });
  if (!assembled.ok) {
    throw new Error(`fixture does not assemble: ${JSON.stringify(assembled.refusals)}`);
  }
  return {
    record: {
      ...assembled.record,
      anchors: [
        {
          kind: "internal_audit_log",
          reference: CHAIN_HASH,
          anchoredAt: "2026-10-03T11:00:00.000Z",
        },
      ],
    },
    attestations: [ATTESTATION, SHARED_ATTESTATION],
    attestationsRead: "parsed",
    chainEntryHash: CHAIN_HASH,
    chainSequenceNumber: 9,
  };
}

function tamper(stored: StoredTombstone): StoredTombstone {
  return {
    ...stored,
    record: { ...stored.record, scope: { ...stored.record.scope, rowCount: 1 } },
  };
}

/**
 * One row of the fake table: a tombstone the mapper could represent, or a row it refused.
 *
 * Both carry an id, because the store's cursor is the ordering on that column and a refused row
 * occupies a position in it. Modelling the refusals as a list beside the records could not express
 * a page whose **last** row is the refused one — which is the case the page shape exists for, and
 * the one a cursor taken off `records` gets wrong.
 */
type ScanRow =
  | { readonly kind: "record"; readonly id: string; readonly stored: StoredTombstone }
  | { readonly kind: "refused"; readonly id: string; readonly detail: string };

function readableRow(stored: StoredTombstone): ScanRow {
  return { kind: "record", id: stored.record.id, stored };
}

function refusedRow(id: string, detail = "approvedBy: custom"): ScanRow {
  return { kind: "refused", id, detail };
}

interface Harness {
  readonly reconciler: DeletionReconciler;
  readonly transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }>;
  readonly retired: string[];
  readonly strandedCalls: Array<{ olderThan: string; limit: number | undefined }>;
  readonly completedCalls: (number | undefined)[];
  readonly scanCalls: Array<{ limit: number; afterTombstoneId: string | null | undefined }>;
  readonly requestReads: string[];
  readonly reported: ReconciliationResult[];
  readonly unreadable: UnreadableRequestRow[];
  readonly findings: DeadlineFinding[];
  readonly unansweredCalls: (number | undefined)[];
  readonly lateRefusalCalls: (number | undefined)[];
}

function harness(
  behaviour: {
    readonly evidence?: readonly StoredTombstone[];
    readonly stranded?: readonly GdprDeletionRequest[];
    readonly retires?: boolean;
    readonly retireThrows?: boolean;
    readonly completed?: readonly GdprDeletionRequest[];
    readonly storedMissing?: boolean;
    readonly scan?: readonly StoredTombstone[];
    /**
     * The table as rows rather than as records, for a page that holds one the store refused.
     * Takes precedence over `scan`, which is the all-readable shorthand every other test uses.
     */
    readonly scanRows?: readonly ScanRow[];
    /** Which request ids `requests.read` finds. Absent means every one asked for. */
    readonly knownRequestIds?: readonly string[];
    /** Rows the store's own page could not represent, reported rather than returned. */
    readonly strandedUnreadable?: readonly UnreadableRequestRow[];
    readonly completedUnreadable?: readonly UnreadableRequestRow[];
    /** What `unanswered` returns — the waiting queue the Article 12(3) pass reads. */
    readonly unanswered?: readonly GdprDeletionRequest[];
    readonly unansweredUnreadable?: readonly UnreadableRequestRow[];
    /** What `rejectedAfterDeadline` returns — refusals recorded past their deadline. */
    readonly lateRefusals?: readonly GdprDeletionRequest[];
    readonly lateRefusalUnreadable?: readonly UnreadableRequestRow[];
    /**
     * The targets whose `transition` commits and cannot read the row back.
     *
     * The store raises `DeletionRequestCommittedUnreadable` for every `to`, so the fake has to be
     * able to model it at any target: both of this class's write sites were as unguarded as the
     * runner's, and a fake that could only model one target could only ever exercise one of them.
     */
    readonly unreadableOn?: readonly DeletionRequestStatus[];
  } = {},
  over: Partial<ReconcilerOptions> = {},
): Harness {
  const transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }> = [];
  const retired: string[] = [];
  const strandedCalls: Array<{ olderThan: string; limit: number | undefined }> = [];
  const completedCalls: (number | undefined)[] = [];
  const scanCalls: Array<{ limit: number; afterTombstoneId: string | null | undefined }> = [];
  const requestReads: string[] = [];
  const reported: ReconciliationResult[] = [];
  const unreadable: UnreadableRequestRow[] = [];
  const findings: DeadlineFinding[] = [];
  const unansweredCalls: (number | undefined)[] = [];
  const lateRefusalCalls: (number | undefined)[] = [];
  const requests = {
    transition: async (
      id: string,
      to: string,
      fields: Record<string, unknown>,
    ): Promise<GdprDeletionRequest | null> => {
      transitions.push({ id, to, fields: { ...fields } });
      if ((behaviour.unreadableOn ?? []).includes(to as DeletionRequestStatus)) {
        throw new DeletionRequestCommittedUnreadable(
          id,
          to as DeletionRequestStatus,
          "the stored row cannot be represented",
        );
      }
      return requestOf({ status: to as GdprDeletionRequest["status"] });
    },
    read: async (id: string): Promise<GdprDeletionRequest | null> => {
      requestReads.push(id);
      const known = behaviour.knownRequestIds;
      if (known !== undefined && !known.includes(id)) return null;
      return requestOf({ id });
    },
    // Both sweeps take their reporter *before* the optional limit: it is required, and a required
    // parameter cannot follow an optional one. The fake calls it so a test can assert that an
    // unrepresentable row is reported and the rest of the page still walked.
    stranded: async (
      olderThan: string,
      onUnreadable: (row: UnreadableRequestRow) => void,
      limit?: number,
    ): Promise<readonly GdprDeletionRequest[]> => {
      strandedCalls.push({ olderThan, limit });
      for (const row of behaviour.strandedUnreadable ?? []) onUnreadable(row);
      return behaviour.stranded ?? [requestOf()];
    },
    completedWithTombstone: async (
      onUnreadable: (row: UnreadableRequestRow) => void,
      limit?: number,
    ): Promise<readonly GdprDeletionRequest[]> => {
      completedCalls.push(limit);
      for (const row of behaviour.completedUnreadable ?? []) onUnreadable(row);
      return behaviour.completed ?? [];
    },
    // The Article 12(3) pass's two reads. Separate counters, because the pass's `complete` is a
    // conjunction over both and a fake that answered one call for both could not express a page cut
    // on only one of them.
    unanswered: async (
      onUnreadable: (row: UnreadableRequestRow) => void,
      limit?: number,
    ): Promise<readonly GdprDeletionRequest[]> => {
      unansweredCalls.push(limit);
      for (const row of behaviour.unansweredUnreadable ?? []) onUnreadable(row);
      return behaviour.unanswered ?? [];
    },
    rejectedAfterDeadline: async (
      onUnreadable: (row: UnreadableRequestRow) => void,
      limit?: number,
    ): Promise<readonly GdprDeletionRequest[]> => {
      lateRefusalCalls.push(limit);
      for (const row of behaviour.lateRefusalUnreadable ?? []) onUnreadable(row);
      return behaviour.lateRefusals ?? [];
    },
  } as unknown as PostgresDeletionRequestStore;
  const tombstones = {
    findForRequest: async (): Promise<readonly StoredTombstone[]> => behaviour.evidence ?? [],
    read: async (id: string): Promise<StoredTombstone | null> => {
      if (behaviour.storedMissing === true) return null;
      return (behaviour.evidence ?? [tombstoneOf()]).find((t) => t.record.id === id) ?? null;
    },
    scanAll: async (input: {
      limit: number;
      afterTombstoneId?: string | null;
    }): Promise<TombstoneScanPage> => {
      scanCalls.push({ limit: input.limit, afterTombstoneId: input.afterTombstoneId });
      const all = behaviour.scanRows ?? (behaviour.scan ?? []).map((s) => readableRow(s));
      const after = input.afterTombstoneId ?? null;
      // A real keyset page, so a test about the cursor is a test about the cursor.
      const ordered = [...all].sort((a, b) => a.id.localeCompare(b.id));
      const from = after === null ? ordered : ordered.filter((r) => r.id > after);
      const rows = from.slice(0, input.limit);
      const last = rows[rows.length - 1];
      return {
        records: rows.flatMap((r) => (r.kind === "record" ? [r.stored] : [])),
        unreadable: rows.flatMap((r) =>
          r.kind === "refused" ? [{ identity: r.id, detail: r.detail }] : [],
        ),
        // Off the last **row**, readable or not, which is what the store does and the reason the
        // page carries it: a fake that took it from the records would agree with a caller that
        // derived it the same wrong way, and the pair would be green together.
        lastTombstoneId: last === undefined ? null : last.id,
        rowsRead: rows.length,
      };
    },
  } as unknown as PostgresTombstoneStore;

  const reconciler = new DeletionReconciler({
    requests,
    tombstones,
    retire: async (tenantId): Promise<boolean> => {
      retired.push(tenantId);
      if (behaviour.retireThrows === true) throw new Error("tenant store unreachable");
      return behaviour.retires ?? true;
    },
    clock: () => new Date(NOW),
    onReconciled: (r) => reported.push(r),
    onUnreadableRequest: (row) => unreadable.push(row),
    onDeadlineFinding: (f) => findings.push(f),
    ...over,
  });
  return {
    reconciler,
    transitions,
    retired,
    strandedCalls,
    completedCalls,
    scanCalls,
    requestReads,
    reported,
    unreadable,
    findings,
    unansweredCalls,
    lateRefusalCalls,
  };
}

describe("the verdicts", () => {
  it("name every outcome once, and split conclusive from operator-owned", () => {
    expect(RECONCILIATION_VERDICTS).toEqual([
      "completed_by_evidence",
      "never_committed",
      "ambiguous_evidence",
      "too_recent",
      "evidence_unverified",
      "not_stranded",
    ]);
    // Only a present tombstone stands on its own: an absence is an inference, however old.
    expect(RECONCILIATION_VERDICTS.filter((v) => isConclusive(v))).toEqual([
      "completed_by_evidence",
    ]);
    expect(RECONCILIATION_VERDICTS.filter((v) => needsOperator(v))).toEqual([
      "never_committed",
      "ambiguous_evidence",
      "evidence_unverified",
    ]);
  });

  it("waits an hour by default before reading anything into an absence", () => {
    expect(DEFAULT_STRANDED_AFTER_MS).toBe(3_600_000);
  });
});

describe("assess", () => {
  it("reads a tombstone naming the request as proof the deletion committed", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.assess(requestOf());
    expect(result.verdict).toBe("completed_by_evidence");
    expect(result.tombstoneId).toBe(TOMB);
    expect(result.applied).toBe(false);
    expect(h.transitions).toEqual([]);
  });

  it("is conclusive on evidence even for a request stranded seconds ago", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.assess(
      requestOf({ inProgressAt: "2026-10-03T13:59:59.000Z" }),
    );
    // The tombstone and the DROP committed together, so its existence is not a hint about what
    // probably happened — waiting would add nothing.
    expect(result.verdict).toBe("completed_by_evidence");
    expect(result.strandedForMs).toBe(1000);
  });

  it("reads no tombstone past the window as never committed", async () => {
    const result = await harness().reconciler.assess(requestOf());
    expect(result.verdict).toBe("never_committed");
    expect(result.detail).toContain("did not commit");
  });

  it("will not read anything into an absence inside the window", async () => {
    const h = harness();
    const result = await h.reconciler.assess(
      requestOf({ inProgressAt: "2026-10-03T13:30:00.000Z" }),
    );
    // "not committed" and "not committed yet" look identical; a pipeline running right now has
    // written no tombstone either.
    expect(result.verdict).toBe("too_recent");
    expect(result.strandedForMs).toBe(1_800_000);
  });

  it("refuses to choose between two tombstones naming one request", async () => {
    const h = harness({ evidence: [tombstoneOf(), tombstoneOf("tomb_bbbbccccddddeeee")] });
    const result = await h.reconciler.assess(requestOf());
    // The premise is that one request has at most one tombstone. Two breaks it, and that is a
    // finding rather than a row to pick from.
    expect(result.verdict).toBe("ambiguous_evidence");
    expect(result.tombstoneId).toBeNull();
    expect(result.tombstoneIds).toHaveLength(2);
  });

  it("says nothing to do for a request that is not in_progress", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.assess(requestOf({ status: "verified", inProgressAt: null }));
    expect(result.verdict).toBe("not_stranded");
    expect(result.strandedForMs).toBe(0);
  });

  it("does not query for evidence it has no use for", async () => {
    let asked = 0;
    const h = harness({}, {
      tombstones: {
        findForRequest: async (): Promise<readonly StoredTombstone[]> => {
          asked += 1;
          return [];
        },
      } as unknown as PostgresTombstoneStore,
    });
    await h.reconciler.assess(requestOf({ status: "completed", tombstoneId: TOMB }));
    expect(asked).toBe(0);
  });
});

describe("reconcileOne", () => {
  it("completes the request from the tombstone's own id and digest", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.applied).toBe(true);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]?.to).toBe("completed");
    expect(h.transitions[0]?.fields["tombstoneId"]).toBe(TOMB);
    // Off the stored proof, never recomputed, or the join ADR-0321 added is a lie.
    expect(h.transitions[0]?.fields["completionSha256"]).toBe(PROOF);
  });

  it("retires a tenant row the dead run never got to", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(h.retired).toEqual([TENANT]);
    expect(result.tenantRetired).toBe(true);
  });

  it("still retires the row when the completed write committed and cannot be read back", async () => {
    // The sharpest of the six unguarded write sites. The throw used to escape *between* the
    // committed `completed` write and the retire, so the repair ran, the tenant row stayed live,
    // nothing recorded that the request had been resolved, and no later sweep could see it either —
    // `stranded` walks `in_progress` and the row now reads `completed`.
    const h = harness({ evidence: [tombstoneOf()], unreadableOn: ["completed"] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.applied).toBe(true);
    expect(h.retired).toEqual([TENANT]);
    expect(result.tenantRetired).toBe(true);
    // The verdict is unchanged — the evidence settled it and the write committing does not move it —
    // so the condition lands in `detail`, which is what an operator reads.
    expect(result.verdict).toBe("completed_by_evidence");
    expect(result.detail).toContain("recorded 'completed'");
    expect(result.detail).toContain("cannot be read back");
    // And it reached `onReconciled`, which a propagating throw skipped.
    expect(h.reported).toHaveLength(1);
  });

  it("still reports an authorised never_committed whose write cannot be read back", async () => {
    const h = harness({ evidence: [], unreadableOn: ["rejected"] });
    const result = await h.reconciler.reconcileOne(requestOf(), { applyNeverCommitted: true });
    expect(result.verdict).toBe("never_committed");
    expect(result.applied).toBe(true);
    expect(result.detail).toContain("recorded 'rejected'");
    // The original verdict detail survives beside the note rather than being replaced by it.
    expect(result.detail).toContain("no tombstone names this request");
  });

  it("does not take the rest of the stranded page with it", async () => {
    // `reconcileStranded` loops `reconcileOne`, so the propagating throw dropped every other
    // stranded request — the same shape as the runner's and as the list read's.
    const second = requestOf({ id: "dreq_secondone123" });
    const h = harness({
      evidence: [tombstoneOf()],
      stranded: [requestOf(), second],
      unreadableOn: ["completed"],
    });
    const results = await h.reconciler.reconcileStranded();
    expect(results.map((r) => r.requestId)).toEqual([REQ, "dreq_secondone123"]);
    expect(results.every((r) => r.applied)).toBe(true);
    expect(h.retired).toEqual([TENANT, TENANT]);
  });

  it("still records the completion when retiring the row fails", async () => {
    const h = harness({ evidence: [tombstoneOf()], retireThrows: true });
    const result = await h.reconciler.reconcileOne(requestOf());
    // The request is recorded against a real tombstone; failing over the row's status would undo
    // the part that was worth doing.
    expect(result.applied).toBe(true);
    expect(result.tenantRetired).toBeNull();
  });

  it("reports tenantRetired as null when no retire was wired", async () => {
    const h = harness({ evidence: [tombstoneOf()] }, { retire: undefined });
    const result = await h.reconciler.reconcileOne(requestOf());
    // null, not false: "not attempted" and "attempted and matched nothing" are different answers.
    expect(result.tenantRetired).toBeNull();
    expect(result.applied).toBe(true);
  });

  it("writes nothing for never_committed unless an operator authorises it", async () => {
    const h = harness();
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.verdict).toBe("never_committed");
    expect(result.applied).toBe(false);
    expect(h.transitions).toEqual([]);
  });

  it("rejects the request when an operator does authorise it", async () => {
    const h = harness();
    const result = await h.reconciler.reconcileOne(requestOf(), { applyNeverCommitted: true });
    expect(result.applied).toBe(true);
    expect(h.transitions[0]?.to).toBe("rejected");
    expect(String(h.transitions[0]?.fields["rejectedReason"])).toContain("reconciled:");
  });

  it("will not reject on an authorisation when the verdict is only too_recent", async () => {
    const h = harness();
    const result = await h.reconciler.reconcileOne(
      requestOf({ inProgressAt: "2026-10-03T13:59:00.000Z" }),
      { applyNeverCommitted: true },
    );
    // The operator authorised applying an inference, not skipping the window that makes it one.
    expect(result.verdict).toBe("too_recent");
    expect(h.transitions).toEqual([]);
  });

  it("never writes on ambiguous evidence, authorised or not", async () => {
    const h = harness({ evidence: [tombstoneOf(), tombstoneOf("tomb_bbbbccccddddeeee")] });
    const result = await h.reconciler.reconcileOne(requestOf(), { applyNeverCommitted: true });
    expect(result.verdict).toBe("ambiguous_evidence");
    expect(h.transitions).toEqual([]);
  });

  it("reports every reconciliation through onReconciled", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    await h.reconciler.reconcileOne(requestOf());
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.verdict).toBe("completed_by_evidence");
  });
});

describe("reconcileStranded", () => {
  it("lists every in_progress request, not just those past the window", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    await h.reconciler.reconcileStranded();
    // The window governs the inference from absence, not the listing: a committed deletion whose
    // status write failed is conclusive immediately, and that is the case worth fixing promptly.
    expect(h.strandedCalls[0]?.olderThan).toBe(NOW);
  });

  it("reconciles the rest of the page past a row the contract cannot represent", async () => {
    const h = harness({
      evidence: [tombstoneOf()],
      strandedUnreadable: [
        { requestId: "dreq_bad123456789", detail: "in_progress status requires inProgressAt" },
      ],
    });
    const results = await h.reconciler.reconcileStranded();
    // One refused row used to end the whole pass, which is the same silence `reconcileStranded`
    // exists to break: a stranded request is only ever seen again by this method.
    expect(results).toHaveLength(1);
    expect(h.unreadable.map((r) => r.requestId)).toEqual(["dreq_bad123456789"]);
  });

  it("applies the conclusive verdict and leaves the inference alone", async () => {
    const h = harness({
      stranded: [requestOf(), requestOf({ id: "dreq_two12345678" })],
    });
    const results = await h.reconciler.reconcileStranded();
    expect(results.map((r) => r.verdict)).toEqual(["never_committed", "never_committed"]);
    // A scheduler may not apply an inference from silence.
    expect(h.transitions).toEqual([]);
  });

  it("forwards the batch limit", async () => {
    const h = harness();
    await h.reconciler.reconcileStranded(3);
    expect(h.strandedCalls[0]?.limit).toBe(3);
  });

  it("returns an empty list when nothing is in progress", async () => {
    const h = harness({ stranded: [] });
    expect(await h.reconciler.reconcileStranded()).toEqual([]);
  });
});

describe("verifyStoredEvidence", () => {
  it("accepts a tombstone the pipeline really assembled and the store really anchored", () => {
    const check = verifyStoredEvidence(tombstoneOf());
    expect(check).toEqual({ ok: true, defects: [], matchesAttestations: true });
  });

  it("names every defect it can find", () => {
    expect(EVIDENCE_DEFECTS).toEqual([
      "scope_tampered",
      "proof_mismatch",
      "scope_disagrees_with_attestations",
      "attestations_unreadable",
      "unwitnessed",
    ]);
  });

  it("catches the scope tamper the chain cannot see", () => {
    const check = verifyStoredEvidence(tamperedTombstone());
    // The chain entry commits to the digests and the identity, never the scope (ADR-0318), and
    // `proofSha256` commits to `contentManifestSha256` rather than to the scope — so editing the
    // scope column leaves the proof and the chain intact. These two are the only detectors.
    expect(check.ok).toBe(false);
    expect(check.defects).toContain("scope_tampered");
    expect(check.defects).toContain("scope_disagrees_with_attestations");
    expect(check.matchesAttestations).toBe(false);
    // Proving the point: the proof itself still checks out.
    expect(check.defects).not.toContain("proof_mismatch");
  });

  it("catches a retention claim edited after signing", () => {
    // ADR-0331. Until the claim went inside the v3 bytes, this edit was invisible to everything: the
    // chain commits to the digests and the identity, `proofSha256` commits to `contentManifestSha256`,
    // and neither commits to why a tenant's data survived. So a stored proof's answer to "what did
    // you keep, and under what obligation" could be rewritten with every hash byte-identical.
    const honest = retainingTombstone();
    expect(verifyStoredEvidence(honest)).toEqual({ ok: true, defects: [], matchesAttestations: true });
    const edited: StoredTombstone = {
      ...honest,
      record: { ...honest.record, retainedDataReference: "backup-vault://elsewhere" },
    };
    const check = verifyStoredEvidence(edited);
    expect(check.ok).toBe(false);
    expect(check.defects).toContain("scope_tampered");
    // The proof still checks out, which is exactly why `contentManifestOk` is the only detector —
    // the same division of labour the scope has had since ADR-0323.
    expect(check.defects).not.toContain("proof_mismatch");
  });

  it("accepts an honest v4 proof and catches a record-storage declaration edited after storage", () => {
    // ADR-0351, and the fourth instance of one shape. Before the declaration went inside the v4
    // bytes this edit was invisible to everything: the chain commits to the digests and the
    // identity, `proofSha256` commits to `contentManifestSha256`, and neither commits to where the
    // deployment kept the tenant's records — so a stored proof's answer to "did you hold these in
    // typed relations, and how many" could be rewritten with every hash byte-identical.
    //
    // `document_rows` is the edit that pays: it asserts there were no typed relations at all, which
    // is what makes the scope's silence about them read as honest.
    const honest = tombstoneOf();
    expect(honest.record.proofVersion).toBe("v4");
    expect(verifyStoredEvidence(honest)).toEqual({ ok: true, defects: [], matchesAttestations: true });
    const edited: StoredTombstone = {
      ...honest,
      record: {
        ...honest.record,
        recordStorage: { model: "document_rows", schema: null, relationCount: 0 },
      },
    };
    const check = verifyStoredEvidence(edited);
    expect(check.ok).toBe(false);
    expect(check.defects).toContain("scope_tampered");
    // The proof still checks out and the attestations still compose the same scope — a declaration
    // is a property of the deployment and composes nothing, so `contentManifestOk` is the only
    // detector, exactly as it is for the retention claim.
    expect(check.defects).not.toContain("proof_mismatch");
    expect(check.matchesAttestations).toBe(true);
  });

  it("catches a relation count moved with the model left alone", () => {
    // The narrower half, and why `relationCount` earns the version: a `typed_tables` declaration
    // counting zero is its own claim, so an editor that only moves the figure rewrites how much the
    // deployment held without touching what kind of store it was.
    const edited: StoredTombstone = {
      ...tombstoneOf(),
      record: { ...tombstoneOf().record, recordStorage: { ...RECORD_STORAGE, relationCount: 0 } },
    };
    expect(verifyStoredEvidence(edited).defects).toEqual(["scope_tampered"]);
  });

  it("catches a retained attestation deleted out of the evidence", () => {
    // The second detector's own contribution, and a gap the scope comparison could not close: a
    // retention-bearing attestation composes *nothing* into a `DeletionScope`, so deleting one left
    // the recomposed scope identical and both detectors satisfied before ADR-0331.
    const honest = retainingTombstone();
    const stripped: StoredTombstone = {
      ...honest,
      attestations: honest.attestations.filter((a) => a.subsystem !== "backups"),
    };
    const check = verifyStoredEvidence(stripped);
    expect(check.matchesAttestations).toBe(false);
    expect(check.defects).toContain("scope_disagrees_with_attestations");
    // And the record itself is untouched, so the digest has nothing to say about it.
    expect(check.defects).not.toContain("scope_tampered");
  });

  it("refuses a tombstone nothing in the chain witnesses", () => {
    const honest = tombstoneOf();
    const unwitnessed = { ...honest, chainEntryHash: null, chainSequenceNumber: null };
    // A row anybody with write access could have inserted is not a proof.
    expect(verifyStoredEvidence(unwitnessed).defects).toEqual(["unwitnessed"]);
  });

  it("refuses a chain hash the record itself does not commit to", () => {
    const honest = tombstoneOf();
    const mismatched = { ...honest, chainEntryHash: "d".repeat(64) };
    // Stronger than "is the column set": the record's anchors must name that entry, so setting the
    // column without the record committing to it does not pass.
    expect(verifyStoredEvidence(mismatched).defects).toEqual(["unwitnessed"]);
  });

  it("reports no attestations as cannot-say, and does not fail over it", () => {
    const honest = tombstoneOf();
    const check = verifyStoredEvidence({ ...honest, attestations: [], attestationsRead: "parsed" });
    // null, not false: the hashes still establish the record is intact and commits to its own scope,
    // which is what completing a request needs (ADR-0318's habit). This is the legitimate case —
    // `'[]'` is what `write(record)` and the column default both produce — and it must not regress
    // into a defect now that a destroyed column is one.
    expect(check.matchesAttestations).toBeNull();
    expect(check.ok).toBe(true);
    expect(check.defects).toEqual([]);
  });

  it("makes a destroyed evidence column a defect, which was the easier tamper of the two", () => {
    // Measured live: with the attestations edited to a valid array that *disagrees*, the record was
    // caught by name; with the column replaced by `'{}'`, `'null'` or `'"x"'` it read
    // `ok=true defects=[] matchesAttestations=null`. So editing the evidence was caught and
    // destroying it was not — and `tombstoneMatchesAttestations` is one of only two detectors for a
    // tampered scope, so this is how you switch it off.
    const check = verifyStoredEvidence(destroyedEvidence());
    expect(check.ok).toBe(false);
    expect(check.defects).toEqual(["attestations_unreadable"]);
  });

  it("keeps matchesAttestations null for it, because nothing could be compared", () => {
    const check = verifyStoredEvidence(destroyedEvidence());
    // Both are true at once and neither is the other's substitute: `null` is the honest answer to
    // "did the scope match its evidence" when there was no evidence to read, and the defect beside
    // it is what says the absence is a finding. Reporting `false` here would claim a disagreement
    // nobody established, which is the confusion the comment on that gate has always forbidden.
    expect(check.matchesAttestations).toBeNull();
    expect(check.defects).toContain("attestations_unreadable");
  });

  it("reads the mapper's reading rather than inferring it from the array being empty", () => {
    // The two differ in exactly one field and in nothing a length could see.
    const honest = { ...tombstoneOf(), attestations: [], attestationsRead: "parsed" } as const;
    expect(verifyStoredEvidence(honest).defects).toEqual([]);
    expect(verifyStoredEvidence({ ...honest, attestationsRead: "unreadable" }).defects).toEqual([
      "attestations_unreadable",
    ]);
  });

  it("reports it beside the defects a destroyed column cannot hide", () => {
    // Destroying the evidence silences the comparison and nothing else, so a record that is also
    // internally tampered still reports both — the one defect does not mask the other.
    const check = verifyStoredEvidence({
      ...tamperedTombstone(),
      attestations: [],
      attestationsRead: "unreadable",
    });
    expect(check.defects).toContain("attestations_unreadable");
    expect(check.defects).toContain("scope_tampered");
    // And not the comparison's own defect, which could not run at all.
    expect(check.defects).not.toContain("scope_disagrees_with_attestations");
  });
});

describe("the evidence gate on completing a request", () => {
  it("refuses to complete a request from a tampered tombstone", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.verdict).toBe("evidence_unverified");
    expect(result.applied).toBe(false);
    // Nothing written: the request's completionSha256 is the platform's claim about a proof, and
    // copying a digest off a record that fails verification launders the defect into a second row.
    expect(h.transitions).toEqual([]);
    expect(h.retired).toEqual([]);
  });

  it("names the tombstone and its defects so an operator can act", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.tombstoneId).toBe(TOMB);
    expect(result.evidence?.defects).toContain("scope_tampered");
    expect(result.detail).toContain("does not verify");
  });

  it("is not overridable by the operator's authorisation", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const result = await h.reconciler.reconcileOne(requestOf(), { applyNeverCommitted: true });
    // That flag authorises an inference from an absence; it says nothing about a record that lies.
    expect(result.verdict).toBe("evidence_unverified");
    expect(h.transitions).toEqual([]);
  });

  it("carries the passing check on a conclusive verdict too", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.verdict).toBe("completed_by_evidence");
    expect(result.evidence?.ok).toBe(true);
  });

  it("a scheduler pass never applies an unverified one", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const results = await h.reconciler.reconcileStranded();
    expect(results.map((r) => r.verdict)).toEqual(["evidence_unverified"]);
    expect(h.transitions).toEqual([]);
  });
});

describe("auditCompleted", () => {
  const COMPLETED = requestOf({
    status: "completed",
    completedAt: "2026-10-03T12:00:00.000Z",
    completionSha256: PROOF,
    tombstoneId: TOMB,
  });

  it("reports nothing when a completed request's proof still stands up", async () => {
    const h = harness({ completed: [COMPLETED], evidence: [tombstoneOf()] });
    // Findings only: a listing of every completed request grows without bound and says nothing.
    expect(await h.reconciler.auditCompleted()).toEqual([]);
    expect(h.unreadable).toEqual([]);
  });

  it("still audits the rest of the page past a row the contract cannot represent", async () => {
    // The whole of Part B, at the surface it matters most on. The store used to `.map()` the page,
    // so one refused row threw out of the whole thing and *this* method stopped examining every
    // other completed request — and because its answer is the **absence** of findings, a throw and
    // a clean audit were the same observation: a claim that every completed deletion still verifies,
    // which nothing had checked.
    const h = harness({
      completed: [COMPLETED],
      // Not returned by the page, so a reconciler that only read the returned rows would see a
      // clean audit; the reporter is the only place this row exists.
      completedUnreadable: [
        { requestId: "dreq_bad123456789", detail: "completed status requires completionSha256" },
      ],
      storedMissing: true,
    });
    const findings = await h.reconciler.auditCompleted();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.requestId).toBe(COMPLETED.id);
    expect(h.unreadable).toEqual([
      { requestId: "dreq_bad123456789", detail: "completed status requires completionSha256" },
    ]);
  });

  it("keeps the unreadable row out of the findings, which require a trustworthy id", async () => {
    // Not folded into `EvidenceAudit`: that shape requires a requestId, a tenantId and a
    // tombstoneId, and a row the contract refused supplies none of them trustworthily. Inventing
    // them is the claim-with-no-evidence this surface exists to refuse.
    const h = harness({
      completed: [],
      completedUnreadable: [{ requestId: null, detail: "verifiedBy" }],
    });
    expect(await h.reconciler.auditCompleted()).toEqual([]);
    expect(h.unreadable).toHaveLength(1);
  });

  it("finds a request whose tombstone is gone", async () => {
    const h = harness({ completed: [COMPLETED], storedMissing: true });
    const findings = await h.reconciler.auditCompleted();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.present).toBe(false);
    expect(findings[0]?.check).toBeNull();
    expect(findings[0]?.detail).toContain("no longer exists");
  });

  it("finds a request whose tombstone no longer verifies", async () => {
    const h = harness({ completed: [COMPLETED], evidence: [tamperedTombstone()] });
    const findings = await h.reconciler.auditCompleted();
    expect(findings[0]?.present).toBe(true);
    expect(findings[0]?.check?.defects).toContain("scope_tampered");
  });

  it("finds a request whose own digest disagrees with the proof", async () => {
    const h = harness({
      completed: [requestOf({ ...COMPLETED, completionSha256: "f".repeat(64) })],
      evidence: [tombstoneOf()],
    });
    const findings = await h.reconciler.auditCompleted();
    // A third question the stranded path never asks: the request carries its own copy, so the two
    // can disagree even when both records are internally intact.
    expect(findings[0]?.digestMatches).toBe(false);
    expect(findings[0]?.detail).toContain("does not match");
  });

  it("forwards the limit", async () => {
    const h = harness({ completed: [] });
    await h.reconciler.auditCompleted(7);
    expect(h.completedCalls).toEqual([7]);
  });

  /** A completion two days past its Article 12(3) deadline, otherwise perfectly evidenced. */
  const LATE = requestOf({
    status: "completed",
    completedAt: "2026-10-30T00:00:00.000Z",
    completionSha256: PROOF,
    tombstoneId: TOMB,
  });

  it("reports a completion past its Article 12(3) deadline, and not as a finding", async () => {
    const h = harness({ completed: [LATE], evidence: [tombstoneOf()] });
    const findings = await h.reconciler.auditCompleted();
    // Not an `EvidenceAudit`: this proof stands up, so every field of a finding would say nothing is
    // wrong — and every finding reaches the escalator, which pages a sev1 for a tamper.
    expect(findings).toEqual([]);
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0]).toEqual({
      requestId: LATE.id,
      tenantId: TENANT,
      tombstoneId: TOMB,
      assessment: {
        standing: "answered_late",
        status: "completed",
        deadlineAt: "2026-10-28T00:00:00.000Z",
        answeredAt: "2026-10-30T00:00:00.000Z",
        msPastDeadline: 2 * 86_400_000,
        extendedAt: null,
        warningDays: DEFAULT_DEADLINE_WARNING_DAYS,
      },
    });
  });

  it("says nothing about a completion that met its deadline", async () => {
    const h = harness({ completed: [COMPLETED], evidence: [tombstoneOf()] });
    await h.reconciler.auditCompleted();
    expect(h.findings).toEqual([]);
  });

  it("reports the breach even when the proof is also broken, because neither answer is the other", async () => {
    // The reason the emit is first in the loop body: the two questions are independent, and the
    // `continue` for a missing tombstone is taken before any finding is pushed.
    const h = harness({ completed: [LATE], storedMissing: true });
    const findings = await h.reconciler.auditCompleted();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.present).toBe(false);
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0]?.requestId).toBe(LATE.id);
  });

  it("reports a completed request that states no completion time, as neither late nor on time", async () => {
    // A **behaviour change**, and the direction is the whole of it. The predicate this replaced
    // answered `false` here and the pass said nothing, so a `completed` row whose `completed_at` the
    // contract refuses read exactly like a compliant completion. `answer_time_unstated` is a
    // declared standing that is `reported: true` and `breached: false`: a record that cannot say is
    // a finding, and calling it either thing would be a claim nobody established.
    const h = harness({
      completed: [requestOf({ ...LATE, completedAt: null })],
      evidence: [tombstoneOf()],
    });
    await h.reconciler.auditCompleted();
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0]?.assessment.standing).toBe("answer_time_unstated");
    expect(h.findings[0]?.assessment.msPastDeadline).toBeNull();
  });
});

describe("auditDeadlines", () => {
  /** A `submitted` request nobody verified, five days past its deadline. */
  const BREACHED = requestOf({
    id: "dreq_breached0001",
    status: "submitted",
    verificationMethod: null,
    verifiedAt: null,
    verifiedBy: null,
    inProgressAt: null,
    deadlineAt: "2026-09-28T00:00:00.000Z",
  });

  /** A `verified` request whose deadline is three days out — the one standing an act can change. */
  const APPROACHING = requestOf({
    id: "dreq_approach0001",
    status: "verified",
    inProgressAt: null,
    deadlineAt: "2026-10-06T00:00:00.000Z",
  });

  /** A `verified` request 24 days from its deadline. */
  const HEALTHY = requestOf({ id: "dreq_healthy00001", status: "verified", inProgressAt: null });

  /** A refusal recorded two days past the deadline — Article 12(4)'s breach. */
  const LATE_REFUSAL = requestOf({
    id: "dreq_refused00001",
    status: "rejected",
    inProgressAt: null,
    rejectedAt: "2026-09-30T00:00:00.000Z",
    rejectedReason: "not a data subject",
    deadlineAt: "2026-09-28T00:00:00.000Z",
  });

  it("reports a submitted request nobody verified, which no query in the workspace could find", async () => {
    // The register's likeliest real breach path, and the reason it was invisible: this store's three
    // queries named `verified`, `in_progress` and `completed`, so `submitted` was read by nothing.
    const h = harness({ unanswered: [BREACHED] });
    const page = await h.reconciler.auditDeadlines();
    expect(page.findings.map((f) => f.assessment.standing)).toEqual(["breached"]);
    expect(page.findings[0]?.requestId).toBe(BREACHED.id);
    expect(page.findings[0]?.assessment.status).toBe("submitted");
    expect(page.examined).toBe(1);
    expect(page.complete).toBe(true);
  });

  it("reports an approaching deadline as the one standing that can still be met", async () => {
    const h = harness({ unanswered: [APPROACHING] });
    const page = await h.reconciler.auditDeadlines();
    expect(page.findings[0]?.assessment.standing).toBe("approaching");
    // The escalation axis: this is the only finding a page could usefully wake somebody for.
    expect(
      DEADLINE_STANDING_FACTS[page.findings[0]?.assessment.standing ?? "breached"]
        .deadlineCanStillBeMet,
    ).toBe(true);
  });

  it("says nothing about a request comfortably inside its deadline", async () => {
    const h = harness({ unanswered: [HEALTHY] });
    const page = await h.reconciler.auditDeadlines();
    expect(page.findings).toEqual([]);
    // And the denominator is still reported, because "nothing was found" is only a claim with it
    // (ADR-0323).
    expect(page.examined).toBe(1);
  });

  it("reports a refusal recorded past the deadline — the third breach shape", async () => {
    // Article 12(4) puts a refusal under the same clock. `auditCompleted` walks `completed` and the
    // waiting read walks the four unanswered statuses, so this was covered by neither.
    const h = harness({ lateRefusals: [LATE_REFUSAL] });
    const page = await h.reconciler.auditDeadlines();
    expect(page.findings[0]?.assessment).toMatchObject({
      standing: "answered_late",
      status: "rejected",
      answeredAt: "2026-09-30T00:00:00.000Z",
      msPastDeadline: 2 * 86_400_000,
    });
  });

  it("reads both pages and reports every finding from both", async () => {
    const h = harness({
      unanswered: [BREACHED, APPROACHING, HEALTHY],
      lateRefusals: [LATE_REFUSAL],
    });
    const page = await h.reconciler.auditDeadlines();
    expect(page.examined).toBe(4);
    expect(page.findings.map((f) => f.requestId)).toEqual([
      BREACHED.id,
      APPROACHING.id,
      LATE_REFUSAL.id,
    ]);
    // The reporter saw exactly the page, by construction rather than by two readings of the standing.
    expect(h.findings).toEqual([...page.findings]);
  });

  it("writes nothing", async () => {
    // A deadline is not a repair: curing an approaching one is the runner's act or an operator's,
    // and nothing cures a breach at all (ADR-0323's rule, one subject over).
    const h = harness({ unanswered: [BREACHED], lateRefusals: [LATE_REFUSAL] });
    await h.reconciler.auditDeadlines();
    expect(h.transitions).toEqual([]);
    expect(h.retired).toEqual([]);
  });

  it("forwards the limit to both reads and clamps it", async () => {
    const h = harness();
    await h.reconciler.auditDeadlines(7);
    expect(h.unansweredCalls).toEqual([7]);
    expect(h.lateRefusalCalls).toEqual([7]);
    const d = harness();
    await d.reconciler.auditDeadlines();
    expect(d.unansweredCalls).toEqual([DEFAULT_DEADLINE_AUDIT_LIMIT]);
    const c = harness();
    await c.reconciler.auditDeadlines(99_999);
    expect(c.unansweredCalls).toEqual([500]);
  });

  it("declares a bounded reading when either page fills its limit", async () => {
    // ADR-0367's `declares` arm. The waiting read is nearest-deadline-first, so a cut page drops
    // the requests furthest from their deadline — but a cut page is still a prefix and saying so is
    // the honest answer.
    const waiting = harness({ unanswered: [BREACHED, APPROACHING] });
    expect((await waiting.reconciler.auditDeadlines(2)).complete).toBe(false);
    expect((await harness({ unanswered: [BREACHED] }).reconciler.auditDeadlines(2)).complete).toBe(
      true,
    );
    // And on the other read alone, which a single counter could not express.
    const refusals = harness({ lateRefusals: [LATE_REFUSAL] });
    expect((await refusals.reconciler.auditDeadlines(1)).complete).toBe(false);
  });

  it("forwards an unreadable row from both reads and keeps assessing the rest", async () => {
    const h = harness({
      unanswered: [BREACHED],
      unansweredUnreadable: [{ requestId: "dreq_unreadable01", detail: "verificationMethod" }],
      lateRefusals: [LATE_REFUSAL],
      lateRefusalUnreadable: [{ requestId: null, detail: "request_id" }],
    });
    const page = await h.reconciler.auditDeadlines();
    expect(h.unreadable.map((u) => u.requestId)).toEqual(["dreq_unreadable01", null]);
    expect(page.findings).toHaveLength(2);
    // A row the contract refused was read and **not assessed**, so it sits outside this figure —
    // `auditTombstones`' rule for the same count (ADR-0371).
    expect(page.examined).toBe(2);
  });

  it("reports the horizon it used, and honours an override", async () => {
    const d = harness({ unanswered: [HEALTHY] });
    expect((await d.reconciler.auditDeadlines()).warningDays).toBe(DEFAULT_DEADLINE_WARNING_DAYS);
    // 24 days out, so a 30-day horizon makes the same request `approaching`.
    const wide = harness({ unanswered: [HEALTHY] }, { deadlineWarningDays: 30 });
    const page = await wide.reconciler.auditDeadlines();
    expect(page.warningDays).toBe(30);
    expect(page.findings[0]?.assessment.standing).toBe("approaching");
  });

  it("is disjoint from auditCompleted by status, so no finding is emitted twice", async () => {
    // The two passes share one reporter, and what keeps a finding from arriving twice is a property
    // of the queries rather than a filter either applies: `completedWithTombstone` selects
    // `completed` and neither of this pass's reads can return one.
    const h = harness({
      unanswered: [BREACHED],
      lateRefusals: [LATE_REFUSAL],
      completed: [
        requestOf({
          status: "completed",
          completedAt: "2026-10-30T00:00:00.000Z",
          completionSha256: PROOF,
          tombstoneId: TOMB,
        }),
      ],
      evidence: [tombstoneOf()],
    });
    await h.reconciler.auditDeadlines();
    await h.reconciler.auditCompleted();
    expect(h.findings).toHaveLength(3);
    expect(new Set(h.findings.map((f) => f.requestId)).size).toBe(3);
  });
});

describe("formatDeadlineFinding", () => {
  const assessOf = (
    standing: string,
    over: Partial<DeadlineFinding["assessment"]> = {},
  ): DeadlineFinding => ({
    requestId: REQ,
    tenantId: TENANT,
    tombstoneId: null,
    assessment: {
      standing: standing as DeadlineFinding["assessment"]["standing"],
      status: "verified",
      deadlineAt: "2026-10-28T00:00:00.000Z",
      answeredAt: null,
      msPastDeadline: 0,
      extendedAt: null,
      warningDays: DEFAULT_DEADLINE_WARNING_DAYS,
      ...over,
    },
  });

  it("renders every standing, so none falls through to a default nobody chose", () => {
    // It names no standing in its logic — it reads the declared facts — so this is the assertion
    // that a seventh standing gets a sentence from what it is obliged to declare.
    for (const standing of DEADLINE_STANDINGS) {
      const line = formatDeadlineFinding(
        assessOf(standing, standing === "answer_time_unstated" ? { msPastDeadline: null } : {}),
      );
      expect(line).toContain(REQ);
      expect(line.length).toBeGreaterThan(40);
    }
  });

  it("distinguishes a breach still running from one already answered", () => {
    const running = formatDeadlineFinding(
      assessOf("breached", { msPastDeadline: 5 * 86_400_000 }),
    );
    expect(running).toContain("5d past its Article 12(3) deadline and still unanswered");

    const answered = formatDeadlineFinding(
      assessOf("answered_late", {
        status: "rejected",
        answeredAt: "2026-11-02T00:00:00.000Z",
        msPastDeadline: 5 * 86_400_000,
      }),
    );
    expect(answered).toContain("answered the data subject 5d past");
  });

  it("says a deadline can still be met, which is the only actionable sentence", () => {
    expect(
      formatDeadlineFinding(assessOf("approaching", { msPastDeadline: -3 * 86_400_000 })),
    ).toContain("due in 3d and its Article 12(3) deadline can still be met");
  });

  it("says a record cannot state when it answered, rather than inventing a figure", () => {
    const line = formatDeadlineFinding(
      assessOf("answer_time_unstated", { status: "completed", msPastDeadline: null }),
    );
    expect(line).toContain("does not state when the data subject was answered");
    expect(line).not.toContain("NaN");
  });

  it("says a met deadline was met, and whether anybody was answered", () => {
    // Both standings that land in the last arm are `reported: false`, so this is reachable only
    // from a direct call — and "is within" is false of a request that has already been answered.
    expect(formatDeadlineFinding(assessOf("within_deadline", { msPastDeadline: -9 * 86_400_000 })))
      .toContain("is within its Article 12(3) deadline");
    expect(
      formatDeadlineFinding(
        assessOf("answered_in_time", {
          status: "completed",
          answeredAt: "2026-10-20T00:00:00.000Z",
          msPastDeadline: -8 * 86_400_000,
        }),
      ),
    ).toContain("answered the data subject within its Article 12(3) deadline");
  });

  it("names the extension, so a reader knows the deadline in force is not the original", () => {
    expect(
      formatDeadlineFinding(
        assessOf("breached", {
          msPastDeadline: 86_400_000,
          extendedAt: "2026-10-10T00:00:00.000Z",
        }),
      ),
    ).toContain("extended 2026-10-10T00:00:00.000Z");
  });

  it("carries no subject identifier, legal basis or note", () => {
    // ADR-0310's rule: a finding's notice carries the handle and the fact, never the record's
    // content. This line reaches a deployment log and an incident note.
    const line = formatDeadlineFinding(
      assessOf("breached", { msPastDeadline: 86_400_000 }),
    );
    expect(line).not.toContain("subject@example.test");
    expect(line).not.toContain("article_17");
  });
});

describe("auditTombstones", () => {
  it("names the three ways a tombstone is reached", () => {
    // Collapsing them would lose the one this direction was built for: `unreferenced` is a tombstone
    // no other audit can see, and `dangling` is a request row deleted out from under a proof.
    expect(TOMBSTONE_REFERENCE_STATES).toEqual(["unreferenced", "referenced", "dangling"]);
    expect(DEFAULT_TOMBSTONE_AUDIT_LIMIT).toBe(100);
  });

  it("reports no findings over a clean table, with a truthful examined count", async () => {
    const h = harness({ scan: [unreferencedTombstone(), tombstoneOf()] });
    const page = await h.reconciler.auditTombstones();
    // "We examined two and found nothing" is the claim an auditor needs, and it cannot be made from
    // the absence of a log line (ADR-0323).
    expect(page.findings).toEqual([]);
    expect(page.examined).toBe(2);
  });

  it("finds a tampered scope on a tombstone no request names", async () => {
    const h = harness({ scan: [tamper(unreferencedTombstone())] });
    const page = await h.reconciler.auditTombstones();
    expect(page.examined).toBe(1);
    expect(page.findings).toHaveLength(1);
    // Nothing else in the system looks at this row: both other directions start from a request, and
    // this one has none.
    expect(page.findings[0]?.reference).toBe("unreferenced");
    expect(page.findings[0]?.relatedDeletionRequestId).toBeNull();
    expect(page.findings[0]?.check.defects).toContain("scope_tampered");
    expect(page.findings[0]?.detail).toContain("does not verify");
  });

  it("proves the point: the tamper leaves the proof digest and the chain hash untouched", async () => {
    const tampered = tamper(unreferencedTombstone());
    const h = harness({ scan: [tampered] });
    const page = await h.reconciler.auditTombstones();
    expect(tampered.record.proofSha256).toBe(unreferencedTombstone().record.proofSha256);
    expect(tampered.chainEntryHash).toBe(CHAIN_HASH);
    expect(page.findings[0]?.check.defects).not.toContain("proof_mismatch");
  });

  it("finds a tombstone nothing in the chain witnesses", async () => {
    const honest = unreferencedTombstone();
    const h = harness({
      scan: [{ ...honest, chainEntryHash: null, chainSequenceNumber: null }],
    });
    const page = await h.reconciler.auditTombstones();
    expect(page.findings[0]?.check.defects).toEqual(["unwitnessed"]);
  });

  it("makes a dangling request reference its own finding, even on evidence that verifies", async () => {
    const h = harness({ scan: [tombstoneOf()], knownRequestIds: [] });
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toHaveLength(1);
    // Not "unreferenced": the proof names a request and the request is gone, which means a row was
    // deleted out from under it.
    expect(page.findings[0]?.reference).toBe("dangling");
    expect(page.findings[0]?.relatedDeletionRequestId).toBe(REQ);
    expect(page.findings[0]?.check.ok).toBe(true);
    expect(page.findings[0]?.detail).toContain("does not exist");
  });

  it("reports both defects when a dangling reference also fails verification", async () => {
    const h = harness({ scan: [tamperedTombstone()], knownRequestIds: [] });
    const finding = (await h.reconciler.auditTombstones()).findings[0];
    expect(finding?.reference).toBe("dangling");
    expect(finding?.detail).toContain("does not verify");
    expect(finding?.detail).toContain("does not exist");
  });

  it("says nothing about a referenced tombstone that verifies", async () => {
    const h = harness({ scan: [tombstoneOf()], knownRequestIds: [REQ] });
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toEqual([]);
    expect(page.examined).toBe(1);
  });

  it("still reports a referenced tombstone that does not verify", async () => {
    const h = harness({ scan: [tamperedTombstone()], knownRequestIds: [REQ] });
    const page = await h.reconciler.auditTombstones();
    // Not left to `auditCompleted`: that walks only `status = 'completed'` requests under its own
    // limit, so a tombstone whose request sits `in_progress` would fall through both directions.
    expect(page.findings).toHaveLength(1);
    expect(page.findings[0]?.reference).toBe("referenced");
  });

  it("spends at most one request lookup per row, and none on an unreferenced one", async () => {
    const h = harness({ scan: [unreferencedTombstone(), tombstoneOf()], knownRequestIds: [REQ] });
    await h.reconciler.auditTombstones();
    expect(h.requestReads).toEqual([REQ]);
  });

  it("hands back a cursor when the page is full, and the caller's next page skips it", async () => {
    const all = [
      unreferencedTombstone("tomb_aaaa0000aaaa"),
      unreferencedTombstone("tomb_bbbb0000bbbb"),
      unreferencedTombstone("tomb_cccc0000cccc"),
    ];
    const h = harness({ scan: all });
    const first = await h.reconciler.auditTombstones({ limit: 2 });
    expect(first.examined).toBe(2);
    expect(first.nextAfterTombstoneId).toBe("tomb_bbbb0000bbbb");
    const second = await h.reconciler.auditTombstones({
      limit: 2,
      afterTombstoneId: first.nextAfterTombstoneId,
    });
    // The second page re-reads nothing: a sweep that re-read or skipped a row would be an audit that
    // can miss the one tampered record.
    expect(second.examined).toBe(1);
    expect(second.nextAfterTombstoneId).toBeNull();
    expect(h.scanCalls).toEqual([
      { limit: 2, afterTombstoneId: null },
      { limit: 2, afterTombstoneId: "tomb_bbbb0000bbbb" },
    ]);
  });

  it("ends the sweep on a page shorter than the limit", async () => {
    const h = harness({ scan: [unreferencedTombstone()] });
    const page = await h.reconciler.auditTombstones({ limit: 10 });
    expect(page.examined).toBe(1);
    expect(page.nextAfterTombstoneId).toBeNull();
  });

  it("ends the sweep on an empty table without claiming anything was checked", async () => {
    const h = harness({ scan: [] });
    const page = await h.reconciler.auditTombstones();
    expect(page).toEqual({
      examined: 0,
      findings: [],
      unreadable: [],
      nextAfterTombstoneId: null,
    });
  });

  it("counts what it verified and not what it read, so a refusal is beside the figure", async () => {
    const h = harness({
      scanRows: [
        readableRow(unreferencedTombstone("tomb_aaaa0000aaaa")),
        refusedRow("tomb_bbbb0000bbbb"),
        readableRow(unreferencedTombstone("tomb_cccc0000cccc")),
      ],
    });
    const page = await h.reconciler.auditTombstones();
    // `3` would claim an examination that did not occur: a row the contract refused was read and
    // not verified, so it sits beside this figure rather than inside it (ADR-0371).
    expect(page.examined).toBe(2);
    expect(page.unreadable).toHaveLength(1);
    expect(page.unreadable[0]?.identity).toBe("tomb_bbbb0000bbbb");
  });

  it("is not a clean sweep when the findings are empty and a row could not be read", async () => {
    const h = harness({
      scanRows: [readableRow(unreferencedTombstone("tomb_aaaa0000aaaa")), refusedRow("tomb_zzzz")],
    });
    const page = await h.reconciler.auditTombstones();
    // The pair is the claim, so it is asserted as a pair: "nothing wrong in what I could read" is a
    // different statement from "nothing wrong", and the second is the one an auditor is owed.
    expect({ findings: page.findings, unreadable: page.unreadable }).toEqual({
      findings: [],
      unreadable: [{ identity: "tomb_zzzz", detail: "approvedBy: custom" }],
    });
  });

  it("is a clean sweep when every row read and nothing was wrong", async () => {
    const h = harness({ scan: [unreferencedTombstone("tomb_aaaa0000aaaa")] });
    const page = await h.reconciler.auditTombstones();
    expect({ findings: page.findings, unreadable: page.unreadable }).toEqual({
      findings: [],
      unreadable: [],
    });
  });

  it("continues the lap past a refused last row, cursored on that row's own id", async () => {
    const h = harness({
      scanRows: [
        readableRow(unreferencedTombstone("tomb_aaaa0000aaaa")),
        refusedRow("tomb_bbbb0000bbbb"),
      ],
    });
    const first = await h.reconciler.auditTombstones({ limit: 2 });
    // The records reach only `tomb_aaaa…`, so a cursor derived from them would ask again from
    // before the refused row and read it on every page for ever. A null here would be worse: the
    // lap would end at a full page and every row behind it would go unverified.
    expect(first.nextAfterTombstoneId).toBe("tomb_bbbb0000bbbb");
    expect(first.examined).toBe(1);
    const second = await h.reconciler.auditTombstones({
      limit: 2,
      afterTombstoneId: first.nextAfterTombstoneId,
    });
    expect(second.examined).toBe(0);
    expect(second.unreadable).toEqual([]);
    expect(second.nextAfterTombstoneId).toBeNull();
  });

  it("ends the lap on a short page, refused last row or not", async () => {
    const h = harness({
      scanRows: [
        readableRow(unreferencedTombstone("tomb_aaaa0000aaaa")),
        refusedRow("tomb_bbbb0000bbbb"),
      ],
    });
    const page = await h.reconciler.auditTombstones({ limit: 10 });
    // Fewer rows came back than were asked for, which is the end of the table — and the refusal
    // does not change that, because the figure the cursor turns on is rows and not records.
    expect(page.nextAfterTombstoneId).toBeNull();
    expect(page.unreadable).toHaveLength(1);
  });

  it("keeps a refused row out of the findings and out of every finding's fields", async () => {
    const h = harness({
      scanRows: [refusedRow("tomb_refused0001"), readableRow(tamper(unreferencedTombstone()))],
    });
    const page = await h.reconciler.auditTombstones();
    // A `TombstoneAudit` carries a `verifyStoredEvidence` result and a reference state, and neither
    // can be computed for a row nobody could represent — so it cannot be one, and reporting it as
    // `unverified` would claim an examination that never happened.
    expect(page.findings).toHaveLength(1);
    expect(page.findings[0]?.tombstoneId).toBe("tomb_unref0001aaaa");
    expect(JSON.stringify(page.findings)).not.toContain("tomb_refused0001");
    expect(page.unreadable.map((r) => r.identity)).toEqual(["tomb_refused0001"]);
  });

  it("clamps the page size to the store's cap, so a short page is not misread as the end", async () => {
    const h = harness({ scan: [] });
    await h.reconciler.auditTombstones({ limit: 100_000 });
    // Asking for more than the store will serve would yield a short page, and a short page is how
    // this reports the end of the table.
    expect(h.scanCalls[0]?.limit).toBe(TOMBSTONE_SCAN_MAX_LIMIT);
    await h.reconciler.auditTombstones({ limit: 0 });
    expect(h.scanCalls[1]?.limit).toBe(1);
  });

  it("asks for the default page size when the caller says nothing", async () => {
    const h = harness({ scan: [] });
    await h.reconciler.auditTombstones();
    expect(h.scanCalls).toEqual([
      { limit: DEFAULT_TOMBSTONE_AUDIT_LIMIT, afterTombstoneId: null },
    ]);
  });

  it("never transitions a request, whatever it finds", async () => {
    const h = harness({ scan: [tamperedTombstone()], knownRequestIds: [REQ] });
    await h.reconciler.auditTombstones();
    expect(h.transitions).toEqual([]);
    expect(h.retired).toEqual([]);
  });
});

describe("tombstoneStanding", () => {
  it("passes a tombstone that verifies and whose reference resolves", () => {
    const standing = tombstoneStanding("referenced", REQ, verifyStoredEvidence(tombstoneOf()));
    // null detail, not an empty string: there is nothing to say about a row that stands up, and the
    // discriminated union is what lets a caller rely on that.
    expect(standing).toEqual({ ok: true, detail: null });
  });

  it("passes an unreferenced tombstone, which is the majority of the table", () => {
    const check = verifyStoredEvidence(unreferencedTombstone());
    expect(tombstoneStanding("unreferenced", null, check).ok).toBe(true);
  });

  it("fails a dangling reference even on evidence that verifies", () => {
    const check = verifyStoredEvidence(tombstoneOf());
    const standing = tombstoneStanding("dangling", REQ, check);
    // A dangling reference is not an `EvidenceDefect` — the proof is intact and the row it names is
    // gone — but it is still a finding, because no other direction of the audit can see it.
    expect(check.ok).toBe(true);
    expect(standing.ok).toBe(false);
    expect(standing.detail).toContain("does not exist");
  });

  it("says both things when a row fails both ways", () => {
    const standing = tombstoneStanding("dangling", REQ, verifyStoredEvidence(tamperedTombstone()));
    expect(standing.detail).toContain("does not verify");
    expect(standing.detail).toContain("does not exist");
  });
});

describe("verifyTombstone", () => {
  it("names the three answers, and keeps absent as one of them", () => {
    // Three, not two: a proof that has been deleted is neither verified nor unverified, and folding
    // it into either would let a caller close an episode because the row stopped being able to fail.
    expect(TOMBSTONE_VERIFICATION_OUTCOMES).toEqual(["absent", "verified", "unverified"]);
  });

  it("answers absent for a tombstone that is not there", async () => {
    const h = harness({ storedMissing: true });
    const v = await h.reconciler.verifyTombstone(TOMB);
    expect(v.outcome).toBe("absent");
    // Nothing to classify and nothing to check — and a caller that read a null `check` as "no
    // defects" would be closing an episode over a missing Article 17 proof.
    expect(v.check).toBeNull();
    expect(v.reference).toBeNull();
    expect(v.tenantId).toBeNull();
    expect(v.tombstoneId).toBe(TOMB);
    expect(v.detail).toContain("is stored");
  });

  it("verifies a referenced tombstone that stands up, and names its reference", async () => {
    const h = harness({ evidence: [tombstoneOf()], knownRequestIds: [REQ] });
    const v = await h.reconciler.verifyTombstone(TOMB);
    expect(v.outcome).toBe("verified");
    // The reference is carried rather than left to the caller: a referenced tombstone's episode is
    // keyed on the request and an unreferenced one's on the tombstone (ADR-0328), so a caller that
    // guessed would close the wrong episode.
    expect(v.reference).toBe("referenced");
    expect(v.relatedDeletionRequestId).toBe(REQ);
    expect(v.tenantId).toBe(TENANT);
    expect(v.detail).toBeNull();
  });

  it("verifies an unreferenced tombstone — the class the sweep exists for", async () => {
    const unref = unreferencedTombstone();
    const h = harness({ evidence: [unref] });
    const v = await h.reconciler.verifyTombstone(unref.record.id);
    expect(v.outcome).toBe("verified");
    expect(v.reference).toBe("unreferenced");
    expect(v.relatedDeletionRequestId).toBeNull();
  });

  it("reports a tampered scope as unverified, with the defect that says so", async () => {
    const h = harness({ evidence: [tamperedTombstone()], knownRequestIds: [REQ] });
    const v = await h.reconciler.verifyTombstone(TOMB);
    expect(v.outcome).toBe("unverified");
    expect(v.check?.defects).toContain("scope_tampered");
    expect(v.detail).toContain("does not verify");
  });

  it("reports a tombstone nothing in the chain witnesses as unverified", async () => {
    const honest = tombstoneOf();
    const h = harness({
      evidence: [{ ...honest, chainEntryHash: null, chainSequenceNumber: null }],
      knownRequestIds: [REQ],
    });
    const v = await h.reconciler.verifyTombstone(TOMB);
    expect(v.outcome).toBe("unverified");
    expect(v.check?.defects).toEqual(["unwitnessed"]);
  });

  it("will not call a dangling tombstone verified, however intact its proof", async () => {
    const h = harness({ evidence: [tombstoneOf()], knownRequestIds: [] });
    const v = await h.reconciler.verifyTombstone(TOMB);
    // This is the case a caller must not be allowed to close on: the hashes are perfect and the
    // request row the proof names has been deleted, which is a finding the sweep raised and nothing
    // here has resolved.
    expect(v.check?.ok).toBe(true);
    expect(v.outcome).toBe("unverified");
    expect(v.reference).toBe("dangling");
    expect(v.detail).toContain("does not exist");
  });

  it("spends no request lookup on an unreferenced row", async () => {
    const unref = unreferencedTombstone();
    const h = harness({ evidence: [unref] });
    await h.reconciler.verifyTombstone(unref.record.id);
    expect(h.requestReads).toEqual([]);
  });

  it("agrees with the sweep on the same row, in both directions", async () => {
    const clean = harness({ scan: [tombstoneOf()], evidence: [tombstoneOf()], knownRequestIds: [REQ] });
    expect((await clean.reconciler.auditTombstones()).findings).toEqual([]);
    expect((await clean.reconciler.verifyTombstone(TOMB)).outcome).toBe("verified");

    const dirty = harness({
      scan: [tamperedTombstone()],
      evidence: [tamperedTombstone()],
      knownRequestIds: [REQ],
    });
    const swept = await dirty.reconciler.auditTombstones();
    const asked = await dirty.reconciler.verifyTombstone(TOMB);
    // One rule, read twice. A targeted check stricter than the sweep would never close an episode the
    // sweep opened; a laxer one would close an episode whose finding still stands.
    expect(swept.findings[0]?.detail).toBe(asked.detail);
    expect(asked.outcome).toBe("unverified");
  });

  it("never transitions a request or retires a tenant, whatever it answers", async () => {
    const h = harness({ evidence: [tamperedTombstone()], knownRequestIds: [] });
    await h.reconciler.verifyTombstone(TOMB);
    await h.reconciler.verifyTombstone("tomb_nothinghere00");
    expect(h.transitions).toEqual([]);
    expect(h.retired).toEqual([]);
  });
});

/**
 * The no-writes invariant, pinned against the real stores over a fake connection rather than against
 * the fakes above — the fakes could not write even if the code asked them to, so only this says
 * anything. ADR-0323 established that `evidence_unverified` is a verdict nothing may apply, not a
 * scheduler and not an operator; a sweep that found a tampered scope has even less standing, because
 * it starts from no request and so has nothing whose status it could be right about.
 */
describe("auditTombstones writes nothing", () => {
  const ANCHORER: TombstoneAnchorer = {
    appendWithin: async () => {
      throw new Error("a read-only audit must never append to the chain");
    },
  };

  function tombstoneRow(stored: StoredTombstone): Record<string, unknown> {
    const r = stored.record;
    return {
      tombstone_id: r.id,
      kind: r.kind,
      tenant_id: r.tenantId,
      subject_identifier: r.subjectIdentifier ?? null,
      related_deletion_request_id: r.relatedDeletionRequestId ?? null,
      deleted_at: r.deletedAt,
      executed_by: r.executedBy,
      approved_by: r.approvedBy,
      scope: JSON.stringify(r.scope),
      content_manifest_sha256: r.contentManifestSha256,
      proof_sha256: r.proofSha256,
      anchors: JSON.stringify(r.anchors),
      retained_reason: r.retainedReason ?? null,
      retained_data_reference: r.retainedDataReference ?? null,
      invalidation_of_prior_tombstone_id: null,
      attestations: JSON.stringify(stored.attestations),
      // ADR-0329, and the reason this fake carries them: the proof version selects the domain tag
      // the content manifest was hashed under, so a row that drops it reads a v2 record back as v1,
      // recomputes the v1 digest, and `verifyStoredEvidence` reports `scope_tampered` on an honest
      // proof. The sweep would then escalate a `sev1` about a falsified Article 17 proof that was
      // never falsified — which is precisely what these three tests caught when the columns landed.
      proof_version: r.proofVersion,
      capability_declaration:
        r.capabilityDeclaration === undefined ? null : JSON.stringify(r.capabilityDeclaration),
      // ADR-0331, and the same trap: a v3 row that drops its obligations gets no manifest subject,
      // so `verifyStoredEvidence` reports `scope_tampered` on an honest proof and the sweep
      // escalates a `sev1` about a falsified Article 17 proof that was never falsified.
      retained_obligations:
        r.retainedObligations === undefined ? null : JSON.stringify(r.retainedObligations),
      // ADR-0351, and the same trap once more with no column default behind it: `proof_version`
      // defaults to `'v1'`, which is the honest reading of a row written before that column, and a
      // record-storage declaration has no such reading. A row that drops this one is a v4 label
      // with nothing to hash, so the sweep would escalate a `sev1` about a falsified Article 17
      // proof that was never falsified.
      record_storage: r.recordStorage === undefined ? null : JSON.stringify(r.recordStorage),
      chain_entry_hash: stored.chainEntryHash,
      chain_sequence_number: stored.chainSequenceNumber,
    };
  }

  function requestRow(request: GdprDeletionRequest): Record<string, unknown> {
    return {
      request_id: request.id,
      tenant_id: request.tenantId,
      subject_identifier: request.subjectIdentifier,
      legal_basis: request.legalBasis,
      status: request.status,
      submitted_at: request.submittedAt,
      submitted_by: request.submittedBy,
      deadline_at: request.deadlineAt,
      verification_method: request.verificationMethod,
      verified_at: request.verifiedAt,
      verified_by: request.verifiedBy,
      in_progress_at: request.inProgressAt,
      completed_at: request.completedAt,
      completion_sha256: request.completionSha256,
      rejected_at: request.rejectedAt,
      rejected_reason: null,
      deferred_until: request.deferredUntil,
      deferral_reason: null,
      retention_obligations: JSON.stringify(request.retentionObligations),
      retained_data_categories: JSON.stringify(request.retainedDataCategories),
      notes: null,
      tombstone_id: request.tombstoneId,
    };
  }

  function realHarness(
    scan: readonly StoredTombstone[],
    requestsFound: readonly GdprDeletionRequest[],
    /**
     * Columns written over whatever `tombstoneRow` derived, for a row no `StoredTombstone` can
     * describe: `attestations: "{}"` is storable (`JSONB NOT NULL` with no array CHECK) and the
     * mapper is the only thing that can answer for it, so the fixture has to be the row.
     */
    rowOverride: Record<string, unknown> = {},
  ): { readonly reconciler: DeletionReconciler; readonly sql: () => string[] } {
    const sql: string[] = [];
    const conn = {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes(`FROM meta.tenant_tombstones`)) {
          return {
            rows: scan.map((s) => ({ ...tombstoneRow(s), ...rowOverride })),
            rowCount: scan.length,
          };
        }
        if (statement.includes(`FROM meta.gdpr_deletion_requests`)) {
          return { rows: requestsFound.map((r) => requestRow(r)), rowCount: requestsFound.length };
        }
        return { rows: [], rowCount: 0 };
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
        sql.push("BEGIN");
        const out = await fn(conn as unknown as PgConnection);
        sql.push("COMMIT");
        return out;
      },
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
      close: async (): Promise<undefined> => undefined,
    };
    const pg = conn as unknown as PgConnection;
    return {
      reconciler: new DeletionReconciler({
        requests: new PostgresDeletionRequestStore(pg),
        tombstones: new PostgresTombstoneStore(pg, ANCHORER),
        clock: () => new Date(NOW),
        // This harness exists to prove the sweep writes nothing, so a reported row has nowhere to
        // go here — and it must not be a *write*, which is exactly what the assertion below checks.
        onUnreadableRequest: () => undefined,
        onDeadlineFinding: () => undefined,
      }),
      sql: () => sql,
    };
  }

  const MUTATING = /^\s*(UPDATE|INSERT|DELETE|TRUNCATE|DROP|ALTER)\b/i;

  it("records no mutating statement over a clean table", async () => {
    const h = realHarness([unreferencedTombstone()], []);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toEqual([]);
    expect(page.examined).toBe(1);
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("records no mutating statement when it finds a tampered scope", async () => {
    const h = realHarness([tamper(unreferencedTombstone())], []);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings[0]?.check.defects).toContain("scope_tampered");
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("records no mutating statement when it finds a dangling reference", async () => {
    const h = realHarness([tombstoneOf()], []);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings[0]?.reference).toBe("dangling");
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("reports a destroyed evidence column as a finding, through the real mapper", async () => {
    // The thesis end to end, and on the one reader that does not start from something already
    // naming a tombstone (ADR-0327): a row the sweep cannot read is what the sweep exists to find,
    // so it is routed into the finding set rather than out of the answer. Before this it came back
    // examined, clean and silent — the same page as an honest proof written with no evidence.
    const h = realHarness([unreferencedTombstone()], [], { attestations: "{}" });
    const page = await h.reconciler.auditTombstones();
    expect(page.examined).toBe(1);
    expect(page.findings).toHaveLength(1);
    expect(page.findings[0]?.check.defects).toEqual(["attestations_unreadable"]);
    expect(page.findings[0]?.detail).toContain("attestations_unreadable");
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("still reports an honest no-evidence row as clean, through the same mapper", async () => {
    // The negative control the one above needs: `'[]'` is what `write(record)` and the column
    // default both produce, so a sweep that flagged it would report every such proof as falsified
    // and escalate a `sev1` over it (ADR-0324) — the direction this whole family is wrong in.
    const h = realHarness([unreferencedTombstone()], [], { attestations: "[]" });
    const page = await h.reconciler.auditTombstones();
    expect(page.examined).toBe(1);
    expect(page.findings).toEqual([]);
  });

  it("reads the table under the platform grant and keyset-ordered", async () => {
    const h = realHarness([], []);
    await h.reconciler.auditTombstones({ limit: 10 });
    const statements = h.sql();
    expect(statements.some((s) => s.includes("set_config('app.platform_audit', 'on', true)"))).toBe(
      true,
    );
    const select = statements.find((s) => s.includes("FROM meta.tenant_tombstones"));
    expect(select).toContain("ORDER BY tombstone_id");
    for (const column of TOMBSTONE_COLUMNS) expect(select).toContain(column);
  });

  it("records no mutating statement for a targeted verification either", async () => {
    const h = realHarness([tamper(unreferencedTombstone())], []);
    const v = await h.reconciler.verifyTombstone("tomb_unref0001aaaa");
    expect(v.outcome).toBe("unverified");
    // A lookup by id has even *less* standing to act than the sweep: the caller chose the row, so a
    // write here would be a verdict applied on request (ADR-0323).
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("asks for the one row by id, under the same platform grant its siblings use", async () => {
    const h = realHarness([tombstoneOf()], [requestOf()]);
    expect((await h.reconciler.verifyTombstone(TOMB)).outcome).toBe("verified");
    const statements = h.sql();
    expect(statements.some((s) => s.includes("set_config('app.platform_audit', 'on', true)"))).toBe(
      true,
    );
    const select = statements.find((s) => s.includes("FROM meta.tenant_tombstones"));
    // By id, not a scan: a tombstone outlives its tenant, so there is no tenant session left to
    // satisfy the isolation policy and nothing narrower than the grant can read it.
    expect(select).toContain("WHERE tombstone_id = $1");
  });

  it("resolves a referenced tombstone through the real request store", async () => {
    const h = realHarness([tombstoneOf()], [requestOf()]);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toEqual([]);
    const select = h.sql().find((s) => s.includes("FROM meta.gdpr_deletion_requests"));
    expect(select).toContain("WHERE request_id = $1");
    for (const column of REQUEST_COLUMNS) expect(select).toContain(column);
  });
});
