import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import type { ChainCheckpoint } from "@crossengin/forensics";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  keyStoreChainSigner,
  type ChainSigner,
  type ChainTail,
  type CheckpointScanOptions,
  type CheckpointScanOutcome,
} from "@crossengin/forensics-pg";
import type { PgConnection, PgQueryResult, RowRead } from "@crossengin/kernel-pg";
import { assertBindArity } from "@crossengin/testing";

import { auditAnchors, type AnchorAuditReport } from "./anchor-audit.js";
import type { ChainFullReason, ChainVerificationReport } from "./chain-verify.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import {
  buildCheckpointLifecycle,
  configScopes,
  loadCheckpointConfig,
  parseCheckpointConfig,
  tenantSourceScopes,
  CheckpointScheduler,
  CHECKPOINT_PASS_OUTCOMES,
} from "./checkpoint-scheduler.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TENANT_POISON = "33333333-3333-3333-3333-333333333333";
const AT = "2026-06-01T00:00:00.000Z";

const CHECKPOINTS = "forensic_chain_checkpoints";
const CRYPTO_KEYS = "crypto_keys";

function paramIndex(sql: string, re: RegExp): number {
  const m = re.exec(sql);
  return m === null ? Number.NaN : Number(m[1]) - 1;
}

/**
 * A row identity the fake has to mint because the real table defaults it: `id` is not in the
 * `INSERT`'s column list, and `scanCheckpoints` keysets on `(sequence_number, id)` because
 * `UNIQUE (tenant_id, sequence_number)` does not constrain the platform scope (ADR-0371). Shaped
 * like a uuidv7 and **lexicographically ordered by insertion**, which is the one property the scan's
 * tiebreaker depends on — a random uuid here would make the two-rows-at-one-sequence case answer
 * differently from run to run.
 */
function fakeCheckpointId(n: number): string {
  return `00000000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
}

/**
 * Inline fake of `meta.forensic_chain_entries`, `meta.forensic_chain_checkpoints` and the one
 * `meta.crypto_keys` lookup a signature check makes, with RLS-like per-transaction tenant scoping
 * (mirrors forensics-pg's private test fake, which isn't exported).
 *
 * `failTenant` makes every read for that scope throw, to exercise per-scope error isolation.
 * `keyRow` is the registry row `getByFingerprint` resolves to — omit it and the chain's signing
 * fingerprint is unresolvable, which is how an unregistered key is reproduced.
 * `rawCheckpoints` are pushed in as they stand, which is the only way to put a row on disk that the
 * contract refuses: `record` begins `ChainCheckpointSchema.parse`, so no write this binary performs
 * can produce one, and a tenant-context `UPDATE` is what produces one live (ADR-0374).
 */
function fakeChainPg(
  opts: {
    readonly failTenant?: string;
    readonly keyRow?: Record<string, unknown>;
    readonly rawCheckpoints?: readonly Record<string, unknown>[];
  } = {},
): PgConnection {
  const entryRows: Record<string, unknown>[] = [];
  const checkpointRows: Record<string, unknown>[] = [...(opts.rawCheckpoints ?? [])];
  let nextCheckpointId = checkpointRows.length;

  /**
   * **The whole disjunction the store writes**, both arms and the operator on each, rather than a
   * probe for a `>` anywhere. Two reasons. The disjunction is the form the index can serve each arm
   * of (ADR-0371's `scopeFilter` argument, one level across), so a scan rewritten to the row
   * comparison `(sequence_number, id) > ($a, $b)` stops being paged here and the shape change is
   * loud instead of silent. And the `id` arm's operator is **read rather than assumed**, which is
   * what keeps the fake modelling the statement instead of the statement its author meant: a fake
   * implementing `>` for a predicate spelling `>=` would hide the re-read of the cursor's own row
   * that the difference causes, and a fake answering a statement it could not really serve is a test
   * asserting the wrong thing (ADR-0363).
   */
  const CHECKPOINT_KEYSET_RE =
    /\(sequence_number > \$(\d+)::bigint\s*OR \(sequence_number = \$\1::bigint AND id (>=?) \$(\d+)::uuid\)\)/;

  /**
   * Every read `PostgresChainCheckpointStore` issues, served off one model of the table: `latest`
   * and `listRecent` (descending), `getBySequence` (one sequence) and `scanCheckpoints` (ascending
   * with an optional `(sequence_number, id)` keyset).
   */
  function servedCheckpoints(
    sql: string,
    p: readonly unknown[],
    currentTenant: string | null,
  ): PgQueryResult {
    let visible = checkpointRows.filter((r) => (r["tenant_id"] ?? null) === currentTenant);

    const keyset = CHECKPOINT_KEYSET_RE.exec(sql);
    if (keyset === null && /sequence_number > \$|id >=? \$/.test(sql)) {
      throw new Error(
        `a keyset this fake cannot page: it is neither the disjunction the store writes nor a ` +
          `shape with no cursor at all — ${sql.replace(/\s+/g, " ").trim()}`,
      );
    }
    if (keyset !== null) {
      // `BIGINT` comes back from node-postgres as a string, so the cursor's sequence is carried as
      // the raw string and bound with a `::bigint` cast. Compared numerically here, which is what
      // Postgres does with it.
      const afterSeq = Number(p[Number(keyset[1]) - 1]);
      const afterId = String(p[Number(keyset[3]) - 1]);
      const idStrict = keyset[2] === ">";
      visible = visible.filter((r) => {
        const seq = Number(r["sequence_number"]);
        const id = String(r["id"]);
        return seq > afterSeq || (seq === afterSeq && (idStrict ? id > afterId : id >= afterId));
      });
    } else {
      const eqIdx = paramIndex(sql, /sequence_number = \$(\d+)/);
      if (!Number.isNaN(eqIdx)) {
        const val = Number(p[eqIdx]);
        visible = visible.filter((r) => Number(r["sequence_number"]) === val);
      }
    }

    const desc = sql.includes("ORDER BY sequence_number DESC");
    visible = [...visible].sort((a, b) => {
      const bySeq = Number(a["sequence_number"]) - Number(b["sequence_number"]);
      const ordered = bySeq !== 0 ? bySeq : String(a["id"]).localeCompare(String(b["id"]));
      return ordered * (desc ? -1 : 1);
    });

    const limitIdx = paramIndex(sql, /LIMIT \$(\d+)/);
    if (!Number.isNaN(limitIdx)) {
      visible = visible.slice(0, Number(p[limitIdx]));
    } else if (/LIMIT 1\b/.test(sql)) {
      visible = visible.slice(0, 1);
    }
    return { rows: visible, rowCount: visible.length };
  }

  function makeClient(): PgConnection {
    let currentTenant: string | null = null;

    const query = async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      const p = params ?? [];
      // The one thing interpreting SQL cannot answer: whether the statement references exactly the
      // parameters it binds. Postgres decides that in the bind step, before the planner, so a fake
      // that serves rows from a model of the table is otherwise answering statements no server would
      // have accepted (ADR-0370).
      assertBindArity(sql, params);
      if (sql.includes("set_config")) {
        currentTenant = (p[0] as string | null) ?? null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO")) {
        if (sql.includes(CHECKPOINTS)) {
          const tenant = (p[0] as string | null) ?? null;
          const seq = Number(p[1]);
          const exists = checkpointRows.some(
            (r) => (r["tenant_id"] ?? null) === tenant && Number(r["sequence_number"]) === seq,
          );
          if (!exists) {
            nextCheckpointId += 1;
            checkpointRows.push({
              id: fakeCheckpointId(nextCheckpointId),
              tenant_id: p[0] ?? null,
              sequence_number: p[1],
              root_hash: p[2],
              checkpointed_at: p[3],
              checkpointed_by: p[4],
              external_anchor_reference: p[5] ?? null,
              algorithm: p[6],
              provenance: p[7] ?? null,
            });
          }
          return { rows: [], rowCount: exists ? 0 : 1 };
        }
        entryRows.push({
          tenant_id: p[0] ?? null,
          sequence_number: p[1],
          kind: p[2],
          recorded_at: p[3],
          actor_reference: p[4],
          payload_sha256: p[5],
          payload_size_bytes: p[6],
          prior_entry_hash: p[7],
          entry_hash: p[8],
          signing_key_fingerprint: p[9],
          signature: p[10],
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT")) {
        if (opts.failTenant !== undefined && currentTenant === opts.failTenant) {
          throw new Error(`read failure for scope ${currentTenant}`);
        }
        if (sql.includes(CRYPTO_KEYS)) {
          // `getByFingerprint(fingerprint, scope)`: matched on `$1` alone, because the chain's
          // signing key is platform-scoped and both arms of the registry's inclusive scope filter
          // admit it.
          const row = opts.keyRow;
          const hit = row !== undefined && row["fingerprint_sha256"] === p[0];
          return { rows: hit && row !== undefined ? [row] : [], rowCount: hit ? 1 : 0 };
        }
        // The checkpoints table gets its own branch, ahead of the generic one, because the generic
        // one would **mis-serve** `scanCheckpoints`: its `/sequence_number = \$(\d+)/` probe matches
        // the `=` arm of the keyset disjunction, so the page would come back narrowed to one
        // sequence. A fake that answers a statement it could not really serve is a test asserting
        // the wrong thing (ADR-0363).
        if (sql.includes(CHECKPOINTS)) {
          return servedCheckpoints(sql, p, currentTenant);
        }
        // Entries only, now that the checkpoints table is served above. There is deliberately no
        // `sequence_number = $n` arm here: the only reader of that form in either store is
        // `getBySequence`, which is a checkpoint read, so an arm for it would be one that cannot
        // fire and would read as coverage it does not provide.
        let visible = entryRows.filter((r) => (r["tenant_id"] ?? null) === currentTenant);

        const geIdx = paramIndex(sql, /sequence_number >= \$(\d+)/);
        if (!Number.isNaN(geIdx)) {
          const min = Number(p[geIdx]);
          visible = visible.filter((r) => Number(r["sequence_number"]) >= min);
        }

        const desc = sql.includes("ORDER BY sequence_number DESC");
        visible = [...visible].sort(
          (a, b) => (Number(a["sequence_number"]) - Number(b["sequence_number"])) * (desc ? -1 : 1),
        );

        const limitIdx = paramIndex(sql, /LIMIT \$(\d+)/);
        if (!Number.isNaN(limitIdx)) {
          visible = visible.slice(0, Number(p[limitIdx]));
        } else if (/LIMIT 1\b/.test(sql)) {
          visible = visible.slice(0, 1);
        }
        return { rows: visible, rowCount: visible.length };
      }
      // Not `{rows: []}`: an empty answer for a statement this fake does not model would make every
      // assertion about what that statement *found* pass vacuously, which is this convention's own
      // blind spot turned on the fake (ADR-0350).
      throw new Error(`fakeChainPg cannot serve: ${sql.replace(/\s+/g, " ").trim()}`);
    };

    return {
      query: query as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(makeClient())) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
  }

  return makeClient();
}

interface ChainFixture {
  readonly conn: PgConnection;
  readonly signer: ChainSigner;
  readonly registry: PostgresKeyRegistry;
  readonly checkpointStore: PostgresChainCheckpointStore;
}

/** The id space seeded rows take, kept clear of the one the fake's `INSERT` mints from. */
function seededCheckpointId(sequenceNumber: number): string {
  return `00000000-0000-7000-9000-${sequenceNumber.toString().padStart(12, "0")}`;
}

/**
 * A stored checkpoint row as the table holds one, for the cases that need a row on disk the contract
 * refuses — `record` parses its input, so nothing this binary writes can produce one.
 */
function checkpointRow(
  tenantId: string | null,
  sequenceNumber: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: seededCheckpointId(sequenceNumber),
    tenant_id: tenantId,
    sequence_number: sequenceNumber,
    root_hash: "a".repeat(64),
    checkpointed_at: AT,
    checkpointed_by: "operate-server",
    external_anchor_reference: null,
    algorithm: "sha256",
    provenance: "verified_full",
    ...overrides,
  };
}

/**
 * The measured tamper, which is also the cheapest row to make: `checkpointedBy` is
 * `z.string().min(1)`, so `''` is refused by the contract and admitted by the column, and one
 * `UPDATE` under a tenant's own context writes it — that table's isolation arm is `ALL`-scope, so
 * its `USING` doubles as its `WITH CHECK` (ADR-0374, verified live as the non-owner `serving` role).
 */
function refusedCheckpointRow(
  tenantId: string | null,
  sequenceNumber: number,
): Record<string, unknown> {
  return checkpointRow(tenantId, sequenceNumber, { checkpointed_by: "" });
}

/**
 * A checkpoint store that says what reached it and can misbehave on demand: the `record` calls it
 * took, a note on the shared `trace` each time it was scanned, and a scan that throws or that
 * reports the ceiling stopped it.
 *
 * `recorded` is the assertion `latest()` cannot give, and the distinction still matters now that the
 * pass anchors over a finding instead of withholding: a fresh anchor at the tail is a row the store
 * accepts and the contract reads back perfectly, so `latest()` answers with the *new* row and
 * `expect(...).toBeNull()` would be asserting nothing. The question is whether the write was made.
 *
 * `trace` is what makes the audit's **position** assertable rather than only its presence — shared
 * with `TracingChainLogStore`, so the order of the two calls is read off one list instead of
 * inferred from what each of them found.
 *
 * A subclass rather than a stand-in object, because `CheckpointSchedulerOptions.checkpointStore` is
 * the concrete class: this keeps the real `record` (and its `ChainCheckpointSchema.parse`) and the
 * real scan on the path, so a test asserting "nothing was recorded" cannot pass because a fake
 * accepted something the real store would refuse.
 */
class ObservedCheckpointStore extends PostgresChainCheckpointStore {
  readonly recorded: Array<{
    readonly scope: string | null;
    readonly checkpoint: ChainCheckpoint;
  }> = [];

  constructor(
    conn: PgConnection,
    private readonly behaviour: {
      readonly scanThrows?: boolean;
      readonly scanIncomplete?: boolean;
      readonly trace?: string[];
    } = {},
  ) {
    super(conn, {});
  }

  override async record(tenantId: string | null, checkpoint: ChainCheckpoint): Promise<void> {
    this.recorded.push({ scope: tenantId, checkpoint });
    await super.record(tenantId, checkpoint);
  }

  override async scanCheckpoints(
    tenantId: string | null,
    onPage: (page: RowRead<ChainCheckpoint>) => void,
    opts: CheckpointScanOptions = {},
  ): Promise<CheckpointScanOutcome> {
    this.behaviour.trace?.push("scan");
    if (this.behaviour.scanThrows === true) throw new Error("checkpoint scan unavailable");
    const outcome = await super.scanCheckpoints(tenantId, onPage, opts);
    return this.behaviour.scanIncomplete === true ? { ...outcome, complete: false } : outcome;
  }
}

/** The other half of the order trace; `tail` is the call the audit has to precede. */
class TracingChainLogStore extends PostgresChainLogStore {
  constructor(
    conn: PgConnection,
    signer: ChainSigner,
    private readonly trace: string[],
  ) {
    super(conn, signer, {});
  }

  override async tail(tenantId: string | null): Promise<ChainTail | null> {
    this.trace.push("tail");
    return super.tail(tenantId);
  }
}

/**
 * A fake chain connection, the signer that writes into it, and a real `PostgresKeyRegistry` that
 * resolves that signer's fingerprint — so the verification `buildCheckpointLifecycle` composes is
 * the real `verifyChainFromCheckpoint` over real entries rather than a stub.
 *
 * `unregisteredKey` withholds the registry row, which is the shape of a live deployment whose chain
 * signing key was never registered: every signature is unresolvable and the pass must refuse.
 */
async function newChainFixture(
  opts: {
    readonly failTenant?: string;
    readonly unregisteredKey?: boolean;
    readonly rawCheckpoints?: readonly Record<string, unknown>[];
  } = {},
): Promise<ChainFixture> {
  const keyStore = new InMemoryKeyStore();
  const record = await keyStore.createKey({
    tenantId: null,
    algorithm: "ed25519",
    purpose: "evidence_sealing",
  });
  if (record.publicKeyBase64 === null) {
    throw new Error("an ed25519 key must carry public material");
  }
  const signer = keyStoreChainSigner(keyStore, record, null);
  const keyRow: Record<string, unknown> = {
    key_id: record.handle.id,
    tenant_id: null,
    algorithm: record.handle.algorithm,
    purpose: record.handle.purpose,
    public_key_base64: record.publicKeyBase64,
    fingerprint_sha256: signer.fingerprint,
    key_version: record.handle.version,
    status: "active",
    created_at: AT,
  };
  const conn = fakeChainPg({
    ...(opts.failTenant !== undefined ? { failTenant: opts.failTenant } : {}),
    ...(opts.unregisteredKey === true ? {} : { keyRow }),
    ...(opts.rawCheckpoints !== undefined ? { rawCheckpoints: opts.rawCheckpoints } : {}),
  });
  return {
    conn,
    signer,
    registry: new PostgresKeyRegistry(conn, {}),
    checkpointStore: new PostgresChainCheckpointStore(conn, {}),
  };
}

/**
 * A stub verification report, for the tests that are about what the scheduler does with one.
 *
 * `fullBecause` is a parameter rather than always `requested`, because the two reasons a *bounded*
 * verification falls back to a full fold — `anchor_unverified` and `anchor_provenance_absent` — are
 * the ones the scheduler actually meets on a deployment, and a helper that could only express
 * `requested` left both unreachable in every test.
 */
function report(
  tenantId: string | null,
  mode: ChainVerificationReport["mode"],
  ok: boolean,
  fullBecause: ChainFullReason = "requested",
): ChainVerificationReport {
  return {
    tenantId,
    ok,
    mode,
    fullBecause: mode === "full" ? fullBecause : null,
    checkpointSequence: mode === "from_checkpoint" ? 0 : null,
    integrity: { valid: ok, brokenAt: ok ? null : 3 },
    signatures: { valid: ok, checked: 1, results: [], unresolvedFingerprints: [], unreadable: [] },
  };
}

async function seed(
  conn: PgConnection,
  signer: ChainSigner,
  tenantId: string | null,
  count: number,
): Promise<string> {
  const store = new PostgresChainLogStore(conn, signer, {});
  let last = "";
  for (let n = 0; n < count; n += 1) {
    const entry = await store.append({
      tenantId,
      kind: "audit_event",
      actorReference: "gateway",
      recordedAt: AT,
      payload: `event-${n.toString()}`,
    });
    last = entry.entryHash;
  }
  return last;
}

function manualScheduler(): {
  readonly scheduler: IntervalScheduler;
  fire(): void;
  handlerCount(): number;
  cleared(): number;
} {
  const handlers: Array<() => void> = [];
  let cleared = 0;
  return {
    scheduler: {
      setInterval(handler: () => void): IntervalHandle {
        handlers.push(handler);
        return handlers.length - 1;
      },
      clearInterval(): void {
        cleared += 1;
      },
    },
    fire() {
      for (const h of handlers) h();
    },
    handlerCount: () => handlers.length,
    cleared: () => cleared,
  };
}

const BASE_CONFIG = {
  schema: "meta" as const,
  intervalMs: 3_600_000,
  checkpointedBy: "operate-server",
  tenants: [] as string[],
  includePlatform: false,
  allTenants: false,
};

describe("parseCheckpointConfig", () => {
  it("applies defaults", () => {
    const cfg = parseCheckpointConfig({});
    expect(cfg.schema).toBe("meta");
    expect(cfg.intervalMs).toBe(3_600_000);
    expect(cfg.checkpointedBy).toBe("operate-server");
    expect(cfg.tenants).toEqual([]);
    // ADR-0332, flipped in the same change as the integrity proof's: the proof's truncation check
    // has no witness without a checkpoint (ADR-0287), so proving a scope nobody checkpoints leaves
    // that half silently unwitnessed. One decision across two configs.
    expect(cfg.includePlatform).toBe(true);
  });

  it("still honours an explicit false", () => {
    expect(parseCheckpointConfig({ includePlatform: false }).includePlatform).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => parseCheckpointConfig({ nope: true })).toThrow();
  });

  it("rejects a non-uuid tenant", () => {
    expect(() => parseCheckpointConfig({ tenants: ["not-a-uuid"] })).toThrow();
  });
});

describe("loadCheckpointConfig", () => {
  it("reads + parses a config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ckpt-"));
    const path = join(dir, "checkpoint.json");
    await writeFile(path, JSON.stringify({ tenants: [TENANT_A], includePlatform: true, intervalMs: 60_000 }));
    try {
      const cfg = await loadCheckpointConfig(path);
      expect(cfg.tenants).toEqual([TENANT_A]);
      expect(cfg.includePlatform).toBe(true);
      expect(cfg.intervalMs).toBe(60_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wraps a missing file with the flag prefix", async () => {
    await expect(loadCheckpointConfig(join(tmpdir(), "does-not-exist-ckpt.json"))).rejects.toThrow(
      /--checkpoint-config: cannot read/,
    );
  });
});

describe("configScopes", () => {
  it("appends the platform scope only when opted in", () => {
    expect(configScopes({ ...BASE_CONFIG, tenants: [TENANT_A] })).toEqual([TENANT_A]);
    expect(configScopes({ ...BASE_CONFIG, tenants: [TENANT_A], includePlatform: true })).toEqual([
      TENANT_A,
      null,
    ]);
  });
});

describe("allTenants config + tenantSourceScopes", () => {
  it("allTenants defaults false and accepts true", () => {
    expect(parseCheckpointConfig({}).allTenants).toBe(false);
    expect(parseCheckpointConfig({ allTenants: true }).allTenants).toBe(true);
  });

  it("tenantStatuses is optional and, when set, must be non-empty", () => {
    expect(parseCheckpointConfig({}).tenantStatuses).toBeUndefined();
    expect(parseCheckpointConfig({ tenantStatuses: ["active", "trial"] }).tenantStatuses).toEqual([
      "active",
      "trial",
    ]);
    expect(() => parseCheckpointConfig({ tenantStatuses: [] })).toThrow();
  });

  it("resolves scopes from a live tenant source, re-queried each call", async () => {
    let ids: string[] = [TENANT_A, TENANT_B];
    const source = { activeTenantIds: async () => ids };
    const scopes = tenantSourceScopes(source);
    expect(await scopes()).toEqual([TENANT_A, TENANT_B]);
    // a newly-provisioned tenant is picked up on the next call
    ids = [TENANT_A, TENANT_B, TENANT_POISON];
    expect(await scopes()).toEqual([TENANT_A, TENANT_B, TENANT_POISON]);
  });

  it("appends the platform scope only when includePlatform is set", async () => {
    const source = { activeTenantIds: () => [TENANT_A] };
    expect(await tenantSourceScopes(source)()).toEqual([TENANT_A]);
    expect(await tenantSourceScopes(source, { includePlatform: true })()).toEqual([TENANT_A, null]);
  });

  it("drives checkpointing over every live tenant", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    await seed(conn, signer, TENANT_A, 2);
    await seed(conn, signer, TENANT_B, 4);

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, allTenants: true }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      tenants: tenantSourceScopes({ activeTenantIds: () => [TENANT_A, TENANT_B] }),
    });
    const results = await runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["recorded", "recorded"]);
    expect((await checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(1);
    expect((await checkpointStore.latest(TENANT_B))?.sequenceNumber).toBe(3);
  });
});

describe("CHECKPOINT_PASS_OUTCOMES", () => {
  it("is exactly these four members", () => {
    // An exact set rather than a count, on this repo's rule for a vocabulary an argued distinction
    // hangs off: a count moves for a rename too, and the member names ARE the refusal's argument —
    // `refused_unverified` says the chain did not verify, where `error` says no verdict was reached.
    //
    // It was five. `refused_anchor_would_bury` is **gone**, and the deletion is the increment: the
    // pass anchors over an anchor-table finding now and reports it through `onAnchorFindings`, so
    // there is nothing for a fifth outcome to name — a finding beside `recorded` is not what one
    // scope resolved to. A sixth landing unnoticed fails here, which is the whole reason the union
    // is derived from an array.
    expect([...CHECKPOINT_PASS_OUTCOMES]).toEqual([
      "recorded",
      "skipped_empty",
      "refused_unverified",
      "error",
    ]);
  });
});

describe("CheckpointScheduler.runOnce", () => {
  it("records a checkpoint at the tail of a non-empty chain", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    const tailHash = await seed(conn, signer, TENANT_A, 3);

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      now: () => new Date(AT),
    });
    const results = await runOnce();

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("recorded");
    const latest = await checkpointStore.latest(TENANT_A);
    expect(latest).not.toBeNull();
    expect(latest?.sequenceNumber).toBe(2);
    expect(latest?.rootHash).toBe(tailHash);
    expect(latest?.checkpointedBy).toBe("operate-server");
    expect(latest?.checkpointedAt).toBe(AT);
  });

  it("skips a scope with an empty chain without firing onError", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    const errors: unknown[] = [];

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      onError: (err) => errors.push(err),
    });
    const results = await runOnce();

    expect(results[0]?.outcome).toBe("skipped_empty");
    expect(errors).toEqual([]);
    expect(await checkpointStore.latest(TENANT_A)).toBeNull();
  });

  it("checkpoints multiple scopes independently at their own tails", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    await seed(conn, signer, TENANT_A, 2);
    await seed(conn, signer, TENANT_B, 5);

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A, TENANT_B] }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
    });
    const results = await runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["recorded", "recorded"]);
    expect((await checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(1);
    expect((await checkpointStore.latest(TENANT_B))?.sequenceNumber).toBe(4);
  });

  it("checkpoints the platform chain when includePlatform is set", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    await seed(conn, signer, null, 2);

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, includePlatform: true }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
    });
    const results = await runOnce();

    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBeNull();
    expect((await checkpointStore.latest(null))?.sequenceNumber).toBe(1);
  });

  it("isolates a per-scope failure and still checkpoints the others", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture({
      failTenant: TENANT_POISON,
    });
    await seed(conn, signer, TENANT_A, 1);
    const errors: unknown[] = [];

    const { runOnce } = buildCheckpointLifecycle(
      conn,
      { ...BASE_CONFIG, tenants: [TENANT_POISON, TENANT_A] },
      {
        signer,
        registry,
        onRefused: () => undefined,
        onAnchorFindings: () => undefined,
        onError: (err) => errors.push(err),
      },
    );
    const results = await runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["error", "recorded"]);
    expect(errors).toHaveLength(1);
    expect((await checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(0);
  });

  it("fires onCheckpoint with the scope + recorded checkpoint", async () => {
    const { conn, signer, registry } = await newChainFixture();
    await seed(conn, signer, TENANT_A, 1);
    const seen: Array<{ scope: string | null; seq: number }> = [];

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      onCheckpoint: (scope, checkpoint) => seen.push({ scope, seq: checkpoint.sequenceNumber }),
    });
    await runOnce();

    expect(seen).toEqual([{ scope: TENANT_A, seq: 0 }]);
  });

  it("resolves scopes from an injected tenant source, overriding the config list", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    await seed(conn, signer, TENANT_B, 1);

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      tenants: () => [TENANT_B],
    });
    const results = await runOnce();

    expect(results[0]?.scope).toBe(TENANT_B);
    expect(await checkpointStore.latest(TENANT_B)).not.toBeNull();
    expect(await checkpointStore.latest(TENANT_A)).toBeNull();
  });

  it("routes a scope-source failure to onError without throwing", async () => {
    const { conn, signer, registry } = await newChainFixture();
    const errors: unknown[] = [];

    const { runOnce } = buildCheckpointLifecycle(conn, BASE_CONFIG, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      tenants: () => {
        throw new Error("no tenant source");
      },
      onError: (err) => errors.push(err),
    });
    const results = await runOnce();

    expect(results).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("folds from genesis on a first pass and persists verified_full", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    await seed(conn, signer, TENANT_A, 3);

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
    });
    const results = await runOnce();

    // No checkpoint exists yet, so the composed `verifyChainFromCheckpoint` has nothing to anchor a
    // bounded fold to and goes all the way to genesis — which is why a brand-new chain's first
    // anchor is always the one that earns `verified_full`, and every pass after it can be bounded.
    expect(results[0]?.outcome).toBe("recorded");
    expect(results[0]?.verification?.mode).toBe("full");
    expect(results[0]?.verification?.signatures.checked).toBe(3);
    expect((await checkpointStore.latest(TENANT_A))?.provenance).toBe("verified_full");
  });

  it("refuses the anchor when the chain's signing key is unregistered", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture({
      unregisteredKey: true,
    });
    await seed(conn, signer, TENANT_A, 2);
    const errors: unknown[] = [];
    const refused: Array<string | null> = [];

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      registry,
      onRefused: (scope) => refused.push(scope),
      onAnchorFindings: () => undefined,
      onError: (err) => errors.push(err),
    });
    const results = await runOnce();

    expect(results[0]?.outcome).toBe("refused_unverified");
    expect(results[0]?.verification?.signatures.unresolvedFingerprints).toHaveLength(1);
    expect(refused).toEqual([TENANT_A]);
    expect(errors).toEqual([]);
    expect(await checkpointStore.latest(TENANT_A)).toBeNull();
  });
});

/**
 * The verification itself is `chain-verify.ts`'s; these are about what the scheduler does with its
 * answer, so the stores are real and only `verify` is stubbed.
 */
describe("CheckpointScheduler verification", () => {
  function stubVerify(
    fixture: ChainFixture,
    opts: {
      readonly verify: (scope: string | null) => Promise<ChainVerificationReport>;
      readonly scopes: readonly (string | null)[];
      /** Overrides the fixture's store, for the tests that assert on `record` being called at all. */
      readonly checkpointStore?: PostgresChainCheckpointStore;
      /** Overrides the log store, for the one test that needs `tail`'s position in the call order. */
      readonly logStore?: PostgresChainLogStore;
      readonly onCheckpoint?: (scope: string | null, checkpoint: ChainCheckpoint) => void;
      readonly onRefused: (scope: string | null, verification: ChainVerificationReport) => void;
      readonly onAnchorFindings?: (scope: string | null, audit: AnchorAuditReport) => void;
      readonly onError?: (err: unknown) => void;
    },
  ): CheckpointScheduler {
    return new CheckpointScheduler({
      logStore: opts.logStore ?? new PostgresChainLogStore(fixture.conn, fixture.signer, {}),
      checkpointStore: opts.checkpointStore ?? fixture.checkpointStore,
      verify: opts.verify,
      scopes: () => opts.scopes,
      intervalMs: 1000,
      checkpointedBy: "operate-server",
      now: () => new Date(AT),
      ...(opts.onCheckpoint !== undefined ? { onCheckpoint: opts.onCheckpoint } : {}),
      onRefused: opts.onRefused,
      // Optional *here* and required on the scheduler, which is the split the whole file uses for
      // `onRefused`: the option is required where it decides whether a finding is ever reported, and
      // this helper supplies the no-op for the tests that are about something else. The test
      // asserting it is not fired on a clean table is what keeps that no-op from being a hole.
      onAnchorFindings: opts.onAnchorFindings ?? ((): void => undefined),
      ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
    });
  }

  it("derives verified_full from a fold from genesis", async () => {
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 2);
    const seen: ChainCheckpoint[] = [];

    const results = await stubVerify(fx, {
      verify: async (scope) => report(scope, "full", true),
      scopes: [TENANT_A],
      onRefused: () => undefined,
      onCheckpoint: (_scope, checkpoint) => seen.push(checkpoint),
    }).runOnce();

    expect(results[0]?.outcome).toBe("recorded");
    expect(results[0]?.checkpoint?.provenance).toBe("verified_full");
    expect(seen[0]?.provenance).toBe("verified_full");
  });

  it("anchors at the tail the verification covered, not at one re-read afterwards", async () => {
    // ADR-0371's critical finding, and this increment's own class surviving its own fix. The pass
    // read the tail, verified, and then let `createCheckpoint` re-read the chain to choose the
    // sequence — so every entry committed in between was anchored as `verified_full` by a fold that
    // never saw it, and every bounded pass after it starts at `checkpoint.sequenceNumber + 1` and
    // skips the band forever. Appending inside the `verify` stub reproduces the window exactly:
    // writers into it are continuous on a serving deployment, since every audited request anchors
    // a row (ADR-0286), and on a first post-upgrade pass the window is the whole full fold.
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 3); // sequences 0..2
    let during: string | null = null;

    const results = await stubVerify(fx, {
      verify: async (scope) => {
        during = await seed(fx.conn, fx.signer, TENANT_A, 1); // sequence 3, mid-verification
        return report(scope, "full", true);
      },
      scopes: [TENANT_A],
      onRefused: () => undefined,
    }).runOnce();

    expect(results[0]?.outcome).toBe("recorded");
    // 2 and not 3: the entry appended during the verification is simply not covered yet, and the
    // next pass covers it. Claiming 3 would be the defect.
    expect(results[0]?.checkpoint?.sequenceNumber).toBe(2);
    expect(results[0]?.checkpoint?.rootHash).not.toBe(during);
    const stored = await fx.checkpointStore.latest(TENANT_A);
    expect(stored?.sequenceNumber).toBe(2);
  });

  it("carries a refused bounded fold's reason into the report onRefused is handed", async () => {
    // `anchor_unverified` and `anchor_provenance_absent` are the reasons a *bounded* verification
    // falls back, so they are the ones a deployment meets — and `onRefused` is the only place a
    // refusal is reported, because no row is written for one.
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 2);
    const seen: ChainVerificationReport[] = [];

    const results = await stubVerify(fx, {
      verify: async (scope) => report(scope, "full", false, "anchor_provenance_absent"),
      scopes: [TENANT_A],
      onRefused: (_scope, verification) => seen.push(verification),
    }).runOnce();

    expect(results[0]?.outcome).toBe("refused_unverified");
    expect(seen[0]?.fullBecause).toBe("anchor_provenance_absent");
    expect(await fx.checkpointStore.latest(TENANT_A)).toBeNull();
  });

  it("makes a second concurrent pass a no-op rather than stacking folds", async () => {
    // A full fold is unbounded in the chain's length (~152 microseconds of signature CPU per entry
    // measured), so a scope that must fold from genesis can outlast an hourly interval and the
    // timer would stack passes on exactly the deployment least able to afford them.
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 2);
    // A callable default rather than `null`: assignment inside a Promise executor is invisible to
    // control-flow analysis, so a `(() => void) | null` narrows to `null` at the call below and
    // `null?.()` is `never`. A non-null assertion would hide that rather than answer it (ADR-0362).
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = (): void => {
        resolve();
      };
    });
    let verifications = 0;

    const scheduler = stubVerify(fx, {
      verify: async (scope) => {
        verifications += 1;
        await held;
        return report(scope, "full", true);
      },
      scopes: [TENANT_A],
      onRefused: () => undefined,
    });

    const first = scheduler.runOnce();
    const second = await scheduler.runOnce();
    expect(second).toEqual([]); // honest: this call performed no pass
    release();
    expect((await first)[0]?.outcome).toBe("recorded");
    expect(verifications).toBe(1);
  });

  it("derives verified_suffix from a checkpoint-bounded fold", async () => {
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 2);

    const results = await stubVerify(fx, {
      verify: async (scope) => report(scope, "from_checkpoint", true),
      scopes: [TENANT_A],
      onRefused: () => undefined,
    }).runOnce();

    expect(results[0]?.checkpoint?.provenance).toBe("verified_suffix");
  });

  it("refuses an unverified chain and writes no anchor at all", async () => {
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 2);

    const results = await stubVerify(fx, {
      verify: async (scope) => report(scope, "full", false),
      scopes: [TENANT_A],
      onRefused: () => undefined,
    }).runOnce();

    expect(results[0]?.outcome).toBe("refused_unverified");
    expect(results[0]?.checkpoint).toBeUndefined();
    // The anchor a bounded proof would later trust is the thing withheld, so this is the assertion
    // the whole seam exists for: a chain that does not verify gains no fresh prefix to be believed on.
    expect(await fx.checkpointStore.latest(TENANT_A)).toBeNull();
  });

  it("routes a refusal to onRefused with its report, and never to onError", async () => {
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 2);
    const refused: Array<{ scope: string | null; brokenAt: number | null }> = [];
    const errors: unknown[] = [];

    await stubVerify(fx, {
      verify: async (scope) => report(scope, "full", false),
      scopes: [TENANT_A],
      onRefused: (scope, verification) =>
        refused.push({ scope, brokenAt: verification.integrity.brokenAt }),
      onError: (err) => errors.push(err),
    }).runOnce();

    expect(refused).toEqual([{ scope: TENANT_A, brokenAt: 3 }]);
    expect(errors).toEqual([]);
  });

  it("lets the pass continue past a refusal, so other scopes still anchor", async () => {
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 1);
    await seed(fx.conn, fx.signer, TENANT_B, 1);

    const results = await stubVerify(fx, {
      verify: async (scope) => report(scope, "full", scope !== TENANT_A),
      scopes: [TENANT_A, TENANT_B],
      onRefused: () => undefined,
    }).runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["refused_unverified", "recorded"]);
    expect(await fx.checkpointStore.latest(TENANT_A)).toBeNull();
    expect(await fx.checkpointStore.latest(TENANT_B)).not.toBeNull();
  });

  it("verifies before anchoring, never after", async () => {
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 2);
    const atVerifyTime: Array<ChainCheckpoint | null> = [];

    await stubVerify(fx, {
      verify: async (scope) => {
        atVerifyTime.push(await fx.checkpointStore.latest(scope));
        return report(scope, "full", true);
      },
      scopes: [TENANT_A],
      onRefused: () => undefined,
    }).runOnce();

    // Asked while nothing was anchored, and anchored afterwards: an anchor placed first would be one
    // the verification it is supposed to rest on had not yet been asked about.
    expect(atVerifyTime).toEqual([null]);
    expect(await fx.checkpointStore.latest(TENANT_A)).not.toBeNull();
  });

  it("does not verify a scope whose chain is empty", async () => {
    const fx = await newChainFixture();
    const asked: Array<string | null> = [];

    const results = await stubVerify(fx, {
      verify: async (scope) => {
        asked.push(scope);
        return report(scope, "full", true);
      },
      scopes: [TENANT_A],
      onRefused: () => undefined,
    }).runOnce();

    expect(results[0]?.outcome).toBe("skipped_empty");
    expect(results[0]?.verification).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("treats a verifier that throws as an error and not as a refusal", async () => {
    const fx = await newChainFixture();
    await seed(fx.conn, fx.signer, TENANT_A, 1);
    const refused: Array<string | null> = [];
    const errors: unknown[] = [];

    const results = await stubVerify(fx, {
      verify: async () => {
        throw new Error("key registry down");
      },
      scopes: [TENANT_A],
      onRefused: (scope) => refused.push(scope),
      onError: (err) => errors.push(err),
    }).runOnce();

    expect(results[0]?.outcome).toBe("error");
    // No verdict was reached, so none is reported: a verification that could not run says nothing
    // about the chain, where a refusal says the chain did not verify.
    expect(results[0]?.verification).toBeUndefined();
    expect(refused).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(await fx.checkpointStore.latest(TENANT_A)).toBeNull();
  });

  /**
   * What replaced `refused_anchor_would_bury`, whose two map-derived tables these supersede: the
   * pass reads the scope's **whole** anchor table, reports what it finds through
   * `onAnchorFindings`, and anchors anyway.
   */
  describe("the anchor-table audit", () => {
    it("audits before the tail check, so a scope whose chain is gone is still read", async () => {
      // The ordering's live member, and it is one statement: a tenant-context `DELETE` on
      // `forensic_chain_entries` matched the owner's whole row count on every scope measured
      // (ADR-0374), so "the entries were destroyed and the anchors were not" is reachable by the
      // tenant against its own scope, and nothing in the workspace reaches those rows otherwise. An
      // audit placed after the tail check answers it by looking at nothing, because an empty chain
      // is a `skipped_empty` that `continue`s.
      const fx = await newChainFixture({
        rawCheckpoints: [refusedCheckpointRow(TENANT_A, 4)],
      });
      const trace: string[] = [];
      const store = new ObservedCheckpointStore(fx.conn, { trace });
      const findings: AnchorAuditReport[] = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true),
        scopes: [TENANT_A],
        checkpointStore: store,
        logStore: new TracingChainLogStore(fx.conn, fx.signer, trace),
        onRefused: () => undefined,
        onAnchorFindings: (_scope, audit) => findings.push(audit),
      }).runOnce();

      // The order itself, not merely that both happened: the scan precedes the tail read.
      expect(trace).toEqual(["scan", "tail"]);
      expect(results[0]?.outcome).toBe("skipped_empty");
      expect(results[0]?.anchorAudit?.scanned).toBe(1);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.refusedCount).toBe(1);
      // `null` and not `[]`: the correspondence was not asked, and this scheduler's verifier does
      // not hand back the chain it loaded (ADR-0331's claim-versus-nobody-looked, in the report).
      expect(findings[0]?.disagreeing).toBeNull();
    });

    it("anchors over a refused anchor row and reports it, where it used to refuse", async () => {
      // The reversal. `anchor_unreadable` is the reason ADR-0374 withheld the anchor over, and the
      // withholding was right while `latest()` was the detector — one row, so a fresh checkpoint at
      // the tail shadowed the refused one. The detector reads the whole table now, so the anchor is
      // written and the finding survives the write: both assertions in one test, because either
      // alone is the defect.
      const fx = await newChainFixture({
        rawCheckpoints: [refusedCheckpointRow(TENANT_A, 0)],
      });
      await seed(fx.conn, fx.signer, TENANT_A, 3); // sequences 0..2
      const store = new ObservedCheckpointStore(fx.conn);
      const findings: AnchorAuditReport[] = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true, "anchor_unreadable"),
        scopes: [TENANT_A],
        checkpointStore: store,
        onRefused: () => undefined,
        onAnchorFindings: (_scope, audit) => findings.push(audit),
      }).runOnce();

      expect(results[0]?.outcome).toBe("recorded");
      expect(store.recorded).toHaveLength(1);
      // The provenance the fold it rests on earned: `anchor_unreadable` folds from genesis, so the
      // claim covers the whole prefix and the bounded proof's induction holds. That was never the
      // defect — the detector's aperture was.
      expect(store.recorded[0]?.checkpoint.provenance).toBe("verified_full");
      expect(findings).toHaveLength(1);
      expect(findings[0]?.refusedCount).toBe(1);
      // The claim the deleted guard existed to protect, asserted directly: re-reading the table
      // *after* the anchor landed still finds the refused row. ADR-0374's measurement was that one
      // pass took the verdict from `compromised` to `verified` with the row untouched on disk; the
      // row is still untouched and the finding is still there, because the reader is no longer one
      // row wide. Without this line the test above would pass on a detector that had been buried.
      const after = await auditAnchors(TENANT_A, store, null);
      expect(after.scanned).toBe(2);
      expect(after.refusedCount).toBe(1);
    });

    it("fires nothing when the anchor table is clean", async () => {
      // The control for every `onAnchorFindings: () => undefined` in this file: a clean table is
      // silent, so a no-op handler elsewhere is not hiding a fired callback.
      const fx = await newChainFixture();
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const findings: AnchorAuditReport[] = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true),
        scopes: [TENANT_A],
        onRefused: () => undefined,
        onAnchorFindings: (_scope, audit) => findings.push(audit),
      }).runOnce();

      expect(results[0]?.outcome).toBe("recorded");
      expect(findings).toEqual([]);
      expect(results[0]?.anchorAudit?.refusedCount).toBe(0);
      expect(results[0]?.anchorAudit?.complete).toBe(true);
    });

    it("fires on every pass, because the condition stands until somebody acts on it", async () => {
      // Deliberately not deduped in this process. ADR-0329 settled it for the sweep stall on the
      // same grounds — a standing condition's signal is the repetition — and ADR-0332 refused the
      // alternative directly, moving an episode's kind out of process memory because a restart
      // forgets it and a second replica never knew it. Per-episode adoption belongs in the
      // escalation's `findOpen`, which reads durable state.
      const fx = await newChainFixture({
        rawCheckpoints: [refusedCheckpointRow(TENANT_A, 0)],
      });
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const findings: AnchorAuditReport[] = [];

      const scheduler = stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true),
        scopes: [TENANT_A],
        onRefused: () => undefined,
        onAnchorFindings: (_scope, audit) => findings.push(audit),
      });
      await scheduler.runOnce();
      await scheduler.runOnce();

      expect(findings).toHaveLength(2);
    });

    it("reports a scan the ceiling stopped, and anchors anyway", async () => {
      // `!complete` is a finding on its own — the counts beside it are lower bounds — and it is the
      // one case where "did the audit see everything?" answers no. It is still not a refusal: the
      // gap is reported here and answered `unproven` by the verdict, and the scope that trips a
      // 1,000,000-row ceiling is the longest chain in the deployment, i.e. the one least able to
      // afford the fold from genesis a refusal would impose.
      const fx = await newChainFixture();
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const store = new ObservedCheckpointStore(fx.conn, { scanIncomplete: true });
      const findings: AnchorAuditReport[] = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true),
        scopes: [TENANT_A],
        checkpointStore: store,
        onRefused: () => undefined,
        onAnchorFindings: (_scope, audit) => findings.push(audit),
      }).runOnce();

      expect(results[0]?.outcome).toBe("recorded");
      expect(store.recorded).toHaveLength(1);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.complete).toBe(false);
      expect(findings[0]?.refusedCount).toBe(0);
    });

    it("carries the audit onto the result of every outcome it preceded", async () => {
      // Including `error`: the audit is the reading, not a consequence of anchoring, so a scope
      // whose verification then threw must not lose a reading that was taken.
      const fx = await newChainFixture({
        rawCheckpoints: [
          checkpointRow(null, 0),
          checkpointRow(TENANT_B, 0),
          checkpointRow(TENANT_POISON, 0),
        ],
      });
      await seed(fx.conn, fx.signer, null, 1);
      await seed(fx.conn, fx.signer, TENANT_B, 1);
      await seed(fx.conn, fx.signer, TENANT_POISON, 1);

      const results = await stubVerify(fx, {
        verify: async (scope) => {
          if (scope === TENANT_POISON) throw new Error("key registry down");
          return report(scope, "full", scope !== null);
        },
        scopes: [TENANT_A, null, TENANT_B, TENANT_POISON],
        onRefused: () => undefined,
      }).runOnce();

      // One of each: nothing to anchor, refused, anchored, threw.
      expect(results.map((r) => r.outcome)).toEqual([
        "skipped_empty",
        "refused_unverified",
        "recorded",
        "error",
      ]);
      expect(results.map((r) => r.anchorAudit?.scanned)).toEqual([0, 1, 1, 1]);
    });

    it("treats an audit that throws as an error, and anchors nothing for that scope", async () => {
      const fx = await newChainFixture();
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const store = new ObservedCheckpointStore(fx.conn, { scanThrows: true });
      const errors: unknown[] = [];
      const findings: AnchorAuditReport[] = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true),
        scopes: [TENANT_A],
        checkpointStore: store,
        onRefused: () => undefined,
        onAnchorFindings: (_scope, audit) => findings.push(audit),
        onError: (err) => errors.push(err),
      }).runOnce();

      expect(results[0]?.outcome).toBe("error");
      // No report was produced, so none is carried and none is reported: a reading that could not
      // be taken says nothing about the anchor table, which is `refused_unverified`-versus-`error`
      // one table across.
      expect(results[0]?.anchorAudit).toBeUndefined();
      expect(findings).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(store.recorded).toEqual([]);
    });

    it("files a throwing findings handler as that scope's error, having written nothing", async () => {
      // Inside the `try` on `onRefused`'s precedent and not `onCheckpoint`'s: nothing has been
      // written when this fires, so filing it as an `error` states nothing false about the
      // database — which is exactly the condition that puts `onCheckpoint` outside the `try`.
      const fx = await newChainFixture({
        rawCheckpoints: [refusedCheckpointRow(TENANT_A, 0)],
      });
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const store = new ObservedCheckpointStore(fx.conn);
      const errors: unknown[] = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true),
        scopes: [TENANT_A],
        checkpointStore: store,
        onRefused: () => undefined,
        onAnchorFindings: () => {
          throw new Error("findings sink down");
        },
        onError: (err) => errors.push(err),
      }).runOnce();

      expect(results[0]?.outcome).toBe("error");
      expect(results[0]?.anchorAudit?.refusedCount).toBe(1);
      expect(errors).toHaveLength(1);
      expect(store.recorded).toEqual([]);
    });

    it("lets the pass continue past a finding, so every scope is read and anchored", async () => {
      const fx = await newChainFixture({
        rawCheckpoints: [refusedCheckpointRow(TENANT_A, 0)],
      });
      await seed(fx.conn, fx.signer, TENANT_A, 1);
      await seed(fx.conn, fx.signer, TENANT_B, 1);
      const store = new ObservedCheckpointStore(fx.conn);
      const findings: Array<string | null> = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true),
        scopes: [TENANT_A, TENANT_B],
        checkpointStore: store,
        onRefused: () => undefined,
        onAnchorFindings: (scope) => findings.push(scope),
      }).runOnce();

      expect(results.map((r) => r.outcome)).toEqual(["recorded", "recorded"]);
      expect(store.recorded.map((r) => r.scope)).toEqual([TENANT_A, TENANT_B]);
      expect(findings).toEqual([TENANT_A]);
    });
  });
});

describe("CheckpointScheduler lifecycle", () => {
  it("runs a pass on start via the injected scheduler, and stop() clears the timer", async () => {
    const { conn, signer, registry, checkpointStore } = await newChainFixture();
    await seed(conn, signer, TENANT_A, 1);
    const manual = manualScheduler();

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const { scheduler } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      registry,
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      scheduler: manual.scheduler,
      onCheckpoint: () => resolveDone(),
    });

    scheduler.start();
    expect(manual.handlerCount()).toBe(1);
    await done;
    expect(await checkpointStore.latest(TENANT_A)).not.toBeNull();

    scheduler.stop();
    expect(manual.cleared()).toBe(1);
    scheduler.start();
    expect(manual.handlerCount()).toBe(2);
    scheduler.stop();
  });

  it("does not run an immediate pass when runOnStart is false", async () => {
    const { conn, signer, checkpointStore } = await newChainFixture();
    await seed(conn, signer, TENANT_A, 1);
    const manual = manualScheduler();

    const scheduler = new CheckpointScheduler({
      logStore: new PostgresChainLogStore(conn, signer, {}),
      checkpointStore,
      verify: async (scope) => report(scope, "full", true),
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      checkpointedBy: "operate-server",
      onRefused: () => undefined,
      onAnchorFindings: () => undefined,
      scheduler: manual.scheduler,
      runOnStart: false,
    });

    scheduler.start();
    await Promise.resolve();
    expect(await checkpointStore.latest(TENANT_A)).toBeNull();

    await scheduler.runOnce();
    expect(await checkpointStore.latest(TENANT_A)).not.toBeNull();
  });
});
