import { describe, expect, it } from "vitest";
import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
} from "@crossengin/crypto";
import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  auditChainKeyRegistryRecord,
  deriveAuditChainKeyId,
  registerAuditChainKey,
} from "./audit-chain-key-registration.js";

const KEY_ID_REGEX = /^key_(hmac-sha256|ed25519)_[0-9A-HJKMNP-TV-Z]{26}$/;
const TENANT_A = "11111111-1111-4111-8111-111111111111";

/** Minimal in-memory `meta.crypto_keys`: upsert on key_id, keyed reads by key_id / fingerprint. */
function fakeCryptoKeysConn(): PgConnection {
  const rows = new Map<string, Record<string, unknown>>();

  function paramIndex(sql: string, expr: string): number | null {
    const m = sql.match(new RegExp(`${expr}\\s*=\\s*\\$(\\d+)`));
    return m ? Number(m[1]) - 1 : null;
  }

  function makeClient(): PgConnection {
    const query = async (
      sql: string,
      params?: readonly unknown[],
    ): Promise<PgQueryResult> => {
      const p = params ?? [];
      if (sql.includes("set_config")) return { rows: [], rowCount: 0 };

      if (sql.includes("INSERT INTO")) {
        const keyId = p[0] as string;
        const incoming: Record<string, unknown> = {
          key_id: keyId,
          tenant_id: p[1] ?? null,
          algorithm: p[2],
          purpose: p[3],
          public_key_base64: p[4] ?? null,
          fingerprint_sha256: p[5] ?? null,
          key_version: p[6],
          status: p[7],
          created_at: p[8],
        };
        const existing = rows.get(keyId);
        rows.set(
          keyId,
          existing === undefined
            ? incoming
            : {
                ...existing,
                public_key_base64: incoming.public_key_base64,
                fingerprint_sha256: incoming.fingerprint_sha256,
                key_version: incoming.key_version,
                status: incoming.status,
              },
        );
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("SELECT")) {
        let visible = [...rows.values()];
        const keyIdIdx = paramIndex(sql, "key_id");
        if (keyIdIdx !== null) {
          visible = visible.filter((r) => r["key_id"] === p[keyIdIdx]);
        }
        const fpIdx = paramIndex(sql, "fingerprint_sha256");
        if (fpIdx !== null) {
          visible = visible.filter((r) => r["fingerprint_sha256"] === p[fpIdx]);
        }
        return { rows: visible, rowCount: visible.length };
      }

      return { rows: [], rowCount: 0 };
    };

    return {
      query: query as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) =>
        fn(makeClient())) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) =>
        fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
  }

  return makeClient();
}

const FIXED_NOW = (): Date => new Date("2026-08-17T00:00:00.000Z");

describe("deriveAuditChainKeyId", () => {
  it("is deterministic for the same fingerprint", () => {
    const { publicKeyBase64 } = generateEd25519Keypair();
    const fp = ed25519PublicKeyFingerprint(publicKeyBase64);
    expect(deriveAuditChainKeyId(fp)).toBe(deriveAuditChainKeyId(fp));
  });

  it("matches the crypto_keys key_id regex", () => {
    for (let i = 0; i < 20; i += 1) {
      const { publicKeyBase64 } = generateEd25519Keypair();
      const fp = ed25519PublicKeyFingerprint(publicKeyBase64);
      expect(deriveAuditChainKeyId(fp)).toMatch(KEY_ID_REGEX);
    }
  });

  it("uses only Crockford-uppercase symbols (no I/L/O/U)", () => {
    const fp = "f".repeat(64);
    const suffix = deriveAuditChainKeyId(fp).slice("key_ed25519_".length);
    expect(suffix).toHaveLength(26);
    expect(suffix).not.toMatch(/[ILOU]/);
    expect(suffix).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("distinguishes different fingerprints", () => {
    const a = deriveAuditChainKeyId("0".repeat(64));
    const b = deriveAuditChainKeyId("f".repeat(64));
    expect(a).not.toBe(b);
  });

  it("is stable against known fingerprints (all-zero / all-f)", () => {
    expect(deriveAuditChainKeyId("0".repeat(64))).toBe(
      `key_ed25519_${"0".repeat(26)}`,
    );
    expect(deriveAuditChainKeyId("f".repeat(64))).toMatch(KEY_ID_REGEX);
  });
});

describe("auditChainKeyRegistryRecord", () => {
  it("builds a valid ed25519 / evidence_sealing / active record", () => {
    const { publicKeyBase64 } = generateEd25519Keypair();
    const record = auditChainKeyRegistryRecord(
      { publicKeyBase64 },
      { now: FIXED_NOW },
    );
    expect(record.algorithm).toBe("ed25519");
    expect(record.purpose).toBe("evidence_sealing");
    expect(record.status).toBe("active");
    expect(record.keyVersion).toBe(1);
    expect(record.tenantId).toBeNull();
    expect(record.publicKeyBase64).toBe(publicKeyBase64);
    expect(record.createdAt).toBe("2026-08-17T00:00:00.000Z");
  });

  it("carries the correct fingerprint and derived key id", () => {
    const { publicKeyBase64 } = generateEd25519Keypair();
    const fp = ed25519PublicKeyFingerprint(publicKeyBase64);
    const record = auditChainKeyRegistryRecord({ publicKeyBase64 });
    expect(record.fingerprint).toBe(fp);
    expect(record.keyId).toBe(deriveAuditChainKeyId(fp));
    expect(record.keyId).toMatch(KEY_ID_REGEX);
  });

  it("honors an explicit tenantId", () => {
    const { publicKeyBase64 } = generateEd25519Keypair();
    const record = auditChainKeyRegistryRecord(
      { publicKeyBase64 },
      { tenantId: TENANT_A },
    );
    expect(record.tenantId).toBe(TENANT_A);
  });

  it("honors an explicit keyId override", () => {
    const { publicKeyBase64 } = generateEd25519Keypair();
    const override = `key_ed25519_${"A".repeat(26)}`;
    const record = auditChainKeyRegistryRecord(
      { publicKeyBase64 },
      { keyId: override },
    );
    expect(record.keyId).toBe(override);
  });
});

describe("registerAuditChainKey", () => {
  it("persists the record, resolvable by fingerprint and key id", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysConn());
    const { publicKeyBase64 } = generateEd25519Keypair();
    const record = await registerAuditChainKey(registry, { publicKeyBase64 });

    const byFp = await registry.getByFingerprint(record.fingerprint as string);
    expect(byFp?.keyId).toBe(record.keyId);
    const byId = await registry.getByKeyId(record.keyId);
    expect(byId?.publicKeyBase64).toBe(publicKeyBase64);
    expect(byId?.purpose).toBe("evidence_sealing");
  });

  it("is idempotent — registering twice yields a single row", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysConn());
    const { publicKeyBase64 } = generateEd25519Keypair();
    const first = await registerAuditChainKey(registry, { publicKeyBase64 });
    const second = await registerAuditChainKey(registry, { publicKeyBase64 });
    expect(second.keyId).toBe(first.keyId);

    const rows = await registry.listKeys();
    const matching = rows.filter((r) => r.fingerprint === first.fingerprint);
    expect(matching).toHaveLength(1);
    const byId = await registry.getByKeyId(first.keyId);
    expect(byId).not.toBeNull();
  });

  it("registers under an explicit keyId override", async () => {
    const registry = new PostgresKeyRegistry(fakeCryptoKeysConn());
    const { publicKeyBase64 } = generateEd25519Keypair();
    const override = `key_ed25519_${"B".repeat(26)}`;
    const record = await registerAuditChainKey(
      registry,
      { publicKeyBase64 },
      { keyId: override },
    );
    expect(record.keyId).toBe(override);
    const byId = await registry.getByKeyId(override);
    expect(byId?.publicKeyBase64).toBe(publicKeyBase64);
  });
});
