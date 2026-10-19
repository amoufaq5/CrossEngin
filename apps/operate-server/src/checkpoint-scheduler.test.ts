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
} from "@crossengin/forensics-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  CHAIN_FULL_REASONS,
  CHAIN_FULL_REASON_BLOCKS_ANCHORING,
  type ChainFullReason,
  type ChainVerificationReport,
} from "./chain-verify.js";
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
 * Inline fake of `meta.forensic_chain_entries`, `meta.forensic_chain_checkpoints` and the one
 * `meta.crypto_keys` lookup a signature check makes, with RLS-like per-transaction tenant scoping
 * (mirrors forensics-pg's private test fake, which isn't exported).
 *
 * `failTenant` makes every read for that scope throw, to exercise per-scope error isolation.
 * `keyRow` is the registry row `getByFingerprint` resolves to — omit it and the chain's signing
 * fingerprint is unresolvable, which is how an unregistered key is reproduced.
 */
function fakeChainPg(
  opts: { readonly failTenant?: string; readonly keyRow?: Record<string, unknown> } = {},
): PgConnection {
  const entryRows: Record<string, unknown>[] = [];
  const checkpointRows: Record<string, unknown>[] = [];

  function makeClient(): PgConnection {
    let currentTenant: string | null = null;

    const query = async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      const p = params ?? [];
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
            checkpointRows.push({
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
        const table = sql.includes(CHECKPOINTS) ? checkpointRows : entryRows;
        let visible = table.filter((r) => (r["tenant_id"] ?? null) === currentTenant);

        const geIdx = paramIndex(sql, /sequence_number >= \$(\d+)/);
        if (!Number.isNaN(geIdx)) {
          const min = Number(p[geIdx]);
          visible = visible.filter((r) => Number(r["sequence_number"]) >= min);
        }
        const eqIdx = paramIndex(sql, /sequence_number = \$(\d+)/);
        if (!Number.isNaN(eqIdx)) {
          const val = Number(p[eqIdx]);
          visible = visible.filter((r) => Number(r["sequence_number"]) === val);
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
      return { rows: [], rowCount: 0 };
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

/**
 * A checkpoint store that counts the `record` calls reaching it, because that is the assertion the
 * burying refusal needs and `latest()` cannot give.
 *
 * `latest() === null` is the fence every other refusal test here uses, and it is sound for those:
 * nothing is on disk, so a write is the only thing that could make it non-null. It is **unsound for
 * the burying refusal**, because that write is a row the store accepts and the contract reads back
 * perfectly — so in the live shape, where a refused row is already on disk, `latest()` would answer
 * with the *new* row and `expect(...).toBeNull()` would be asserting the defect rather than its
 * absence. The question there is whether the write was attempted at all.
 *
 * A subclass rather than a stand-in object, because `CheckpointSchedulerOptions.checkpointStore` is
 * the concrete class: this keeps the real `record` (and its `ChainCheckpointSchema.parse`) on the
 * path, so a test asserting "nothing was recorded" cannot pass because the fake accepted something
 * the real store would refuse.
 */
class RecordCountingCheckpointStore extends PostgresChainCheckpointStore {
  readonly recorded: Array<{
    readonly scope: string | null;
    readonly checkpoint: ChainCheckpoint;
  }> = [];

  override async record(tenantId: string | null, checkpoint: ChainCheckpoint): Promise<void> {
    this.recorded.push({ scope: tenantId, checkpoint });
    await super.record(tenantId, checkpoint);
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
  opts: { readonly failTenant?: string; readonly unregisteredKey?: boolean } = {},
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
      tenants: tenantSourceScopes({ activeTenantIds: () => [TENANT_A, TENANT_B] }),
    });
    const results = await runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["recorded", "recorded"]);
    expect((await checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(1);
    expect((await checkpointStore.latest(TENANT_B))?.sequenceNumber).toBe(3);
  });
});

describe("CHECKPOINT_PASS_OUTCOMES", () => {
  it("is exactly these five members", () => {
    // An exact set rather than a count, on this repo's rule for a vocabulary an argued distinction
    // hangs off: a count moves for a rename too, and these member names ARE the two refusals'
    // arguments — `refused_unverified` says the chain did not verify, `refused_anchor_would_bury`
    // says it did and the stored anchor is the finding. A sixth outcome fails here rather than
    // landing unnoticed, which is the whole reason the union is derived from an array.
    expect([...CHECKPOINT_PASS_OUTCOMES]).toEqual([
      "recorded",
      "skipped_empty",
      "refused_unverified",
      "refused_anchor_would_bury",
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
      { signer, registry, onRefused: () => undefined, onError: (err) => errors.push(err) },
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
      readonly onCheckpoint?: (scope: string | null, checkpoint: ChainCheckpoint) => void;
      readonly onRefused: (scope: string | null, verification: ChainVerificationReport) => void;
      readonly onError?: (err: unknown) => void;
    },
  ): CheckpointScheduler {
    return new CheckpointScheduler({
      logStore: new PostgresChainLogStore(fixture.conn, fixture.signer, {}),
      checkpointStore: opts.checkpointStore ?? fixture.checkpointStore,
      verify: opts.verify,
      scopes: () => opts.scopes,
      intervalMs: 1000,
      checkpointedBy: "operate-server",
      now: () => new Date(AT),
      ...(opts.onCheckpoint !== undefined ? { onCheckpoint: opts.onCheckpoint } : {}),
      onRefused: opts.onRefused,
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
   * The two sides of `CHAIN_FULL_REASON_BLOCKS_ANCHORING`, derived from the map rather than
   * hand-listed, so a reason whose answer is flipped moves between the tables below instead of
   * leaving one of them asserting the behaviour it used to have. The map's exact membership is
   * `chain-verify.test.ts`'s claim to make; what these need is that every reason sits in exactly one
   * table and that both tables have a member.
   */
  const BURYING_REASONS = CHAIN_FULL_REASONS.filter((r) => CHAIN_FULL_REASON_BLOCKS_ANCHORING[r]);
  const SUPERSEDING_REASONS = CHAIN_FULL_REASONS.filter(
    (r) => !CHAIN_FULL_REASON_BLOCKS_ANCHORING[r],
  );

  describe("an anchor on disk that a fresh checkpoint would bury", () => {
    it("partitions every full-fold reason into exactly one of the two tables", () => {
      // The vacuity floor for both `it.each`s below: `it.each([])` passes having run nothing, which
      // is the shape of coverage that is not coverage. `toContain` and not `toEqual` on the burying
      // side, because the map's exact membership is asserted where the map lives and restating it
      // here would be two spellings of one claim — what this file needs is that the member its
      // headline fence is about is in the table that exercises it.
      expect(BURYING_REASONS).toContain("anchor_unreadable");
      expect(SUPERSEDING_REASONS.length).toBeGreaterThan(0);
      expect([...BURYING_REASONS, ...SUPERSEDING_REASONS].sort()).toEqual(
        [...CHAIN_FULL_REASONS].sort(),
      );
    });

    it.each(BURYING_REASONS)(
      "refuses to anchor over %s and writes nothing, on a chain that verified",
      async (reason) => {
        const fx = await newChainFixture();
        await seed(fx.conn, fx.signer, TENANT_A, 2);
        const store = new RecordCountingCheckpointStore(fx.conn, {});
        const refused: ChainVerificationReport[] = [];

        const results = await stubVerify(fx, {
          verify: async (scope) => report(scope, "full", true, reason),
          scopes: [TENANT_A],
          checkpointStore: store,
          onRefused: (_scope, verification) => refused.push(verification),
        }).runOnce();

        expect(results[0]?.outcome).toBe("refused_anchor_would_bury");
        // `ok` is true, and that is the whole of why this is not `refused_unverified`: the chain
        // verified and the finding is the stored anchor, so a reader of the result can tell the two
        // apart rather than being told a sound chain failed to verify.
        expect(results[0]?.verification?.ok).toBe(true);
        expect(results[0]?.verification?.fullBecause).toBe(reason);
        expect(results[0]?.checkpoint).toBeUndefined();
        expect(refused).toHaveLength(1);
        expect(refused[0]?.fullBecause).toBe(reason);
        // The assertion `latest()` cannot give — see `RecordCountingCheckpointStore`. A row at the
        // tail is one the store accepts and reads back, so on a deployment `latest()` would answer
        // with it and asserting `null` would be asserting the defect.
        expect(store.recorded).toEqual([]);
      },
    );

    it.each(SUPERSEDING_REASONS)("still anchors over %s", async (reason) => {
      // The negative controls, and the last two matter most. `anchor_unverified` and
      // `anchor_provenance_absent` are the self-healing path ADR-0371 built: a row stating that
      // nothing vouched for its prefix, or one written before the column existed, is *superseded*
      // by a vouched anchor rather than hidden by it — so a fence that refused these would stop a
      // legacy or hand-placed anchor ever being replaced and make the full fold permanent for
      // exactly the deployments the healing exists for. `requested` and `no_checkpoint` have
      // nothing on disk to bury at all.
      const fx = await newChainFixture();
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const store = new RecordCountingCheckpointStore(fx.conn, {});
      const refused: Array<string | null> = [];

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", true, reason),
        scopes: [TENANT_A],
        checkpointStore: store,
        onRefused: (scope) => refused.push(scope),
      }).runOnce();

      expect(results[0]?.outcome).toBe("recorded");
      expect(refused).toEqual([]);
      expect(store.recorded).toHaveLength(1);
      // The superseding anchor carries the provenance the fold it rests on earned, which is what
      // makes replacing the old row a heal rather than a second unvouched claim at a new sequence.
      expect(store.recorded[0]?.checkpoint.provenance).toBe("verified_full");
      expect((await fx.checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(1);
    });

    it("reports a failed verification as the failure even when its reason would bury", async () => {
      // Order: `!ok` wins. "This chain did not verify" is the stronger and more urgent statement,
      // and the anchor refusal is implied by it, since nothing is written on either path.
      const fx = await newChainFixture();
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const store = new RecordCountingCheckpointStore(fx.conn, {});

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "full", false, "anchor_unreadable"),
        scopes: [TENANT_A],
        checkpointStore: store,
        onRefused: () => undefined,
      }).runOnce();

      expect(results[0]?.outcome).toBe("refused_unverified");
      expect(store.recorded).toEqual([]);
    });

    it("anchors a bounded pass, which carries no reason and so buries nothing", async () => {
      const fx = await newChainFixture();
      await seed(fx.conn, fx.signer, TENANT_A, 2);
      const store = new RecordCountingCheckpointStore(fx.conn, {});

      const results = await stubVerify(fx, {
        verify: async (scope) => report(scope, "from_checkpoint", true),
        scopes: [TENANT_A],
        checkpointStore: store,
        onRefused: () => undefined,
      }).runOnce();

      expect(results[0]?.verification?.fullBecause).toBeNull();
      expect(results[0]?.outcome).toBe("recorded");
      expect(store.recorded).toHaveLength(1);
    });

    it("lets the pass continue past a burying refusal, so other scopes still anchor", async () => {
      const fx = await newChainFixture();
      await seed(fx.conn, fx.signer, TENANT_A, 1);
      await seed(fx.conn, fx.signer, TENANT_B, 1);
      const store = new RecordCountingCheckpointStore(fx.conn, {});

      const results = await stubVerify(fx, {
        verify: async (scope) =>
          report(scope, "full", true, scope === TENANT_A ? "anchor_unreadable" : "no_checkpoint"),
        scopes: [TENANT_A, TENANT_B],
        checkpointStore: store,
        onRefused: () => undefined,
      }).runOnce();

      expect(results.map((r) => r.outcome)).toEqual(["refused_anchor_would_bury", "recorded"]);
      expect(store.recorded.map((r) => r.scope)).toEqual([TENANT_B]);
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
