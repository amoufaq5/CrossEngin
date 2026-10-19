import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { PipelineExecution } from "@crossengin/api-gateway";
import {
  generateEd25519Keypair,
  ed25519PublicKeyFingerprint,
  signEd25519,
  verifyEd25519,
} from "@crossengin/crypto";
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
  AuditChainConfigSchema,
  auditChainStore,
  buildAuditChain,
  ed25519ChainSigner,
  loadAuditChainConfig,
  parseAuditChainConfig,
  resolveAuditPolicy,
  sampleValue,
  shouldRecordAudit,
  type LiveAuditPolicySource,
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
    expect(() => parseAuditChainConfig({ publicKeyBase64: keypair.publicKeyBase64 })).toThrow();
    expect(() => parseAuditChainConfig({ privateKeyBase64: keypair.privateKeyBase64 })).toThrow();
    expect(() => config({ schema: "Bad-Schema" })).toThrow();
  });

  it("refuses a key half that is not a 32-byte Ed25519 key, naming the field", () => {
    // Both halves, at parse time, where the field name comes from zod and the file name from
    // `loadAuditChainConfig` — rather than from a hand-written string at the one use site, which
    // is what left `publicKeyBase64: "x"` passing `.min(1)` and throwing a bare
    // `public key must decode to 32 bytes, got 0` at boot (ADR-0371).
    for (const [field, value] of [
      ["publicKeyBase64", "x"],
      ["publicKeyBase64", Buffer.alloc(31).toString("base64")],
      ["publicKeyBase64", "not!base64!"],
      ["privateKeyBase64", "x"],
      ["privateKeyBase64", Buffer.alloc(16).toString("base64")],
      ["privateKeyBase64", "not!base64!"],
    ] as const) {
      const issues = AuditChainConfigSchema.safeParse({
        privateKeyBase64: keypair.privateKeyBase64,
        publicKeyBase64: keypair.publicKeyBase64,
        [field]: value,
      });
      expect(issues.success).toBe(false);
      if (issues.success) continue;
      // The path is the property, not the message: a reworded message must not break this, and the
      // path is what tells an operator which line of the JSON to edit.
      expect(issues.error.issues.map((i) => i.path.join("."))).toContain(field);
      // And the refusal must not echo the configured value back, since the private half is a secret.
      expect(JSON.stringify(issues.error.issues)).not.toContain(value);
    }
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

describe("ed25519ChainSigner key-pair agreement", () => {
  const other = generateEd25519Keypair();
  const crossed = { privateKeyBase64: keypair.privateKeyBase64, publicKeyBase64: other.publicKeyBase64 };

  /** The refusal message, or a failure if the call did not refuse. */
  function refusalOf(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected a refusal, got a signer");
  }

  it("node signs under the private half and silently ignores a mismatched public half", () => {
    // The measurement the refusal exists for: this does NOT throw, so without a check the signer
    // writes signatures under `other` is unable to verify, announced under its fingerprint.
    const signature = signEd25519(crossed.privateKeyBase64, crossed.publicKeyBase64, "entry");
    expect(verifyEd25519(keypair.publicKeyBase64, signature, "entry")).toBe(true);
    expect(verifyEd25519(other.publicKeyBase64, signature, "entry")).toBe(false);
  });

  it("refuses a pair whose halves are not each other's", () => {
    expect(() => ed25519ChainSigner(crossed)).toThrow(
      /publicKeyBase64 is not the public half of privateKeyBase64/,
    );
  });

  it("names both fingerprints and neither key's bytes", () => {
    const message = refusalOf(() => ed25519ChainSigner(crossed));
    // A fingerprint is a digest of public material and is the column every entry records, so it is
    // the identifier an operator greps for. The key bytes are neither needed nor safe to print.
    expect(message).toContain(ed25519PublicKeyFingerprint(other.publicKeyBase64));
    expect(message).toContain(ed25519PublicKeyFingerprint(keypair.publicKeyBase64));
    expect(message).not.toContain(keypair.privateKeyBase64);
    expect(message).not.toContain(keypair.publicKeyBase64);
    expect(message).not.toContain(other.publicKeyBase64);
  });

  it("accepts an unpadded but correct public key, because the comparison is over bytes", () => {
    // base64 of 32 bytes is 43 characters plus one '='; both spellings decode identically, so a
    // comparison of the two strings would refuse a deployment whose key is perfectly good.
    const unpadded = keypair.publicKeyBase64.replace(/=+$/, "");
    expect(unpadded).not.toBe(keypair.publicKeyBase64);
    expect(
      ed25519ChainSigner({ privateKeyBase64: keypair.privateKeyBase64, publicKeyBase64: unpadded })
        .fingerprint,
    ).toBe(ed25519PublicKeyFingerprint(keypair.publicKeyBase64));
  });

  // The property pinned is the house shape, not the wording: the flag an operator passed and the
  // field they would edit. `/private seed/` was @crossengin/crypto's own sentence, which names
  // neither — and this refusal lands long before `server.listen`, so it is the whole boot failure.
  it("refuses a private key that is not base64, naming the flag and the field", () => {
    const message = refusalOf(() =>
      ed25519ChainSigner({ privateKeyBase64: "not base64!", publicKeyBase64: keypair.publicKeyBase64 }),
    );
    expect(message).toContain("--audit-chain-config:");
    expect(message).toContain("privateKeyBase64");
    expect(message).toMatch(/not valid base64/);
  });

  it("refuses a private key of the wrong decoded length, naming the flag and the field", () => {
    const short = Buffer.alloc(16).toString("base64");
    const message = refusalOf(() =>
      ed25519ChainSigner({ privateKeyBase64: short, publicKeyBase64: keypair.publicKeyBase64 }),
    );
    expect(message).toContain("--audit-chain-config:");
    expect(message).toContain("privateKeyBase64");
    // The underlying cause rides along, so the wrapper adds attribution without hiding the defect.
    expect(message).toMatch(/32 bytes/);
    // Named, never echoed: the field's configured value is private material.
    expect(message).not.toContain(short);
  });

  it("covers the wiring paths, not only a direct construction", () => {
    const c = config({ publicKeyBase64: other.publicKeyBase64 });
    expect(() => auditChainStore(fakeChainPg(), c)).toThrow(/not the public half/);
    expect(() => buildAuditChain(fakeChainPg(), c)).toThrow(/not the public half/);
  });

  it("a consistent pair still builds a signer whose signatures verify under the announced key", async () => {
    const signer = ed25519ChainSigner(keypair);
    expect(signer.fingerprint).toBe(ed25519PublicKeyFingerprint(keypair.publicKeyBase64));
    const bytes = Buffer.from("canonical entry bytes", "utf8");
    expect(verifyEd25519(keypair.publicKeyBase64, await signer.sign(bytes), bytes)).toBe(true);
  });
});

describe("shouldRecordAudit", () => {
  it("records every outcome + operation by default", () => {
    expect(shouldRecordAudit(execution(), config())).toBe(true);
    expect(shouldRecordAudit(execution({ finalOutcome: "deny" }), config())).toBe(true);
  });

  it("outcomes allowlist skips a passing request but records a failure", () => {
    const c = config({ outcomes: ["deny", "error"] });
    expect(shouldRecordAudit(execution({ finalOutcome: "pass", finalResponseStatus: 200 }), c)).toBe(false);
    expect(shouldRecordAudit(execution({ finalOutcome: "deny", finalResponseStatus: 403 }), c)).toBe(true);
    expect(shouldRecordAudit(execution({ finalOutcome: "error", finalResponseStatus: 500 }), c)).toBe(true);
  });

  it("operations allowlist skips a non-listed operation and excludes a null operation", () => {
    const c = config({ operations: ["product.list"] });
    expect(shouldRecordAudit(execution({ routeOperationId: "product.list" }), c)).toBe(true);
    expect(shouldRecordAudit(execution({ routeOperationId: "product.get" }), c)).toBe(false);
    expect(shouldRecordAudit(execution({ routeOperationId: null }), c)).toBe(false);
  });

  it("sampleRate 0 records nothing and sampleRate 1 records everything", () => {
    const none = config({ sampleRate: 0 });
    const all = config({ sampleRate: 1 });
    for (const id of ["req_abcdefgh12345678", "req_aaaaaaaa11111111", "req_cccccccc33333333"]) {
      expect(shouldRecordAudit(execution({ requestId: id }), none)).toBe(false);
      expect(shouldRecordAudit(execution({ requestId: id }), all)).toBe(true);
    }
  });

  it("an intermediate rate is deterministic per requestId and partitions a spread", () => {
    const half = config({ sampleRate: 0.5 });
    // sampleValue is stable, so the decision is stable across calls for the same id.
    expect(sampleValue("req_abcdefgh12345678")).toBe(sampleValue("req_abcdefgh12345678"));
    const under = execution({ requestId: "req_abcdefgh12345678" }); // sampleValue ~0.199 < 0.5
    const over = execution({ requestId: "req_aaaaaaaa11111111" }); // sampleValue ~0.970 >= 0.5
    expect(shouldRecordAudit(under, half)).toBe(true);
    expect(shouldRecordAudit(under, half)).toBe(true);
    expect(shouldRecordAudit(over, half)).toBe(false);

    const ids = [
      "req_abcdefgh12345678", "req_aaaaaaaa11111111", "req_bbbbbbbb22222222",
      "req_cccccccc33333333", "req_lowsample0001", "req_highsample999",
      "req_sample00000001", "req_sample00000002", "req_sample00000003", "req_sample00000004",
    ];
    const recorded = ids.filter((id) => shouldRecordAudit(execution({ requestId: id }), half)).length;
    expect(recorded).toBeGreaterThan(0);
    expect(recorded).toBeLessThan(ids.length);
  });
});

describe("resolveAuditPolicy", () => {
  it("returns a tenant's full override in place of the base", () => {
    const c = config({
      outcomes: ["pass"],
      operations: ["product.list"],
      sampleRate: 1,
      tenantOverrides: { [TENANT]: { outcomes: ["deny", "error"], operations: ["product.get"], sampleRate: 0.1 } },
    });
    expect(resolveAuditPolicy(TENANT, c)).toEqual({ outcomes: ["deny", "error"], operations: ["product.get"], sampleRate: 0.1 });
  });

  it("inherits unset override fields from the base (partial override)", () => {
    const c = config({
      outcomes: ["pass"],
      operations: ["product.list"],
      sampleRate: 1,
      tenantOverrides: { [TENANT]: { sampleRate: 0.01 } },
    });
    expect(resolveAuditPolicy(TENANT, c)).toEqual({ outcomes: ["pass"], operations: ["product.list"], sampleRate: 0.01 });
  });

  it("uses the base for a tenant with no override and for a null (platform) tenant", () => {
    const c = config({
      outcomes: ["pass"],
      sampleRate: 0.5,
      tenantOverrides: { [TENANT]: { sampleRate: 0 } },
    });
    expect(resolveAuditPolicy(TENANT_B, c)).toEqual({ outcomes: ["pass"], operations: undefined, sampleRate: 0.5 });
    expect(resolveAuditPolicy(null, c)).toEqual({ outcomes: ["pass"], operations: undefined, sampleRate: 0.5 });
  });
});

describe("shouldRecordAudit with tenantOverrides", () => {
  it("a per-tenant sampleRate 0 silences that tenant while others still record", () => {
    const c = config({ tenantOverrides: { [TENANT]: { sampleRate: 0 } } });
    expect(shouldRecordAudit(execution({ tenantId: TENANT }), c)).toBe(false);
    expect(shouldRecordAudit(execution({ tenantId: TENANT_B }), c)).toBe(true);
  });

  it("a per-tenant outcomes allowlist skips that tenant's pass while the base tenant still records", () => {
    const c = config({ tenantOverrides: { [TENANT]: { outcomes: ["deny", "error"] } } });
    expect(shouldRecordAudit(execution({ tenantId: TENANT, finalOutcome: "pass", finalResponseStatus: 200 }), c)).toBe(false);
    expect(shouldRecordAudit(execution({ tenantId: TENANT, finalOutcome: "deny", finalResponseStatus: 403 }), c)).toBe(true);
    expect(shouldRecordAudit(execution({ tenantId: TENANT_B, finalOutcome: "pass", finalResponseStatus: 200 }), c)).toBe(true);
  });

  it("a null (platform) tenant is unaffected by a tenant override map", () => {
    const c = config({ tenantOverrides: { [TENANT]: { sampleRate: 0 } } });
    expect(shouldRecordAudit(execution({ tenantId: null }), c)).toBe(true);
  });
});

describe("sampleValue", () => {
  it("is in [0, 1) and deterministic", () => {
    const v = sampleValue("req_abcdefgh12345678");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
    expect(sampleValue("req_abcdefgh12345678")).toBe(v);
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
    expect(chain.entries).toHaveLength(3);
    expect(chain.unreadable).toEqual([]);
    expect(chain.entries[0]?.priorEntryHash).toBe(GENESIS_HASH);
    expect(verifyChainIntegrity(chain.entries).valid).toBe(true);
    for (const entry of chain.entries) {
      expect(verifyChainEntrySignature(entry, keypair.publicKeyBase64)).toBe(true);
    }
  });

  it("a filtered-out request appends nothing and never touches the queues", async () => {
    const store = new PostgresChainLogStore(fakeChainPg(), ed25519ChainSigner(keypair));
    const observer = new AuditChainObserver(store, config({ outcomes: ["deny", "error"] }));

    observer.record(execution({ finalOutcome: "pass", requestId: "req_aaaaaaaa11111111" }));
    expect(observer.pending()).toBe(0);
    expect(observer.activeScopes()).toBe(0);
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(0);

    // A passing (matching) request still appends as before.
    observer.record(execution({ finalOutcome: "deny", finalResponseStatus: 403, requestId: "req_bbbbbbbb22222222" }));
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(1);
  });

  it("a per-tenant override that filters out a tenant appends nothing while another tenant still appends", async () => {
    const store = new PostgresChainLogStore(fakeChainPg(), ed25519ChainSigner(keypair));
    const observer = new AuditChainObserver(store, config({ tenantOverrides: { [TENANT]: { sampleRate: 0 } } }));

    observer.record(execution({ tenantId: TENANT, requestId: "req_aaaaaaaa11111111" }));
    expect(observer.pending()).toBe(0);
    expect(observer.activeScopes()).toBe(0);

    observer.record(execution({ tenantId: TENANT_B, requestId: "req_bbbbbbbb22222222" }));
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(0);
    expect((await store.loadChain(TENANT_B)).entries).toHaveLength(1);
  });

  it("routes an append failure to onError without stalling the queue", async () => {
    const errs: unknown[] = [];
    let calls = 0;
    const flaky = {
      append: async (_input: unknown) => {
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
    expect((await chain.store.loadChain(TENANT)).entries).toHaveLength(1);
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

  it("a live policyCache sampleRate 0 silences a tenant the config would otherwise record", async () => {
    const store = new PostgresChainLogStore(fakeChainPg(), ed25519ChainSigner(keypair));
    const policyCache = { get: (t: string) => (t === TENANT ? { sampleRate: 0 } : undefined) };
    // config records everything; only the live policy filters TENANT out.
    const observer = new AuditChainObserver(store, config(), { policyCache });

    observer.record(execution({ tenantId: TENANT, requestId: "req_aaaaaaaa11111111" }));
    expect(observer.pending()).toBe(0);
    expect(observer.activeScopes()).toBe(0);

    observer.record(execution({ tenantId: TENANT_B, requestId: "req_bbbbbbbb22222222" }));
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(0);
    expect((await store.loadChain(TENANT_B)).entries).toHaveLength(1);
  });

  it("a tenant with no live policy falls back to the config path", async () => {
    const store = new PostgresChainLogStore(fakeChainPg(), ed25519ChainSigner(keypair));
    const policyCache = { get: (_t: string) => undefined };
    const observer = new AuditChainObserver(store, config({ outcomes: ["deny", "error"] }), { policyCache });

    // config's outcomes allowlist still applies when the cache has nothing for this tenant.
    observer.record(execution({ finalOutcome: "pass", requestId: "req_aaaaaaaa11111111" }));
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(0);

    observer.record(execution({ finalOutcome: "deny", finalResponseStatus: 403, requestId: "req_bbbbbbbb22222222" }));
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(1);
  });

  it("a live policy overrides a config tenantOverride (live wins per-field)", async () => {
    const store = new PostgresChainLogStore(fakeChainPg(), ed25519ChainSigner(keypair));
    // config would SILENCE the tenant (sampleRate 0), but the live policy re-enables full recording.
    const policyCache = { get: (t: string) => (t === TENANT ? { sampleRate: 1 } : undefined) };
    const observer = new AuditChainObserver(
      store,
      config({ tenantOverrides: { [TENANT]: { sampleRate: 0 } } }),
      { policyCache },
    );

    observer.record(execution({ tenantId: TENANT, requestId: "req_aaaaaaaa11111111" }));
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(1);
  });

  it("a live outcomes allowlist filters a tenant while another still appends", async () => {
    const store = new PostgresChainLogStore(fakeChainPg(), ed25519ChainSigner(keypair));
    const policyCache: LiveAuditPolicySource = {
      get: (t) => (t === TENANT ? { outcomes: ["deny", "error"] } : undefined),
    };
    const observer = new AuditChainObserver(store, config(), { policyCache });

    observer.record(execution({ tenantId: TENANT, finalOutcome: "pass", finalResponseStatus: 200, requestId: "req_aaaaaaaa11111111" }));
    observer.record(execution({ tenantId: TENANT_B, finalOutcome: "pass", finalResponseStatus: 200, requestId: "req_bbbbbbbb22222222" }));
    await observer.drain();
    expect((await store.loadChain(TENANT)).entries).toHaveLength(0);
    expect((await store.loadChain(TENANT_B)).entries).toHaveLength(1);
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
