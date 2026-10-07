import {
  dataKeyToColumnKey,
  deriveTenantColumnKey,
  parseColumnEncryptionSecret,
} from "@crossengin/crypto";
import {
  DATA_KEY_PROVENANCES,
  DataKeyUnwrapFailed,
  type DataKeyProvenance,
  type PostgresDataKeyStore,
  type StoredDataKey,
} from "@crossengin/crypto-pg";
import { describe, expect, it } from "vitest";

import {
  COLUMN_KEY_MODES,
  COLUMN_KEY_MODE_FLAG,
  DATA_KEY_SHREDDABILITY,
  buildEnvelopeKeySource,
  formatColumnKeyMode,
  formatShreddability,
  shreddabilityOf,
  type ColumnKeyMode,
  type DataKeyShreddability,
} from "./data-key-envelope.js";

/** 36 bytes, 20 distinct — comfortably past both of the parser's floors. */
const RAW_SECRET = "0123456789abcdefghij0123456789abcdef";
const SECRET = parseColumnEncryptionSecret(RAW_SECRET);
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

/** A recognisable 32-byte data key, so a leak into a log line would be greppable. */
const RANDOM_DEK = new Uint8Array(32).fill(0xab);

interface EnsureCall {
  readonly tenantId: string;
  readonly options: { readonly seed?: Uint8Array } | undefined;
}

interface FakeStore {
  readonly ensureCalls: readonly EnsureCall[];
  readonly store: PostgresDataKeyStore;
}

/**
 * A hand-written stand-in for `PostgresDataKeyStore`. Nothing here touches SQL, and the cast is
 * `audit-chain.test.ts`'s established spelling for a store whose private fields would otherwise
 * defeat structural assignability.
 *
 * It honours the seed — returning it as the stored key — because that is what the real store does
 * and it lets one assertion carry the whole migration property: the column key a seeded tenant
 * gets back is byte-identical to the one ADR-0338 wrote its ciphertext under.
 */
function fakeStore(
  behaviour: {
    readonly fail?: () => unknown;
    readonly failTimes?: number;
    readonly dek?: Uint8Array;
  } = {},
): FakeStore {
  const ensureCalls: EnsureCall[] = [];
  let failuresLeft = behaviour.fail === undefined ? 0 : (behaviour.failTimes ?? Infinity);
  const fail = behaviour.fail;
  const store = {
    ensure: async (
      tenantId: string,
      options?: { readonly seed?: Uint8Array },
    ): Promise<StoredDataKey> => {
      ensureCalls.push({ tenantId, options });
      // Yield once, so a concurrent burst genuinely overlaps rather than resolving inside the
      // first caller's synchronous frame — which would let a value cache pass this test.
      await Promise.resolve();
      if (fail !== undefined && failuresLeft > 0) {
        failuresLeft -= 1;
        throw fail();
      }
      const seed = options?.seed;
      return {
        tenantId,
        generation: 1,
        kekGeneration: 1,
        provenance: seed === undefined ? "random" : "seeded_from_derived",
        dek: seed ?? behaviour.dek ?? RANDOM_DEK,
      };
    },
    load: async (): Promise<StoredDataKey | null> => null,
    destroy: async (): Promise<number> => 0,
  };
  return { ensureCalls, store: store as unknown as PostgresDataKeyStore };
}

function countingProbe(answer: boolean): {
  readonly tenants: readonly string[];
  readonly probe: (tenantId: string) => Promise<boolean>;
} {
  const tenants: string[] = [];
  return {
    tenants,
    probe: async (tenantId: string): Promise<boolean> => {
      tenants.push(tenantId);
      return answer;
    },
  };
}

describe("COLUMN_KEY_MODE_FLAG", () => {
  it("is exactly the flag the CLI parses", () => {
    expect(COLUMN_KEY_MODE_FLAG).toBe("--column-key-mode");
  });
});

describe("COLUMN_KEY_MODES", () => {
  it("lists the two modes in a stable order", () => {
    expect(COLUMN_KEY_MODES).toEqual(["derived", "envelope"]);
  });

  it("has no duplicates", () => {
    expect(new Set(COLUMN_KEY_MODES).size).toBe(COLUMN_KEY_MODES.length);
  });
});

describe("DATA_KEY_SHREDDABILITY", () => {
  it("lists the three answers in a stable order", () => {
    expect(DATA_KEY_SHREDDABILITY).toEqual(["shreddable", "derivable", "not_applicable"]);
  });

  it("has no duplicates", () => {
    expect(new Set(DATA_KEY_SHREDDABILITY).size).toBe(DATA_KEY_SHREDDABILITY.length);
  });
});

describe("shreddabilityOf", () => {
  it("answers every mode/provenance pair", () => {
    const answered: Record<string, DataKeyShreddability> = {};
    for (const mode of COLUMN_KEY_MODES) {
      for (const provenance of DATA_KEY_PROVENANCES) {
        answered[`${mode}/${provenance}`] = shreddabilityOf(mode, provenance);
      }
      answered[`${mode}/absent`] = shreddabilityOf(mode);
    }
    expect(answered).toEqual({
      "derived/random": "not_applicable",
      "derived/seeded_from_derived": "not_applicable",
      "derived/absent": "not_applicable",
      "envelope/random": "shreddable",
      "envelope/seeded_from_derived": "derivable",
      "envelope/absent": "derivable",
    });
  });

  it("only ever answers a member of the enum", () => {
    for (const mode of COLUMN_KEY_MODES) {
      for (const provenance of [...DATA_KEY_PROVENANCES, undefined]) {
        expect(DATA_KEY_SHREDDABILITY).toContain(shreddabilityOf(mode, provenance));
      }
    }
  });

  it("reaches all three answers, so neither map is constant", () => {
    const reached = new Set<DataKeyShreddability>();
    for (const mode of COLUMN_KEY_MODES) {
      for (const provenance of DATA_KEY_PROVENANCES) reached.add(shreddabilityOf(mode, provenance));
    }
    expect([...reached].sort()).toEqual([...DATA_KEY_SHREDDABILITY].sort());
  });

  it("ignores a provenance in derived mode, where there is no row to describe", () => {
    for (const provenance of DATA_KEY_PROVENANCES) {
      expect(shreddabilityOf("derived", provenance)).toBe("not_applicable");
    }
  });

  it("answers derivable for an envelope with no provenance, the conservative direction", () => {
    // Claiming `shreddable` without the row in hand would tell a deployment its erasure bounded a
    // horizon it did not; claiming `derivable` for a random key costs at worst a needless rekey.
    expect(shreddabilityOf("envelope")).toBe("derivable");
    expect(shreddabilityOf("envelope")).not.toBe("shreddable");
  });

  it("calls only a random envelope key shreddable", () => {
    const shreddable = COLUMN_KEY_MODES.flatMap((mode: ColumnKeyMode) =>
      DATA_KEY_PROVENANCES.filter(
        (p: DataKeyProvenance) => shreddabilityOf(mode, p) === "shreddable",
      ).map((p: DataKeyProvenance) => `${mode}/${p}`),
    );
    expect(shreddable).toEqual(["envelope/random"]);
  });
});

describe("formatColumnKeyMode", () => {
  it("leads with the mode, which is what an operator greps for", () => {
    for (const mode of COLUMN_KEY_MODES) {
      expect(formatColumnKeyMode(mode)).toMatch(new RegExp(`^column key mode: ${mode} — `));
    }
  });

  it("gives each mode its own non-empty detail", () => {
    const lines = COLUMN_KEY_MODES.map((mode) => formatColumnKeyMode(mode));
    expect(new Set(lines).size).toBe(COLUMN_KEY_MODES.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(60);
  });

  it("says the derived mode stores nothing and bounds nothing", () => {
    const line = formatColumnKeyMode("derived");
    expect(line).toContain("stored nowhere");
    expect(line).toContain("COLUMN_ENCRYPTION_SECRET");
  });

  it("does not claim an envelope key is random, which is the row's property and not the mode's", () => {
    const line = formatColumnKeyMode("envelope");
    expect(line).toContain("wrapped");
    expect(line).toContain("provenance");
    expect(line).not.toContain("random");
  });
});

describe("formatShreddability", () => {
  it("leads with the verdict", () => {
    for (const s of DATA_KEY_SHREDDABILITY) {
      expect(formatShreddability(s)).toMatch(new RegExp(`^data key shreddability: ${s} — `));
    }
  });

  it("gives each answer its own non-empty detail", () => {
    const lines = DATA_KEY_SHREDDABILITY.map((s) => formatShreddability(s));
    expect(new Set(lines).size).toBe(DATA_KEY_SHREDDABILITY.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(60);
  });

  it("states the bound for shreddable: backups predating the destruction, until those expire", () => {
    const line = formatShreddability("shreddable");
    expect(line).toContain("backups taken before");
    expect(line).toContain("until those expire");
    expect(line).toContain("backup retention");
  });

  it("never claims destruction reaches backups", () => {
    // ADR-0338 overclaimed exactly this, and the wrapped key and the ciphertext share one
    // database — so one backup holds both. A future edit restoring the claim fails here.
    for (const s of DATA_KEY_SHREDDABILITY) {
      const line = formatShreddability(s).toLowerCase();
      expect(line).not.toContain("including from backups");
      expect(line).not.toContain("unrecoverable");
    }
  });

  it("says a derivable key is recomputable and names the rekey remedy", () => {
    const line = formatShreddability("derivable");
    expect(line).toContain("destroys nothing");
    expect(line).toContain("recomputable");
    expect(line).toContain("COLUMN_ENCRYPTION_SECRET");
    expect(line).toMatch(/[Rr]ekey/);
    expect(line).toContain("random data key");
  });

  it("says not_applicable has no row and so no horizon at all", () => {
    const line = formatShreddability("not_applicable");
    expect(line).toContain("no data key row");
    expect(line).toContain("no deletion horizon");
  });
});

describe("buildEnvelopeKeySource", () => {
  it("returns the base64 of the stored data key", async () => {
    const { store } = fakeStore();
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(false).probe,
    });
    await expect(source(TENANT_A)).resolves.toBe(dataKeyToColumnKey(RANDOM_DEK));
  });

  it("calls ensure once for N sequential calls", async () => {
    const { store, ensureCalls } = fakeStore();
    const probe = countingProbe(false);
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: probe.probe,
    });
    for (let i = 0; i < 5; i += 1) await source(TENANT_A);
    expect(ensureCalls).toHaveLength(1);
    expect(probe.tenants).toEqual([TENANT_A]);
  });

  it("calls ensure once for N concurrent calls", async () => {
    // The promise is cached, not the resolved value: a value cache would let all five callers
    // past the miss before the first one resolved.
    const { store, ensureCalls } = fakeStore();
    const probe = countingProbe(false);
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: probe.probe,
    });
    const keys = await Promise.all([
      source(TENANT_A),
      source(TENANT_A),
      source(TENANT_A),
      source(TENANT_A),
      source(TENANT_A),
    ]);
    expect(ensureCalls).toHaveLength(1);
    expect(probe.tenants).toEqual([TENANT_A]);
    expect(new Set(keys).size).toBe(1);
  });

  it("does not poison the cache with a rejection", async () => {
    const { store, ensureCalls } = fakeStore({
      fail: () => new Error("transient"),
      failTimes: 1,
    });
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(false).probe,
    });
    await expect(source(TENANT_A)).rejects.toThrow("transient");
    await expect(source(TENANT_A)).resolves.toBe(dataKeyToColumnKey(RANDOM_DEK));
    expect(ensureCalls).toHaveLength(2);
  });

  it("does not poison the cache for concurrent callers of a failing tenant", async () => {
    // `failTimes: 1` and not 2, which is the whole point of the test and was worth getting wrong
    // once: the two concurrent callers **share one in-flight `ensure`**, so the pair consumes a
    // single failure between them. Arming two would leave the second for the retry below and the
    // test would assert the opposite of what it claims — so the figure is itself evidence that the
    // promise is cached rather than the resolved value.
    const { store, ensureCalls } = fakeStore({ fail: () => new Error("transient"), failTimes: 1 });
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(false).probe,
    });
    const settled = await Promise.allSettled([source(TENANT_A), source(TENANT_A)]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(ensureCalls).toHaveLength(1);
    await expect(source(TENANT_A)).resolves.toBe(dataKeyToColumnKey(RANDOM_DEK));
    expect(ensureCalls).toHaveLength(2);
  });

  it("passes the derived key as the seed when the tenant may hold ciphertext", async () => {
    const { store, ensureCalls } = fakeStore();
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(true).probe,
    });
    const key = await source(TENANT_A);

    // The argument the store received is the data-safety decision, so it is asserted directly
    // rather than only through the key that comes back.
    expect(ensureCalls).toHaveLength(1);
    const seed = ensureCalls[0]?.options?.seed;
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed === undefined ? null : dataKeyToColumnKey(seed)).toBe(
      deriveTenantColumnKey(SECRET, TENANT_A),
    );

    // And the whole migration property in one line: a seeded tenant's column key is byte-identical
    // to the one ADR-0338 wrote its existing ciphertext under.
    expect(key).toBe(deriveTenantColumnKey(SECRET, TENANT_A));
  });

  it("passes no seed when the tenant cannot hold ciphertext", async () => {
    const { store, ensureCalls } = fakeStore();
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(false).probe,
    });
    await source(TENANT_A);
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]?.options?.seed).toBeUndefined();
  });

  it("seeds per tenant, so one tenant's seed is never another's derived key", async () => {
    const { store, ensureCalls } = fakeStore();
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(true).probe,
    });
    await source(TENANT_A);
    await source(TENANT_B);
    const seeds = ensureCalls.map((c) => c.options?.seed);
    expect(seeds.every((s) => s !== undefined)).toBe(true);
    expect(dataKeyToColumnKey(seeds[0] ?? RANDOM_DEK)).toBe(
      deriveTenantColumnKey(SECRET, TENANT_A),
    );
    expect(dataKeyToColumnKey(seeds[1] ?? RANDOM_DEK)).toBe(
      deriveTenantColumnKey(SECRET, TENANT_B),
    );
  });

  it("gives different tenants different keys from separate cache entries", async () => {
    const { store, ensureCalls } = fakeStore();
    const probe = countingProbe(true);
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: probe.probe,
    });
    const a = await source(TENANT_A);
    const b = await source(TENANT_B);
    expect(a).not.toBe(b);
    expect(ensureCalls.map((c) => c.tenantId)).toEqual([TENANT_A, TENANT_B]);

    await source(TENANT_A);
    await source(TENANT_B);
    expect(ensureCalls).toHaveLength(2);
    expect(probe.tenants).toEqual([TENANT_A, TENANT_B]);
  });

  it("propagates a DataKeyUnwrapFailed rather than falling back to a derived key", async () => {
    const { store } = fakeStore({ fail: () => new DataKeyUnwrapFailed(TENANT_A, 1) });
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(false).probe,
    });
    // Serving a derived key instead would split this tenant's ciphertext across two keys with
    // nothing recording which row used which — so the class must arrive unswallowed, every time.
    await expect(source(TENANT_A)).rejects.toBeInstanceOf(DataKeyUnwrapFailed);
    await expect(source(TENANT_A)).rejects.toBeInstanceOf(DataKeyUnwrapFailed);
  });

  it("propagates a wrong-length data key rather than encrypting PHI under a weak one", async () => {
    // `pgp_sym_encrypt` takes a key of any length, so `dataKeyToColumnKey` throws rather than
    // rendering a short key to base64 and reporting success. That is a deployment-grade fault and
    // is not caught here either.
    const { store } = fakeStore({ dek: new Uint8Array(16).fill(0xcd) });
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: countingProbe(false).probe,
    });
    await expect(source(TENANT_A)).rejects.toThrow();
  });

  it("propagates a probe failure without creating a row", async () => {
    const { store, ensureCalls } = fakeStore();
    const source = buildEnvelopeKeySource({
      store,
      secret: SECRET,
      mayHoldCiphertext: async (): Promise<boolean> => {
        throw new Error("probe unavailable");
      },
    });
    await expect(source(TENANT_A)).rejects.toThrow("probe unavailable");
    expect(ensureCalls).toHaveLength(0);
  });
});

describe("no key material reaches a line this module formats", () => {
  it("names no secret, derived key or data key", () => {
    const lines = [
      ...COLUMN_KEY_MODES.map((mode: ColumnKeyMode) => formatColumnKeyMode(mode)),
      ...DATA_KEY_SHREDDABILITY.map((s: DataKeyShreddability) => formatShreddability(s)),
    ];
    const forbidden = [
      RAW_SECRET,
      Buffer.from(SECRET).toString("base64"),
      dataKeyToColumnKey(RANDOM_DEK),
      deriveTenantColumnKey(SECRET, TENANT_A),
      deriveTenantColumnKey(SECRET, TENANT_B),
    ];
    for (const line of lines) {
      for (const value of forbidden) expect(line).not.toContain(value);
    }
  });

  it("names the environment variable rather than reading it", () => {
    const mentioning = [
      formatColumnKeyMode("derived"),
      formatColumnKeyMode("envelope"),
      formatShreddability("derivable"),
      formatShreddability("not_applicable"),
    ];
    for (const line of mentioning) expect(line).toContain("COLUMN_ENCRYPTION_SECRET");
  });
});

describe("DATA_KEY_PROVENANCES", () => {
  it("is the set shreddabilityOf is total over", () => {
    const provenances: readonly DataKeyProvenance[] = DATA_KEY_PROVENANCES;
    expect([...provenances].sort()).toEqual(["random", "seeded_from_derived"]);
  });
});
