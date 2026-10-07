/**
 * The boot-time decision about **where a tenant's column key comes from**, and what destroying
 * it is worth.
 *
 * ADR-0338 derives the per-tenant column key from `COLUMN_ENCRYPTION_SECRET` with HKDF and
 * stores nothing, which is what made it shippable in one piece — no table, no CHECK migration,
 * no cipher in `packages/crypto`. The one thing it cannot buy is **destruction**: a derived key
 * exists wherever the secret does, so an Article 17 erasure that drops a tenant's schema leaves
 * every backup's ciphertext recoverable forever, by anyone who still holds the deployment
 * secret. ADR-0346 added AES-256-GCM; this module is the deployment half of the envelope that
 * uses it — a random data key per tenant, stored only wrapped, so destroying the row is
 * expressible.
 *
 * **What that is worth, stated correctly.** ADR-0338 recorded the envelope's gain as making a
 * tenant's PHI "unrecoverable including from backups", and that is an overclaim this increment
 * corrects. The wrapped key and the ciphertext it protects live in **one database**, so one
 * backup holds both and restoring it restores the pair. What destruction buys is a **bounded
 * deletion horizon**: afterwards the data is recoverable only from backups taken *before* the
 * destruction, and only until those expire — so the bound is the deployment's backup retention
 * rather than the destruction itself. A derived key gives no horizon at all, which is the whole
 * difference and is enough; claiming more is the falsely-true-control direction ADR-0337 found
 * in the HIPAA report, where a reassuring summary is worse than no summary.
 *
 * And it holds only for a **random** data key. A key seeded from the derived one is still
 * recomputable from `COLUMN_ENCRYPTION_SECRET`, so destroying its row destroys nothing —
 * which is why `shreddabilityOf` answers over the *pair* and not with a boolean, and why
 * `formatShreddability` says so in the one place an operator reads.
 *
 * This module performs no encryption, issues no SQL and never reads the environment. The
 * secret arrives already parsed, `PostgresDataKeyStore` owns the row, and `@crossengin/crypto`
 * owns the wrap.
 */

import { dataKeyToColumnKey, deriveTenantColumnKey } from "@crossengin/crypto";
import type { DataKeyProvenance, PostgresDataKeyStore } from "@crossengin/crypto-pg";
import type { ColumnEncryptionKeySource } from "@crossengin/operate-runtime-pg";

import { COLUMN_ENCRYPTION_SECRET_VAR } from "./column-encryption.js";

/**
 * The flag naming the mode, kept in the module that owns the feature so a refusal cannot name
 * a flag the CLI does not parse — `ALLOW_CURSOR_DISCLOSURE_FLAG`'s rule, and `COLUMN_KEY_MODES`
 * beside it is the single source of what the flag accepts.
 */
export const COLUMN_KEY_MODE_FLAG = "--column-key-mode";

export const COLUMN_KEY_MODES = ["derived", "envelope"] as const;
export type ColumnKeyMode = (typeof COLUMN_KEY_MODES)[number];

export const DATA_KEY_SHREDDABILITY = ["shreddable", "derivable", "not_applicable"] as const;
export type DataKeyShreddability = (typeof DATA_KEY_SHREDDABILITY)[number];

/**
 * Whether a tenant may already hold column ciphertext written under the derived key.
 *
 * Asked **once per tenant**, immediately before that tenant's data key row is first created,
 * because it is the only moment at which the answer can still change anything: `ensure` is
 * idempotent and a row that exists ignores a seed.
 */
export type TenantCiphertextProbe = (tenantId: string) => Promise<boolean>;

/**
 * One line per mode, as a **total map** so a third mode is a compile error rather than a mode
 * inheriting whichever branch a chain ended on (`MODE_DETAIL`'s shape in `cursor-encryption.ts`).
 *
 * `envelope` deliberately does not claim the key is random. Whether destroying a tenant's row
 * destroys anything is a property of **that row**, not of the mode — a tenant migrated into the
 * envelope while already holding ciphertext is seeded — so the mode line points at the
 * shreddability line rather than answering for it.
 */
const MODE_DETAIL: Readonly<Record<ColumnKeyMode, string>> = {
  derived:
    `the per-tenant column key is derived from ${COLUMN_ENCRYPTION_SECRET_VAR} on every use and ` +
    `stored nowhere, so there is no row to destroy and an erasure bounds nothing`,
  envelope:
    `the per-tenant column key is a data key stored only wrapped, under a key-encryption key ` +
    `derived from ${COLUMN_ENCRYPTION_SECRET_VAR}, so destroying a tenant's row is expressible — ` +
    `whether it destroys anything is that row's provenance, not this mode`,
};

/**
 * What the mode alone settles.
 *
 * `null` is not "unknown": it says the mode *has* a stored row and the row's provenance is what
 * decides, which is the distinction this pair exists to keep. A total map for `MODE_DETAIL`'s
 * reason, and the direction that matters is that an unconsidered mode must not answer
 * `shreddable`.
 */
const MODE_SHREDDABILITY: Readonly<Record<ColumnKeyMode, DataKeyShreddability | null>> = {
  derived: "not_applicable",
  envelope: null,
};

/** Total over the provenances, so a third one is a compile error rather than a silent claim. */
const PROVENANCE_SHREDDABILITY: Readonly<Record<DataKeyProvenance, DataKeyShreddability>> = {
  random: "shreddable",
  seeded_from_derived: "derivable",
};

/**
 * The shreddability of one tenant's column key, over the **pair** `(mode, provenance)`.
 *
 * Three answers rather than a boolean because the three are different facts an operator acts on
 * differently: there is no row at all, there is a row whose destruction bounds the horizon, and
 * there is a row whose destruction bounds nothing and wants a rekey.
 *
 * An `envelope` mode with no provenance in hand answers **`derivable`**, the conservative
 * direction: the two mistakes are not symmetric, since claiming `shreddable` for a key that is
 * recomputable tells a deployment its Article 17 erasure bounded a horizon it did not, while
 * claiming `derivable` for a random key costs at worst an unnecessary rekey. A provenance passed
 * with `derived` is ignored, because in that mode there is no row for it to describe.
 */
export function shreddabilityOf(
  mode: ColumnKeyMode,
  provenance?: DataKeyProvenance,
): DataKeyShreddability {
  const settledByMode = MODE_SHREDDABILITY[mode];
  if (settledByMode !== null) return settledByMode;
  if (provenance === undefined) return "derivable";
  return PROVENANCE_SHREDDABILITY[provenance];
}

/**
 * One line per shreddability, and this map is where the corrected claim lives.
 *
 * `shreddable` states the **bound** and nothing more: recoverable only from backups predating
 * the destruction, only until those expire, and the bound is the deployment's backup retention.
 * It must never read "including from backups" — the wrapped key and the ciphertext share one
 * database, so one backup holds both.
 *
 * `derivable` names the remedy, because a line reporting a condition an operator cannot act on
 * is a line they learn to skip.
 */
const SHREDDABILITY_DETAIL: Readonly<Record<DataKeyShreddability, string>> = {
  shreddable:
    `this tenant's data key is random and stored only wrapped, so destroying its row bounds the ` +
    `deletion horizon: the column ciphertext is then recoverable only from backups taken before ` +
    `the destruction, and only until those expire — the bound is this deployment's backup ` +
    `retention, not the destruction itself`,
  derivable:
    `this tenant's data key was seeded from the key derived from ${COLUMN_ENCRYPTION_SECRET_VAR}, ` +
    `so destroying its row destroys nothing — the same key stays recomputable from the deployment ` +
    `secret. Rekeying the tenant under a random data key is what makes a destruction mean anything`,
  not_applicable:
    `no data key row exists for this tenant: the column key is derived from ` +
    `${COLUMN_ENCRYPTION_SECRET_VAR} per tenant and stored nowhere, so there is nothing to destroy ` +
    `and no deletion horizon at all — the key exists wherever the deployment secret does`,
};

/** The boot line. Carries the mode first, because that is what an operator greps for. */
export function formatColumnKeyMode(mode: ColumnKeyMode): string {
  return `column key mode: ${mode} — ${MODE_DETAIL[mode]}`;
}

/** The companion line, carrying the verdict first for the same reason. */
export function formatShreddability(s: DataKeyShreddability): string {
  return `data key shreddability: ${s} — ${SHREDDABILITY_DETAIL[s]}`;
}

/**
 * The seed that keeps a migrating tenant's existing ciphertext readable: the **bytes** of the
 * key ADR-0338 wrote that ciphertext under, so `dataKeyToColumnKey` of the stored data key
 * renders the identical pgcrypto key.
 *
 * Decoded from `deriveTenantColumnKey`'s base64 rather than derived a second way, so there is
 * one definition of that key and no second derivation to drift from it — the reason
 * `dataKeyToColumnKey` is itself a named function.
 *
 * The generation is the default, deliberately and not as an omission: it is the generation every
 * existing ciphertext was written under, because no flag or environment variable exposes another
 * one and `KeyRotationMigrator` has no executor, so a tenant's ciphertext cannot be under any
 * other.
 */
function derivedSeed(secret: Uint8Array, tenantId: string): Uint8Array {
  return new Uint8Array(Buffer.from(deriveTenantColumnKey(secret, tenantId), "base64"));
}

async function resolveColumnKey(
  store: PostgresDataKeyStore,
  secret: Uint8Array,
  mayHoldCiphertext: TenantCiphertextProbe,
  tenantId: string,
): Promise<string> {
  // The seed decision, and the only irreversible one here. Seeding a tenant that holds no
  // ciphertext costs **shreddability** — the row records `seeded_from_derived` and destroying it
  // bounds nothing until a rekey. Randomising a tenant that *does* hold ciphertext makes that
  // ciphertext **permanently unreadable**, because nothing records which key wrote a given
  // column. So the two errors are not symmetric and a probe that is wrong must be wrong towards
  // `true`; the caller's probe is conservative in exactly that direction, answering `true` both
  // for a tenant whose schema merely exists and when the probe itself fails.
  if (await mayHoldCiphertext(tenantId)) {
    return dataKeyToColumnKey(
      (await store.ensure(tenantId, { seed: derivedSeed(secret, tenantId) })).dek,
    );
  }
  // No seed, so the store generates a random data key and the row records `random` — the only
  // provenance for which destroying the row is worth anything.
  return dataKeyToColumnKey((await store.ensure(tenantId)).dek);
}

/**
 * The per-tenant key source `ColumnMappedEntityStore` calls inside each transaction, resolved
 * from the stored envelope rather than derived.
 *
 * `ColumnEncryptionKeySource` has been async-capable since it was written, and its own doc names
 * "a KMS unwrap, a per-tenant DEK row" as the reason — this is that reason arriving.
 *
 * **The cache is the point.** `buildColumnKeySource` caches a derivation that is already cheap,
 * because it runs on every transaction touching an encrypted column; here the same call is a
 * **database round trip**, so a cache hit is the difference between one read per tenant and one
 * read per write. Keyed on the tenant id alone for that function's stated reason: a generation is
 * fixed for the life of one source, so a rotation is a new source rather than an invalidation.
 *
 * **The promise is cached, not the resolved value.** N concurrent writes for a cold tenant would
 * otherwise each reach `ensure`, which is the burst `fcm-token.ts`'s in-flight promise exists to
 * collapse — and here a concurrent burst is not merely wasteful, it is N callers racing to create
 * one tenant's first row. A **rejection is not remembered**: the entry is deleted on failure, so
 * the next caller retries rather than inheriting a transient database error as a permanently dead
 * tenant.
 *
 * **Nothing is caught.** A `DataKeyUnwrapFailed` means a wrong key-encryption key or a corrupted
 * row, and the available fallback — deriving instead — would write new columns under a second key
 * with nothing recording which row used which, splitting one tenant's ciphertext irreversibly. A
 * refused write is recoverable; that is not. `dataKeyToColumnKey` throws on a wrong-length data
 * key for the same grade of reason: `pgp_sym_encrypt` takes a key of any length, so a short key
 * rendered to base64 would encrypt PHI weakly and report success. Both are deployment-grade
 * faults, and the honest answer to one is a refused request rather than a served wrong key.
 *
 * The one limitation, said rather than left to be discovered: **destroying a tenant's data key
 * leaves a stale cache entry**, and this source would go on serving the destroyed key from
 * memory. It is harmless because a destruction happens inside the Article 17 pipeline, which
 * retires the tenant row in the same transaction (ADR-0319, ADR-0320) — nothing serves that
 * tenant afterwards, and `--tenant-status-gate` refuses it at the edge. A destruction reachable
 * outside that pipeline would need an eviction.
 *
 * The secret is taken **as bytes already parsed**, not as a raw string: `parseColumnEncryptionSecret`
 * is the only producer of acceptable bytes, so the eager refusal `buildColumnKeySource` performs
 * has already happened at the one site that also feeds the store's `kekFor`. Parsing again here
 * would be a second place for the deployment secret to enter, which is the thing a single parse
 * exists to prevent.
 */
export function buildEnvelopeKeySource(input: {
  readonly store: PostgresDataKeyStore;
  readonly secret: Uint8Array;
  readonly mayHoldCiphertext: TenantCiphertextProbe;
}): ColumnEncryptionKeySource {
  const { store, secret, mayHoldCiphertext } = input;
  const cache = new Map<string, Promise<string>>();
  return (tenantId: string): Promise<string> => {
    const hit = cache.get(tenantId);
    if (hit !== undefined) return hit;
    const resolving = resolveColumnKey(store, secret, mayHoldCiphertext, tenantId).catch(
      (error: unknown) => {
        cache.delete(tenantId);
        throw error;
      },
    );
    cache.set(tenantId, resolving);
    return resolving;
  };
}
