import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  keyStoreChainSigner,
  type ChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import {
  buildCheckpointLifecycle,
  configScopes,
  loadCheckpointConfig,
  parseCheckpointConfig,
  tenantSourceScopes,
  CheckpointScheduler,
} from "./checkpoint-scheduler.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TENANT_POISON = "33333333-3333-3333-3333-333333333333";
const AT = "2026-06-01T00:00:00.000Z";

const CHECKPOINTS = "forensic_chain_checkpoints";

function paramIndex(sql: string, re: RegExp): number {
  const m = re.exec(sql);
  return m === null ? Number.NaN : Number(m[1]) - 1;
}

/**
 * Inline fake of both `meta.forensic_chain_entries` and `meta.forensic_chain_checkpoints` with RLS-like
 * per-transaction tenant scoping (mirrors forensics-pg's private test fake, which isn't exported).
 * `failTenant` makes every read for that scope throw, to exercise per-scope error isolation.
 */
function fakeChainPg(opts: { readonly failTenant?: string } = {}): PgConnection {
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

async function newSigner(): Promise<ChainSigner> {
  const keyStore = new InMemoryKeyStore();
  const record = await keyStore.createKey({
    tenantId: null,
    algorithm: "ed25519",
    purpose: "evidence_sealing",
  });
  return keyStoreChainSigner(keyStore, record, null);
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
    expect(cfg.includePlatform).toBe(false);
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
    const conn = fakeChainPg();
    const signer = await newSigner();
    await seed(conn, signer, TENANT_A, 2);
    await seed(conn, signer, TENANT_B, 4);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, allTenants: true }, {
      signer,
      tenants: tenantSourceScopes({ activeTenantIds: () => [TENANT_A, TENANT_B] }),
    });
    const results = await runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["recorded", "recorded"]);
    expect((await checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(1);
    expect((await checkpointStore.latest(TENANT_B))?.sequenceNumber).toBe(3);
  });
});

describe("CheckpointScheduler.runOnce", () => {
  it("records a checkpoint at the tail of a non-empty chain", async () => {
    const conn = fakeChainPg();
    const signer = await newSigner();
    const tailHash = await seed(conn, signer, TENANT_A, 3);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
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
    const conn = fakeChainPg();
    const signer = await newSigner();
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});
    const errors: unknown[] = [];

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      onError: (err) => errors.push(err),
    });
    const results = await runOnce();

    expect(results[0]?.outcome).toBe("skipped_empty");
    expect(errors).toEqual([]);
    expect(await checkpointStore.latest(TENANT_A)).toBeNull();
  });

  it("checkpoints multiple scopes independently at their own tails", async () => {
    const conn = fakeChainPg();
    const signer = await newSigner();
    await seed(conn, signer, TENANT_A, 2);
    await seed(conn, signer, TENANT_B, 5);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A, TENANT_B] }, {
      signer,
    });
    const results = await runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["recorded", "recorded"]);
    expect((await checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(1);
    expect((await checkpointStore.latest(TENANT_B))?.sequenceNumber).toBe(4);
  });

  it("checkpoints the platform chain when includePlatform is set", async () => {
    const conn = fakeChainPg();
    const signer = await newSigner();
    await seed(conn, signer, null, 2);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, includePlatform: true }, {
      signer,
    });
    const results = await runOnce();

    expect(results).toHaveLength(1);
    expect(results[0]?.scope).toBeNull();
    expect((await checkpointStore.latest(null))?.sequenceNumber).toBe(1);
  });

  it("isolates a per-scope failure and still checkpoints the others", async () => {
    const conn = fakeChainPg({ failTenant: TENANT_POISON });
    const signer = await newSigner();
    await seed(conn, signer, TENANT_A, 1);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});
    const errors: unknown[] = [];

    const { runOnce } = buildCheckpointLifecycle(
      conn,
      { ...BASE_CONFIG, tenants: [TENANT_POISON, TENANT_A] },
      { signer, onError: (err) => errors.push(err) },
    );
    const results = await runOnce();

    expect(results.map((r) => r.outcome)).toEqual(["error", "recorded"]);
    expect(errors).toHaveLength(1);
    expect((await checkpointStore.latest(TENANT_A))?.sequenceNumber).toBe(0);
  });

  it("fires onCheckpoint with the scope + recorded checkpoint", async () => {
    const conn = fakeChainPg();
    const signer = await newSigner();
    await seed(conn, signer, TENANT_A, 1);
    const seen: Array<{ scope: string | null; seq: number }> = [];

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      onCheckpoint: (scope, checkpoint) => seen.push({ scope, seq: checkpoint.sequenceNumber }),
    });
    await runOnce();

    expect(seen).toEqual([{ scope: TENANT_A, seq: 0 }]);
  });

  it("resolves scopes from an injected tenant source, overriding the config list", async () => {
    const conn = fakeChainPg();
    const signer = await newSigner();
    await seed(conn, signer, TENANT_B, 1);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});

    const { runOnce } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
      tenants: () => [TENANT_B],
    });
    const results = await runOnce();

    expect(results[0]?.scope).toBe(TENANT_B);
    expect(await checkpointStore.latest(TENANT_B)).not.toBeNull();
    expect(await checkpointStore.latest(TENANT_A)).toBeNull();
  });

  it("routes a scope-source failure to onError without throwing", async () => {
    const conn = fakeChainPg();
    const signer = await newSigner();
    const errors: unknown[] = [];

    const { runOnce } = buildCheckpointLifecycle(conn, BASE_CONFIG, {
      signer,
      tenants: () => {
        throw new Error("no tenant source");
      },
      onError: (err) => errors.push(err),
    });
    const results = await runOnce();

    expect(results).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("CheckpointScheduler lifecycle", () => {
  it("runs a pass on start via the injected scheduler, and stop() clears the timer", async () => {
    const conn = fakeChainPg();
    const signer = await newSigner();
    await seed(conn, signer, TENANT_A, 1);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});
    const manual = manualScheduler();

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const { scheduler } = buildCheckpointLifecycle(conn, { ...BASE_CONFIG, tenants: [TENANT_A] }, {
      signer,
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
    const conn = fakeChainPg();
    const signer = await newSigner();
    await seed(conn, signer, TENANT_A, 1);
    const checkpointStore = new PostgresChainCheckpointStore(conn, {});
    const manual = manualScheduler();

    const scheduler = new CheckpointScheduler({
      logStore: new PostgresChainLogStore(conn, signer, {}),
      checkpointStore,
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      checkpointedBy: "operate-server",
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
