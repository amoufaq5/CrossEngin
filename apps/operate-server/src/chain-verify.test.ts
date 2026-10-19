import { describe, expect, it, vi } from "vitest";
import { InMemoryKeyStore } from "@crossengin/crypto";
import type { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import {
  CHECKPOINT_PROVENANCES,
  ChainCheckpointSchema,
  checkpointAnchorsBoundedProof,
  type ChainCheckpoint,
  type CheckpointProvenance,
} from "@crossengin/forensics";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  keyStoreChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  CHAIN_FULL_REASONS,
  CHAIN_FULL_REASON_PHRASES,
  formatChainVerification,
  keyRegistryResolver,
  verifyChainFromCheckpoint,
  verifyChainFull,
  type ChainFullReason,
} from "./chain-verify.js";

const FP = "a".repeat(64);
const PUB = "cHVibGljLWtleS1iYXNlNjQ=";

/** A structural stand-in for PostgresKeyRegistry — only getByFingerprint is exercised by the resolver. */
function fakeRegistry(
  byFp: Record<string, { publicKeyBase64: string | null }>,
  spy?: (fp: string, tenantId: string | null) => void,
): PostgresKeyRegistry {
  return {
    getByFingerprint: async (fp: string, tenantId: string | null = null) => {
      spy?.(fp, tenantId);
      return byFp[fp] ?? null;
    },
  } as unknown as PostgresKeyRegistry;
}

describe("keyRegistryResolver", () => {
  it("resolves a known fingerprint to its registered public key", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: PUB } }), null);
    expect(await resolver.resolveByFingerprint(FP)).toBe(PUB);
  });

  it("returns null for an unknown fingerprint", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({}), null);
    expect(await resolver.resolveByFingerprint(FP)).toBeNull();
  });

  it("returns null when a registered key has no public material", async () => {
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: null } }), null);
    expect(await resolver.resolveByFingerprint(FP)).toBeNull();
  });

  it("delegates to the registry's getByFingerprint", async () => {
    const spy = vi.fn();
    const resolver = keyRegistryResolver(fakeRegistry({ [FP]: { publicKeyBase64: PUB } }, spy), null);
    await resolver.resolveByFingerprint(FP);
    expect(spy).toHaveBeenCalledWith(FP, null);
  });

  it("resolves against the scope of the chain being verified, not against the connection's role", async () => {
    // A platform chain entry must not be verifiable by a key a tenant registered — the forgery
    // route `app.platform_key_write` exists to close, which an unscoped read handed back as the
    // table's owner.
    const spy = vi.fn();
    const tenant = "11111111-1111-1111-1111-111111111111";
    const resolver = keyRegistryResolver(
      fakeRegistry({ [FP]: { publicKeyBase64: PUB } }, spy),
      tenant,
    );
    await resolver.resolveByFingerprint(FP);
    expect(spy).toHaveBeenCalledWith(FP, tenant);
  });
});

const TENANT = "11111111-1111-1111-1111-111111111111";

/**
 * In-memory fake of meta.forensic_chain_entries + meta.forensic_chain_checkpoints, routed by table
 * name. `entries` is handed back so a test can rewrite a stored row the way the live reproduction
 * did — the fake's own model is the only place a prefix tamper can be staged offline.
 */
function fakeChainPg(): { readonly conn: PgConnection; readonly entries: Record<string, unknown>[] } {
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
  return { conn: client(), entries: entryRows };
}

const AT = "2026-06-01T00:00:00.000Z";

/** `scope` is a parameter so the platform chain (`null`) can be seeded too, not only a tenant's. */
async function seededChain(count = 3, scope: string | null = TENANT) {
  const keyStore = new InMemoryKeyStore();
  const record = await keyStore.createKey({ tenantId: null, algorithm: "ed25519", purpose: "evidence_sealing" });
  const publicKeyBase64 = await keyStore.getPublicMaterial(record.handle);
  const signer = keyStoreChainSigner(keyStore, record, null);
  const { conn, entries } = fakeChainPg();
  const store = new PostgresChainLogStore(conn, signer);
  const append = (n: number) =>
    store.append({ tenantId: scope, kind: "audit_event", actorReference: "gw", recordedAt: AT, payload: `e${n.toString()}` });
  for (let n = 0; n < count; n += 1) await append(n);
  return { conn, entries, store, append, scope, fingerprint: signer.fingerprint, publicKeyBase64 };
}

/**
 * A structural stand-in for PostgresChainCheckpointStore — `verifyChainFromCheckpoint` calls only
 * `latest`. A fake rather than the real store because `provenance` is the one thing these tests
 * vary, and attaching it here keeps them independent of whether that store's round trip carries it.
 *
 * `spy` records the scope it was asked for, which this fake used to discard. A `latest()` that
 * ignores its argument is the owner-bypass shape (ADR-0331/0333/0335) and the real store's own doc
 * comment names this instance: a tenant's `latest()` returning the *platform's* newest checkpoint
 * hands a truncation check the wrong witness. Nothing here pinned that the scope is passed through.
 */
function fakeCheckpoints(
  checkpoint: ChainCheckpoint | null,
  spy?: (tenantId: string | null) => void,
): PostgresChainCheckpointStore {
  return {
    latest: async (tenantId: string | null) => {
      spy?.(tenantId);
      return checkpoint;
    },
  } as unknown as PostgresChainCheckpointStore;
}

/**
 * A genuine anchor over the chain's current tail — real `rootHash`, declared provenance.
 *
 * `undefined` asks for the row an **older binary** wrote, and it cannot come from
 * `createCheckpoint` at all: `CheckpointMeta.provenance` is required, so every current writer
 * answers, and a writer permitted to omit it would make a new row indistinguishable from one of
 * those. So the absent form is built by dropping the key and re-parsed, which also pins the fact the
 * `anchor_provenance_absent` arm rests on — the *record* field stays optional (ADR-0331), so a
 * provenance-less `ChainCheckpoint` is still a legal row and not a shape only a test can hold.
 */
async function anchorAt(
  store: PostgresChainLogStore,
  provenance?: CheckpointProvenance,
  scope: string | null = TENANT,
): Promise<ChainCheckpoint> {
  const cp = await store.createCheckpoint(scope, {
    checkpointedBy: "auditor",
    checkpointedAt: AT,
    provenance: provenance ?? "unverified",
  });
  if (provenance !== undefined) return cp;
  const asRow: Record<string, unknown> = { ...cp };
  delete asRow["provenance"];
  return ChainCheckpointSchema.parse(asRow);
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

  it("reports the fold as requested, since a direct caller asked for it", async () => {
    const { store, fingerprint, publicKeyBase64 } = await seededChain();
    const report = await verifyChainFull(store, fakeRegistry({ [fingerprint]: { publicKeyBase64 } }), TENANT);
    expect(report.mode).toBe("full");
    expect(report.fullBecause).toBe("requested");
    expect(formatChainVerification(report)).toContain("[full: requested]");
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

  it("loads the chain once for the fold, not once per check", async () => {
    // `reader.verify` and `verifyStoredChainSignatures` each load the chain, so asking both read the
    // table twice and held two whole-chain copies. A refused anchor makes this fold a scope's steady
    // state, so the second read is paid on every pass rather than rarely.
    const { store, fingerprint, publicKeyBase64 } = await seededChain();
    const loadChain = vi.spyOn(store, "loadChain");
    const report = await verifyChainFull(store, fakeRegistry({ [fingerprint]: { publicKeyBase64 } }), TENANT);
    expect(loadChain).toHaveBeenCalledTimes(1);
    // Both checks still ran over the whole chain, so the single load is not a dropped check.
    expect(report.integrity.valid).toBe(true);
    expect(report.signatures.checked).toBe(3);
  });

  it("an empty chain is vacuously OK", async () => {
    const keyStore = new InMemoryKeyStore();
    const record = await keyStore.createKey({ tenantId: null, algorithm: "ed25519", purpose: "evidence_sealing" });
    const store = new PostgresChainLogStore(fakeChainPg().conn, keyStoreChainSigner(keyStore, record, null));
    const report = await verifyChainFull(store, fakeRegistry({}), TENANT);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe("full");
    expect(report.fullBecause).toBe("requested");
    expect(report.checkpointSequence).toBeNull();
    expect(report.signatures.checked).toBe(0);
  });
});

/** Seeds 3 entries, anchors at seq 2 with `provenance`, then appends 2 more — so a bounded pass
 *  checks 2 signatures and a fold from genesis checks 5. The counts are the discriminator. */
async function anchoredChain(provenance?: CheckpointProvenance, scope: string | null = TENANT) {
  const seeded = await seededChain(3, scope);
  const checkpoint = await anchorAt(seeded.store, provenance, scope);
  await seeded.append(3);
  await seeded.append(4);
  // The spy rides along on every anchored chain rather than being a second parameter, so the scope
  // a test verifies under is always the scope its `latest()` can be asserted against.
  const latestSpy = vi.fn();
  return { ...seeded, checkpoint, latestSpy, checkpoints: fakeCheckpoints(checkpoint, latestSpy) };
}

/** The stored row at `sequence`, so a tamper is staged against a row that exists. */
function storedEntry(entries: readonly Record<string, unknown>[], sequence: number): Record<string, unknown> {
  const row = entries.find((r) => r["sequence_number"] === sequence);
  if (row === undefined) throw new Error(`no stored entry at sequence ${sequence.toString()}`);
  return row;
}

describe("verifyChainFromCheckpoint", () => {
  it("verifies only the suffix after the latest checkpoint", async () => {
    const { store, checkpoints, fingerprint, publicKeyBase64 } = await anchoredChain("verified_full");
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

  it("reports no reason for a bounded verify, because the question does not apply", async () => {
    const { store, checkpoints, fingerprint, publicKeyBase64 } = await anchoredChain("verified_full");
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      TENANT,
    );
    expect(report.fullBecause).toBeNull();
    expect(formatChainVerification(report)).not.toContain("full");
  });

  it("takes the bounded path on a suffix-verified anchor, which is sound inductively", async () => {
    const { store, checkpoints, fingerprint, publicKeyBase64 } = await anchoredChain("verified_suffix");
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      TENANT,
    );
    expect(report.mode).toBe("from_checkpoint");
    expect(report.signatures.checked).toBe(2);
  });

  it("falls back to a full verify when no checkpoint exists", async () => {
    const { conn, store, fingerprint, publicKeyBase64 } = await seededChain(3);
    // The real store over an empty checkpoint table, so the `latest() === null` arm is exercised
    // against the SQL a deployment runs rather than against a double.
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      new PostgresChainCheckpointStore(conn, {}),
      TENANT,
    );
    expect(report.mode).toBe("full");
    expect(report.fullBecause).toBe("no_checkpoint");
    expect(report.signatures.checked).toBe(3);
    expect(report.ok).toBe(true);
  });

  it("reports FAILED when a suffix signature does not resolve", async () => {
    const { store, append } = await seededChain(2);
    const checkpoint = await anchorAt(store, "verified_full");
    await append(2);

    // registry knows no keys → the one suffix entry is unresolved
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({}),
      fakeCheckpoints(checkpoint),
      TENANT,
    );
    expect(report.mode).toBe("from_checkpoint");
    expect(report.signatures.checked).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("asks for the anchor of the scope it is verifying, not whichever one a role can see", async () => {
    const { store, checkpoints, latestSpy, fingerprint, publicKeyBase64 } =
      await anchoredChain("verified_full");
    await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      TENANT,
    );
    expect(latestSpy).toHaveBeenCalledWith(TENANT);
  });

  it("asks the platform scope for the platform's own anchor, and verifies the platform suffix", async () => {
    // The platform chain is the one a cross-scope `latest()` would corrupt in the costly direction:
    // its anchor is the witness the truncation check is measured against, and until now no test
    // reached the provenance gate with `tenantId: null` at all.
    const { store, checkpoints, latestSpy, fingerprint, publicKeyBase64 } = await anchoredChain(
      "verified_full",
      null,
    );
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      null,
    );
    expect(latestSpy).toHaveBeenCalledWith(null);
    expect(report.tenantId).toBeNull();
    expect(report.mode).toBe("from_checkpoint");
    expect(report.checkpointSequence).toBe(2);
    expect(report.signatures.checked).toBe(2);
    expect(report.ok).toBe(true);
  });

  it("refuses a platform anchor that cannot vouch for its prefix, as it does a tenant's", async () => {
    const { store, checkpoints, latestSpy, fingerprint, publicKeyBase64 } = await anchoredChain(
      "unverified",
      null,
    );
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      null,
    );
    expect(latestSpy).toHaveBeenCalledWith(null);
    expect(report.mode).toBe("full");
    expect(report.fullBecause).toBe("anchor_unverified");
    expect(report.signatures.checked).toBe(5);
  });
});

describe("verifyChainFromCheckpoint refuses an anchor it cannot trust", () => {
  it("folds from genesis when the anchor records that nothing verified its prefix", async () => {
    const { store, checkpoints, fingerprint, publicKeyBase64 } = await anchoredChain("unverified");
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      TENANT,
    );
    expect(report.mode).toBe("full");
    expect(report.fullBecause).toBe("anchor_unverified");
    // 5 and not 2: the prefix the anchor could not vouch for was re-folded.
    expect(report.signatures.checked).toBe(5);
    expect(report.checkpointSequence).toBeNull();
  });

  it("folds from genesis when the anchor predates the provenance column", async () => {
    const { store, checkpoints, fingerprint, publicKeyBase64 } = await anchoredChain();
    const report = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      TENANT,
    );
    expect(report.mode).toBe("full");
    expect(report.fullBecause).toBe("anchor_provenance_absent");
    expect(report.signatures.checked).toBe(5);
  });

  it("keeps the two refusals apart, since only one of them is a finding", async () => {
    const stated = await anchoredChain("unverified");
    const absent = await anchoredChain();
    const reasonFor = async (c: Awaited<ReturnType<typeof anchoredChain>>): Promise<ChainFullReason | null> =>
      (
        await verifyChainFromCheckpoint(
          c.store,
          fakeRegistry({ [c.fingerprint]: { publicKeyBase64: c.publicKeyBase64 } }),
          c.checkpoints,
          TENANT,
        )
      ).fullBecause;
    expect(await reasonFor(stated)).not.toBe(await reasonFor(absent));
  });

  it("a declined anchor catches a prefix forgery the bounded path reports as verified", async () => {
    // The live reproduction, offline: an entry BELOW the anchor is rewritten and its
    // `payload_sha256` made consistent, leaving `entry_hash`/`prior_entry_hash` untouched. The
    // hash links still fold, so only the signature can see it — and the bounded path never asks.
    const { store, entries, checkpoint, fingerprint, publicKeyBase64 } =
      await anchoredChain("verified_full");
    const registry = fakeRegistry({ [fingerprint]: { publicKeyBase64 } });
    storedEntry(entries, 1)["payload_sha256"] = "f".repeat(64);

    // One chain, one anchor at seq 2, differing only in whether the anchor may be trusted.
    const trusted = await verifyChainFromCheckpoint(
      store,
      registry,
      fakeCheckpoints(checkpoint),
      TENANT,
    );
    const refused = await verifyChainFromCheckpoint(
      store,
      registry,
      fakeCheckpoints({ ...checkpoint, provenance: "unverified" }),
      TENANT,
    );

    // Trusting the anchor: seq 1 is below it, so the two entries read are the honest ones.
    expect(trusted.mode).toBe("from_checkpoint");
    expect(trusted.signatures.checked).toBe(2);
    expect(trusted.ok).toBe(true);
    // Refusing it: integrity still passes — the tamper is invisible to the hash links — and the
    // signature over the rewritten row is what fails.
    expect(refused.mode).toBe("full");
    expect(refused.integrity.valid).toBe(true);
    expect(refused.signatures.valid).toBe(false);
    expect(refused.ok).toBe(false);
    expect(refused.signatures.results.filter((r) => !r.ok).map((r) => r.sequenceNumber)).toEqual([1]);
  });

  it.each(CHECKPOINT_PROVENANCES)(
    "takes the bounded path for %s exactly when the keystone says the anchor may be trusted",
    async (provenance) => {
      const { store, checkpoints, fingerprint, publicKeyBase64 } = await anchoredChain(provenance);
      const report = await verifyChainFromCheckpoint(
        store,
        fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
        checkpoints,
        TENANT,
      );
      // Over the constant, and against the keystone rather than a second copy of its answer, so a
      // fourth provenance is decided here by landing rather than by somebody remembering to add it.
      expect(report.mode === "from_checkpoint").toBe(checkpointAnchorsBoundedProof(provenance));
    },
  );
});

describe("formatChainVerification", () => {
  it("names every reason, and names each of them differently", async () => {
    const { store, fingerprint, publicKeyBase64 } = await seededChain(1);
    const base = await verifyChainFull(store, fakeRegistry({ [fingerprint]: { publicKeyBase64 } }), TENANT);
    const headers = CHAIN_FULL_REASONS.map(
      (fullBecause) => formatChainVerification({ ...base, fullBecause }).split("\n")[0] ?? "",
    );
    CHAIN_FULL_REASONS.forEach((reason, i) => {
      const phrase = CHAIN_FULL_REASON_PHRASES[reason];
      // Non-emptiness first, and separately: `Record<ChainFullReason, string>` makes a *missing* key
      // a compile error and says nothing about an empty value, which renders `[full: ]` — and both a
      // bare `toContain("[full: ")` and the interpolation below are satisfied by it.
      expect(phrase).not.toBe("");
      expect(headers[i]).toContain(`[full: ${phrase}]`);
    });
    // Distinct, so the four facts an operator must tell apart are told apart on the page too.
    expect(new Set(headers).size).toBe(CHAIN_FULL_REASONS.length);
  });

  it("still reports the signature count it has always reported", async () => {
    const { store, checkpoints, fingerprint, publicKeyBase64 } = await anchoredChain("verified_full");
    const bounded = await verifyChainFromCheckpoint(
      store,
      fakeRegistry({ [fingerprint]: { publicKeyBase64 } }),
      checkpoints,
      TENANT,
    );
    expect(formatChainVerification(bounded)).toContain("signatures: valid (2 checked)");
    const full = await verifyChainFull(store, fakeRegistry({ [fingerprint]: { publicKeyBase64 } }), TENANT);
    expect(formatChainVerification(full)).toContain("signatures: valid (5 checked)");
  });

  it("prints the bare mode for a full report carrying no reason, rather than inventing one", async () => {
    const { store, fingerprint, publicKeyBase64 } = await seededChain(1);
    const base = await verifyChainFull(store, fakeRegistry({ [fingerprint]: { publicKeyBase64 } }), TENANT);
    // Unreachable from this module, which always names a reason; the type admits it, and the
    // honest rendering is the one that claims nothing.
    expect(formatChainVerification({ ...base, fullBecause: null })).toContain("[full]");
  });
});
