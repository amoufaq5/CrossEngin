import { describe, expect, it, vi } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import type { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  keyStoreChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  formatChainVerification,
  keyRegistryResolver,
  verifyChainFromCheckpoint,
  verifyChainFull,
} from "./chain-verify.js";

const FP = "a".repeat(64);
const PUB = "cHVibGljLWtleS1iYXNlNjQ=";

/** A structural stand-in for PostgresKeyRegistry — only getByFingerprint is exercised by the resolver. */
function fakeRegistry(
  byFp: Record<string, { publicKeyBase64: string | null }>,
  spy?: (fp: string) => void,
): PostgresKeyRegistry {
  return {
    getByFingerprint: async (fp: string) => {
      spy?.(fp);
      return byFp[fp] ?? null;
    },
  } as unknown as PostgresKeyRegistry;
}

describe("keyRegistryResolver", () => {
  it("resolves a known fingerprint to its registered public key", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: PUB } }));
    expect(await resolver.resolveByFingerprint(FP)).toBe(PUB);
  });

  it("returns null for an unknown fingerprint", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({}));
    expect(await resolver.resolveByFingerprint(FP)).toBeNull();
  });

  it("returns null when a registered key has no public material", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: null } }));
    expect(await resolver.resolveByFingerprint(FP)).toBeNull();
  });

  it("delegates to the registry's getByFingerprint", async () => {
    const spy = vi.fn();
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: PUB } }, spy));
    await resolver.resolveByFingerprint(FP);
    expect(spy).toHaveBeenCalledWith(FP);
  });
});

const TENANT = "11111111-1111-1111-1111-111111111111";

/** In-memory fake of meta.forensic_chain_entries + meta.forensic_chain_checkpoints, routed by table name. */
function fakeChainPg(): PgConnection {
  const entryRows: Record<string, unknown>[] = [];
  const checkpointRows: Record<string, unknown>[] = [];
  const CHECKPOINTS = "forensic_chain_checkpoints";
  function client(): PgConnection {
    let tenant: string | null = null;
    const query = async (sql: string, params?: readonly unknown[]): Promise<PgQueryResult> => {
      const p = params ?? [];
      if (sql.includes("set_config")) { tenant = (p[0] as string | null) ?? null; return { rows: [], rowCount: 0 }; }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO")) {
        if (sql.includes(CHECKPOINTS)) {
          checkpointRows.push({
            tenant_id: p[0] ?? null, sequence_number: p[1], root_hash: p[2], checkpointed_at: p[3],
            checkpointed_by: p[4], external_anchor_reference: p[5] ?? null, algorithm: p[6],
          });
          return { rows: [], rowCount: 1 };
        }
        entryRows.push({
          tenant_id: p[0] ?? null, sequence_number: p[1], kind: p[2], recorded_at: p[3], actor_reference: p[4],
          payload_sha256: p[5], payload_size_bytes: p[6], prior_entry_hash: p[7], entry_hash: p[8],
          signing_key_fingerprint: p[9], signature: p[10],
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT")) {
        const table = sql.includes(CHECKPOINTS) ? checkpointRows : entryRows;
        let visible = table.filter((r) => (r["tenant_id"] ?? null) === tenant)
          .sort((a, b) => Number(a["sequence_number"]) - Number(b["sequence_number"]));
        const geMatch = /sequence_number >= \$(\d+)/.exec(sql);
        if (geMatch) visible = visible.filter((r) => Number(r["sequence_number"]) >= Number(p[Number(geMatch[1]) - 1]));
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

const AT = "2026-06-01T00:00:00.000Z";

async function seededChain(count = 3) {
  const keyStore = new InMemoryKeyStore();
  const record = await keyStore.createKey({ tenantId: null, algorithm: "ed25519", purpose: "evidence_sealing" });
  const publicKeyBase64 = await keyStore.getPublicMaterial(record.handle);
  const signer = keyStoreChainSigner(keyStore, record, null);
  const conn = fakeChainPg();
  const store = new PostgresChainLogStore(conn, signer);
  const append = (n: number) =>
    store.append({ tenantId: TENANT, kind: "audit_event", actorReference: "gw", recordedAt: AT, payload: `e${n.toString()}` });
  for (let n = 0; n < count; n += 1) await append(n);
  return { conn, store, append, fingerprint: signer.fingerprint, publicKeyBase64 };
}

describe("verifyChainFull", () => {
  it("reports OK when integrity + registry-resolved signatures verify", async () => {
    const { store, fingerprint, publicKeyBase64 } = await seededChain();
    const registry = fakeRegistry({ [fingerprint]: { publicKeyBase64 } });
    const report = await verifyChainFull(store, registry, TENANT);
    expect(report.ok).toBe(true);
    expect(report.integrity.valid).toBe(true);
    expect(report.signatures.valid).toBe(true);
    expect(report.signatures.checked).toBe(3);
    expect(formatChainVerification(report)).toContain("OK");
  });

  it("reports FAILED when the signing key is not registered", async () => {
    const { store } = await seededChain();
    const report = await verifyChainFull(store, fakeRegistry({}), TENANT);
    expect(report.ok).toBe(false);
    expect(report.signatures.valid).toBe(false);
    expect(report.signatures.unresolvedFingerprints.length).toBe(1);
    const text = formatChainVerification(report);
    expect(text).toContain("FAILED");
    expect(text).toContain("unresolved keys");
  });

  it("an empty chain is vacuously OK", async () => {
    const keyStore = new InMemoryKeyStore();
    const record = await keyStore.createKey({ tenantId: null, algorithm: "ed25519", purpose: "evidence_sealing" });
    const store = new PostgresChainLogStore(fakeChainPg(), keyStoreChainSigner(keyStore, record, null));
    const report = await verifyChainFull(store, fakeRegistry({}), TENANT);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe("full");
    expect(report.checkpointSequence).toBeNull();
    expect(report.signatures.checked).toBe(0);
  });
});

describe("verifyChainFromCheckpoint", () => {
  it("verifies only the suffix after the latest checkpoint", async () => {
    const { conn, store, append, fingerprint, publicKeyBase64 } = await seededChain(3);
    const checkpoints = new PostgresChainCheckpointStore(conn, {});
    // Anchor a checkpoint at the current tail (seq 2), then append two more entries.
    const cp = await store.createCheckpoint(TENANT, { checkpointedBy: "auditor", checkpointedAt: AT });
    await checkpoints.record(TENANT, cp);
    await append(3);
    await append(4);

    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      TENANT,
    );
    expect(report.mode).toBe("from_checkpoint");
    expect(report.checkpointSequence).toBe(2);
    expect(report.ok).toBe(true);
    // only the two entries AFTER the checkpoint are re-checked
    expect(report.signatures.checked).toBe(2);
    expect(formatChainVerification(report)).toContain("from checkpoint seq 2");
  });

  it("falls back to a full verify when no checkpoint exists", async () => {
    const { conn, store, fingerprint, publicKeyBase64 } = await seededChain(3);
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      new PostgresChainCheckpointStore(conn, {}),
      TENANT,
    );
    expect(report.mode).toBe("full");
    expect(report.signatures.checked).toBe(3);
    expect(report.ok).toBe(true);
  });

  it("reports FAILED when a suffix signature does not resolve", async () => {
    const { conn, store, append } = await seededChain(2);
    const checkpoints = new PostgresChainCheckpointStore(conn, {});
    const cp = await store.createCheckpoint(TENANT, { checkpointedBy: "auditor", checkpointedAt: AT });
    await checkpoints.record(TENANT, cp);
    await append(2);

    // registry knows no keys → the one suffix entry is unresolved
    const report = await verifyChainFromCheckpoint(store, fakeRegistry({}), checkpoints, TENANT);
    expect(report.mode).toBe("from_checkpoint");
    expect(report.signatures.checked).toBe(1);
    expect(report.ok).toBe(false);
  });
});
