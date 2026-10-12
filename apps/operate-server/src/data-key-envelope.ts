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

/**
 * How long a resolved column key is served from memory.
 *
 * ADR-0347 cached the promise with no expiry and said the limitation out loud: destroying a
 * tenant's data key leaves a stale entry behind. A **rekey** makes that limitation reachable in the
 * worse direction, because the key does not disappear — it *changes*, and a process still serving
 * the previous one goes on writing new ciphertext under it, splitting one tenant's columns across
 * two keys with nothing on any row recording which. So the cache gets a bound.
 *
 * 30s is `CachedTenantStatusDirectory`'s own figure rather than a new number, and for the same
 * reason: both cache a fact about a tenant that a maintenance action changes **out of process**, so
 * the TTL is how long that action takes to bite.
 *
 * It bounds the window and does not close it. Closing it would need the serving process to be told,
 * which is a different increment; until then the operator is told instead, by the rekey's own
 * `formatStaleKeyWindow` line.
 */
export const DEFAULT_COLUMN_KEY_TTL_MS = 30_000;

/** The flag naming it, in the module that owns the feature — `COLUMN_KEY_MODE_FLAG`'s rule. */
export const COLUMN_KEY_TTL_FLAG = "--column-key-ttl-ms";

/**
 * The range the flag accepts, refused out of band rather than clamped (`--max-request-body`'s rule,
 * and `--tenant-status-ttl-ms`' bounds to the millisecond).
 *
 * The floor is not cosmetic: the TTL is the only thing standing between a rekey and a second key
 * being written by a replica, and a value under a second makes the cache a per-request round trip
 * on the PHI write path — which is the cost `buildEnvelopeKeySource`'s cache exists to avoid, so a
 * deployment setting it there has almost certainly mistaken the unit.
 */
export const COLUMN_KEY_TTL_BOUNDS = { min: 1_000, max: 300_000 } as const;

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
 * existing ciphertext was written under, and no flag or environment variable exposes another one.
 *
 * `KeyRotationMigrator` has a caller now, so the clause that used to carry this claim — "and the
 * migrator has no executor" — no longer does. What keeps it true is that a **rekey mints a new
 * data key generation, not a new HKDF generation**: the seed is wanted only for ciphertext written
 * before any envelope row existed, which is by definition under the derived key's default
 * generation, and `ensure` ignores a seed for a tenant whose row exists — so a rekeyed tenant is
 * never seeded again.
 */
function derivedSeed(secret: Uint8Array, tenantId: string): Uint8Array {
  return new Uint8Array(Buffer.from(deriveTenantColumnKey(secret, tenantId), "base64"));
}

/**
 * The key and the **row's** provenance, which is not the same fact as the probe's answer: `ensure`
 * is idempotent and a row that exists ignores the seed, so a tenant probed `true` whose row is
 * already `random` is `random`. Reporting the probe's answer instead would be a claim about what
 * this process asked for rather than about what the deployment holds — and ADR-0347's open end is
 * precisely that nothing reads a *real* provenance.
 */
interface ResolvedColumnKey {
  readonly key: string;
  readonly provenance: DataKeyProvenance;
}

async function resolveColumnKey(
  store: PostgresDataKeyStore,
  secret: Uint8Array,
  mayHoldCiphertext: TenantCiphertextProbe,
  tenantId: string,
): Promise<ResolvedColumnKey> {
  // The seed decision, and the only irreversible one here. Seeding a tenant that holds no
  // ciphertext costs **shreddability** — the row records `seeded_from_derived` and destroying it
  // bounds nothing until a rekey. Randomising a tenant that *does* hold ciphertext makes that
  // ciphertext **permanently unreadable**, because nothing records which key wrote a given
  // column. So the two errors are not symmetric and a probe that is wrong must be wrong towards
  // `true`; the caller's probe is conservative in exactly that direction, answering `true` both
  // for a tenant whose schema merely exists and when the probe itself fails.
  if (await mayHoldCiphertext(tenantId)) {
    const seeded = await store.ensure(tenantId, { seed: derivedSeed(secret, tenantId) });
    return { key: dataKeyToColumnKey(seeded.dek), provenance: seeded.provenance };
  }
  // No seed, so the store generates a random data key and the row records `random` — the only
  // provenance for which destroying the row is worth anything.
  const fresh = await store.ensure(tenantId);
  return { key: dataKeyToColumnKey(fresh.dek), provenance: fresh.provenance };
}

/**
 * Hands one cold resolution's provenance to the deployment's reporter, and **swallows a throw**.
 *
 * The only catch in this module, and it is the opposite of the rule below it for a stated reason:
 * this callback is a log line, so failing a PHI write to protect a boot-time report would refuse
 * the very thing the key exists to serve. Everything else here propagates.
 */
function reportResolution(
  onResolved: ((tenantId: string, provenance: DataKeyProvenance) => void) | undefined,
  tenantId: string,
  provenance: DataKeyProvenance,
): void {
  if (onResolved === undefined) return;
  try {
    onResolved(tenantId, provenance);
  } catch {
    // Deliberately silent: a reporter that cannot report is not a reason to refuse a write, and
    // this module has no logger of its own to complain through.
  }
}

/**
 * One tenant's resolved key with the instant the resolution **started**.
 *
 * `at` is the start and not the completion, so a resolution that takes longer than the TTL expires
 * immediately rather than earning a fresh window from its own slowness — the conservative
 * direction, since the hazard the TTL bounds is an old key still being written with.
 */
interface ColumnKeyCacheEntry {
  readonly at: number;
  readonly resolving: Promise<string>;
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
 * read per write. Keyed on the tenant id alone, which is not `buildColumnKeySource`'s reason: there
 * the generation is pinned at construction, so a rotation genuinely *is* a new source. Here the
 * generation is whatever the tenant's row holds, and a rekey changes it under a live process — so
 * the key is not fixed for the life of the source and the TTL below is what keeps the entry from
 * outliving the row it came from.
 *
 * **The promise is cached, not the resolved value.** N concurrent writes for a cold tenant would
 * otherwise each reach `ensure`, which is the burst `fcm-token.ts`'s in-flight promise exists to
 * collapse — and here a concurrent burst is not merely wasteful, it is N callers racing to create
 * one tenant's first row. A **rejection is not remembered**: the entry is deleted on failure, so
 * the next caller retries rather than inheriting a transient database error as a permanently dead
 * tenant.
 *
 * **Nothing on the resolution path is caught** — `reportResolution` is the one exception and says
 * why in its own place. A `DataKeyUnwrapFailed` means a wrong key-encryption key or a corrupted
 * row, and the available fallback — deriving instead — would write new columns under a second key
 * with nothing recording which row used which, splitting one tenant's ciphertext irreversibly. A
 * refused write is recoverable; that is not. `dataKeyToColumnKey` throws on a wrong-length data
 * key for the same grade of reason: `pgp_sym_encrypt` takes a key of any length, so a short key
 * rendered to base64 would encrypt PHI weakly and report success. Both are deployment-grade
 * faults, and the honest answer to one is a refused request rather than a served wrong key.
 *
 * **The cache is bounded, and the bound is the honest limitation.** ADR-0347 cached the promise
 * with no expiry and argued the stale entry was harmless, because a destruction happens inside the
 * Article 17 pipeline, "which retires the tenant row in the same transaction (ADR-0319,
 * ADR-0320)". That argument is wrong twice over. ADR-0320 has a section headed *"The tenant row is
 * retired **after** the pipeline commits"* and lists retiring it inside the transaction as
 * **rejected** — the audit row's `tenant_id` references `meta.tenants`, so retiring first makes the
 * erasure unrecordable. And both legs are conditional anyway: the retirement runs in a `try`/`catch`
 * that reports `tenantRetired: false` on a **200**, and `--tenant-status-gate` is opt-in and off by
 * default.
 *
 * A **rekey** then makes the same staleness reachable in the direction that loses data. A
 * destruction leaves a key that opens nothing, so a stale entry's reads raise — loud, and never a
 * wrong answer. A rekey *changes* the key, so a process still serving the previous one reads with a
 * raise and **writes** new ciphertext under the old key, splitting this tenant's columns across two
 * keys with nothing on any row recording which. `DEFAULT_COLUMN_KEY_TTL_MS` bounds that window; it
 * does not close it, because closing it would need the serving process to be told. Until then the
 * rekey says so to the operator, through `formatStaleKeyWindow`.
 *
 * **`onResolved` is how a real provenance finally gets read.** `resolveColumnKey` used to discard
 * `StoredDataKey.provenance`, which is why `formatShreddability` — the function this doc calls the
 * one place an operator reads — had no caller in any deployment, and why ADR-0347's third open end
 * says nothing reads a real provenance. It fires **once per cold resolution**, not per call, so it
 * is a line per tenant rather than a line per write.
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
  /** Defaults to `DEFAULT_COLUMN_KEY_TTL_MS`. The CLI bounds it; this function does not. */
  readonly ttlMs?: number;
  /** Injected so a test can expire an entry without sleeping. */
  readonly now?: () => number;
  /** Called once per **cold** resolution with the row's own provenance. May throw; see below. */
  readonly onResolved?: (tenantId: string, provenance: DataKeyProvenance) => void;
}): ColumnEncryptionKeySource {
  const { store, secret, mayHoldCiphertext, onResolved } = input;
  const ttlMs = input.ttlMs ?? DEFAULT_COLUMN_KEY_TTL_MS;
  const now = input.now ?? Date.now;
  const cache = new Map<string, ColumnKeyCacheEntry>();
  return (tenantId: string): Promise<string> => {
    const startedAt = now();
    const hit = cache.get(tenantId);
    // `<` rather than `<=`, which is `CachedTenantStatusDirectory.statusFor`'s comparison: one
    // spelling for one question, so the two cannot disagree about the instant a TTL lapses.
    if (hit !== undefined && startedAt - hit.at < ttlMs) return hit.resolving;
    // An expired entry whose promise is still in flight is **dropped, not awaited**. The in-flight
    // collapse below operates within one TTL window, which is what it is for; waiting on a
    // resolution that began before the window would serve the key this re-resolution exists to
    // replace.
    const resolving: Promise<string> = resolveColumnKey(
      store,
      secret,
      mayHoldCiphertext,
      tenantId,
    )
      .then((resolved) => {
        reportResolution(onResolved, tenantId, resolved.provenance);
        return resolved.key;
      })
      .catch((error: unknown) => {
        // A **rejection is not remembered**, and only this entry is forgotten: a slow failing
        // resolution may already have been replaced by a newer one past the TTL, and deleting that
        // would discard a good key.
        if (cache.get(tenantId)?.resolving === resolving) cache.delete(tenantId);
        throw error;
      });
    cache.set(tenantId, { at: startedAt, resolving });
    return resolving;
  };
}
