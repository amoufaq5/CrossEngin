import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { PipelineExecution } from "@crossengin/api-gateway";
import { generateEd25519Keypair, ed25519PublicKeyFingerprint } from "@crossengin/crypto";
import {
  GENESIS_HASH,
  verifyChainEntrySignature,
  verifyChainIntegrity,
} from "@crossengin/forensics";
import { PostgresChainLogStore } from "@crossengin/forensics-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

/** In-memory fake of meta.forensic_chain_entries with RLS-like tenant scoping (see forensics-pg tests). */
function fakeChainPg(): PgConnection {
  const rows: Record<string, unknown>[] = [];
  function client(): PgConnection {
    let tenant: string | null = null;
    const query = async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      const p = params ?? [];
      if (sql.includes("set_config")) { tenant = (p[0] as string | null) ?? null; return { rows: [], rowCount: 0 }; }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO")) {
        rows.push({
          tenant_id: p[0] ?? null, sequence_number: p[1], kind: p[2], recorded_at: p[3], actor_reference: p[4],
          payload_sha256: p[5], payload_size_bytes: p[6], prior_entry_hash: p[7], entry_hash: p[8],
          signing_key_fingerprint: p[9], signature: p[10],
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT")) {
        let visible = rows.filter((r) => (r["tenant_id"] ?? null) === tenant)
          .sort((a, b) => Number(a["sequence_number"]) - Number(b["sequence_number"]));
        if (sql.includes("ORDER BY sequence_number DESC")) visible = visible.slice(-1);
        return { rows: visible, rowCount: visible.length };
      }
      return { rows: [], rowCount: 0 };
    };
    const c: PgConnection = {
      query: query as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(client())) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    return c;
  }
  return client();
}

import {
  AuditChainObserver,
  auditAppendInputFrom,
  buildAuditChain,
  ed25519ChainSigner,
  loadAuditChainConfig,
  parseAuditChainConfig,
} from "./audit-chain.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "33333333-3333-3333-3333-333333333333";
const PRINCIPAL = "22222222-2222-2222-2222-2222222222aa";
const keypair = generateEd25519Keypair();

function config(overrides: Record<string, unknown> = {}) {
  return parseAuditChainConfig({
    privateKeyBase64: keypair.privateKeyBase64,
    publicKeyBase64: keypair.publicKeyBase64,
    ...overrides,
  });
}

function execution(overrides: Partial<PipelineExecution> = {}): PipelineExecution {
  return {
    requestId: "req_abcdefgh12345678",
    tenantId: TENANT,
    startedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:00:00.100Z",
    totalDurationMs: 100,
    finalStage: "emit_audit",
    finalOutcome: "pass",
    finalResponseStatus: 200,
    stages: [{ stage: "receive", outcome: "pass", startedAt: "2026-06-01T00:00:00.000Z", durationMs: 1, problemTypeUri: null }],
    authOutcome: "authenticated",
    routeMatchOutcome: "matched",
    idempotencyOutcome: null,
    principalId: PRINCIPAL,
    routeOperationId: "product.list",
    resolvedApiVersion: "v1",
    correlationId: null,
    rateLimitDecisionId: null,
    ...overrides,
  } as PipelineExecution;
}

describe("parseAuditChainConfig", () => {
  it("applies defaults", () => {
    const c = config();
    expect(c.schema).toBe("meta");
    expect(c.actorReference).toBe("operate-server");
  });

  it("requires both key halves and rejects a bad schema", () => {
    expect(() => parseAuditChainConfig({ publicKeyBase64: "x" })).toThrow();
    expect(() => config({ schema: "Bad-Schema" })).toThrow();
  });
});

describe("loadAuditChainConfig", () => {
  it("reads + validates a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audit-cfg-"));
    const path = join(dir, "a.json");
    await writeFile(path, JSON.stringify({ privateKeyBase64: keypair.privateKeyBase64, publicKeyBase64: keypair.publicKeyBase64 }), "utf8");
    expect((await loadAuditChainConfig(path)).actorReference).toBe("operate-server");
  });

  it("wraps a missing file", async () => {
    await expect(loadAuditChainConfig("/no/such.json")).rejects.toThrow(/cannot read/);
  });
});

describe("ed25519ChainSigner + auditAppendInputFrom", () => {
  it("signer fingerprint matches the public key", () => {
    expect(ed25519ChainSigner(keypair).fingerprint).toBe(
      ed25519PublicKeyFingerprint(keypair.publicKeyBase64),
    );
  });

  it("projects an execution into an append (principal is the actor)", () => {
    const input = auditAppendInputFrom(execution(), { actorReference: "operate-server" });
    expect(input.tenantId).toBe(TENANT);
    expect(input.kind).toBe("audit_event");
    expect(input.actorReference).toBe(PRINCIPAL);
    expect(input.recordedAt).toBe("2026-06-01T00:00:00.100Z");
    expect(JSON.parse(input.payload as string).operationId).toBe("product.list");
  });

  it("falls back to the configured actor for an anonymous request", () => {
    const input = auditAppendInputFrom(execution({ principalId: null }), { actorReference: "operate-server" });
    expect(input.actorReference).toBe("operate-server");
  });
});

describe("AuditChainObserver", () => {
  it("appends one signed, hash-linked entry per request, in order", async () => {
    const store = new PostgresChainLogStore(fakeChainPg(), ed25519ChainSigner(keypair));
    const observer = new AuditChainObserver(store, config());

    observer.record(execution({ requestId: "req_aaaaaaaa11111111" }));
    observer.record(execution({ requestId: "req_bbbbbbbb22222222" }));
    observer.record(execution({ requestId: "req_cccccccc33333333" }));
    await observer.drain();
    expect(observer.pending()).toBe(0);

    const chain = await store.loadChain(TENANT);
    expect(chain).toHaveLength(3);
    expect(chain[0]?.priorEntryHash).toBe(GENESIS_HASH);
    expect(verifyChainIntegrity(chain).valid).toBe(true);
    for (const entry of chain) {
      expect(verifyChainEntrySignature(entry, keypair.publicKeyBase64)).toBe(true);
    }
  });

  it("routes an append failure to onError without stalling the queue", async () => {
    const errs: unknown[] = [];
    let calls = 0;
    const flaky = {
      append: async (input: unknown) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { sequenceNumber: 0 } as never;
      },
    } as unknown as PostgresChainLogStore;
    const observer = new AuditChainObserver(flaky, config(), { onError: (e) => errs.push(e) });
    observer.record(execution());
    observer.record(execution());
    await observer.drain();
    expect(errs).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("buildAuditChain wires a store + observer whose sink appends", async () => {
    const chain = buildAuditChain(fakeChainPg(), config());
    chain.observer.asExecutionSink()(execution());
    await chain.observer.drain();
    expect(await chain.store.loadChain(TENANT)).toHaveLength(1);
  });

  it("appends for different tenants proceed in parallel; drain clears the scopes", async () => {
    const order: string[] = [];
    let releaseA = (): void => {};
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const store = {
      append: async (input: { tenantId: string | null }) => {
        if (input.tenantId === TENANT) {
          await gateA;
          order.push("A");
        } else {
          order.push("B");
        }
        return { sequenceNumber: 0 } as never;
      },
    } as unknown as PostgresChainLogStore;
    const observer = new AuditChainObserver(store, config());

    observer.record(execution({ tenantId: TENANT, requestId: "req_aaaaaaaa11111111" }));
    observer.record(execution({ tenantId: TENANT_B, requestId: "req_bbbbbbbb22222222" }));
    expect(observer.activeScopes()).toBe(2);

    // B is not blocked behind A's gated append.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["B"]);

    releaseA();
    await observer.drain();
    expect(order).toEqual(["B", "A"]);
    expect(observer.activeScopes()).toBe(0);
    expect(observer.pending()).toBe(0);
  });

  it("keeps a single tenant's appends strictly ordered on its own queue", async () => {
    const seen: number[] = [];
    let n = 0;
    const store = {
      append: async () => {
        const mine = n++;
        // later-scheduled appends resolve their microtask first if not serialized
        await Promise.resolve();
        seen.push(mine);
        return { sequenceNumber: mine } as never;
      },
    } as unknown as PostgresChainLogStore;
    const observer = new AuditChainObserver(store, config());
    observer.record(execution({ requestId: "req_aaaaaaaa11111111" }));
    observer.record(execution({ requestId: "req_bbbbbbbb22222222" }));
    observer.record(execution({ requestId: "req_cccccccc33333333" }));
    await observer.drain();
    expect(seen).toEqual([0, 1, 2]);
  });
});
