/**
 * Whether the column-key configuration this process booted with can open the keys the database
 * already holds — asked once at boot, from `meta.tenant_data_keys`, so a configuration that cannot
 * is a boot refusal naming the condition instead of a clean boot followed by a 500 on every PHI
 * request (ADR-0445's first open question, found live).
 *
 * ## The two configurations
 *
 * **Derived mode over stored keys.** `--column-key-mode derived` derives every tenant's column key
 * from `COLUMN_ENCRYPTION_SECRET` and never reads `meta.tenant_data_keys`. A tenant whose row is
 * `random` — a rekey wrote it, or it was provisioned in envelope mode with no ciphertext to seed
 * from — has every column under a key derived mode cannot compute, so every read fails, and every
 * **write** lands under the derived key instead, splitting that tenant's columns across two keys
 * with nothing on any row recording which. That second half is why this is a refusal and not a
 * warning: the degraded state is not coherent, it is destructive.
 *
 * A `seeded_from_derived` row is the opposite case and is **not** refused when it can be shown
 * harmless: its key *is* the derived key of the generation-1 secret (ADR-0347), so derived mode
 * reads and writes that tenant's columns correctly as long as `COLUMN_ENCRYPTION_SECRET` is that
 * secret — which is exactly a rollback from an envelope trial. Whether it is, is proved by opening
 * a sampled row and comparing the key with the derived one.
 *
 * **Envelope mode with a ring that cannot open the rows.** A new `COLUMN_ENCRYPTION_SECRET` with no
 * `COLUMN_ENCRYPTION_SECRET_PREVIOUS`: either the generation was bumped, so rows record a KEK
 * generation the ring holds no secret for (`kek_generation_unheld`), or it was not, so the ring
 * holds a secret for that generation and it is the wrong one (`kek_secret_mismatch`). Both answer
 * every request for those tenants with `DataKeyKekUnavailable` / `DataKeyUnwrapFailed`.
 *
 * ## Why key rows and one sample set per generation
 *
 * The KEK is `HKDF(secret, salt = tenantId, info = generation)`, so whether a secret is right for a
 * generation is a property of the secret and not of the tenant: one tenant's row opening proves the
 * secret, and a wrong secret opens none. So up to `SAMPLES_PER_GROUP` rows are opened per
 * (provenance, KEK generation), never every tenant. A secret is called wrong only when **every**
 * sample fails; samples that disagree mean the secret is right and the failing rows are corrupt,
 * which the request path already refuses per tenant (`DataKeyUnwrapFailed`), so that is reported and
 * not refused — refusing the whole deployment over a damaged row would be a refusal of something
 * that works.
 *
 * The samples are drawn **at random**, per boot, and there are 32 of them. A tenant-context session
 * may `UPDATE` its own key row (the table's one policy is `ALL`-scope), so a fixed first-three-by-id
 * sample would let three tenants corrupt their own rows into a permanent whole-deployment refusal
 * whose remedy names the wrong cause. Now a refusal needs every one of 32 randomly chosen rows to fail
 * — in a generation of 32 tenants or fewer, every row, when every tenant there fails anyway.
 *
 * ## When key rows cannot answer: a tenant with no key row
 *
 * A tenant that holds ciphertext and no key row is read under the key its secret derives — in
 * derived mode always, in envelope mode through the seed (`seedSecretOf`). No key row says whether
 * that secret is the one the ciphertext was written under: a replaced generation-1
 * `COLUMN_ENCRYPTION_SECRET` with nothing stored reads as a clean, empty table. So for exactly those
 * tenants, and only for them, `checkKeylessCiphertext` takes **one stored ciphertext value** per
 * tenant (from `bootSchema`'s at-rest columns, never a plaintext) and asks pgcrypto whether the key
 * opens it, stopping at the first that does. It never returns or logs the plaintext — the decrypt is
 * `octet_length(pgp_sym_decrypt_bytea(…))` — and the key is a bound parameter. The envelope case is
 * the sharper one: `ensure` seeds such a tenant's first row from that secret and never revisits it,
 * so booting under the wrong one would make the mismatch permanent.
 *
 * ## Reading the table under RLS
 *
 * `meta.tenant_data_keys` carries one isolation policy and no platform arm, so the shipped confined
 * role (`crossengin_app`, ADR-0424) reads **zero rows** from an unscoped count with no error code —
 * byte-identical to a deployment that holds no keys, which is the one answer this check must never
 * give falsely. So the session's confinement is asked of Postgres (`row_security_active`, ADR-0362)
 * and, when confined, the survey reads each tenant's row under that tenant's own context, with the
 * tenant list from `meta.tenants` (no RLS; every key row's tenant is there by the foreign key).
 * That costs two statements per tenant, so it stops at `PER_TENANT_SURVEY_CEILING` and says how many
 * tenants it did not examine. Anything it cannot establish is an `unknown` line, never an all-clear
 * (ADR-0331, ADR-0372).
 *
 * The module issues read-only SQL, never logs a key or a secret, and refuses nothing itself: the
 * caller throws `ColumnKeyConfigurationRefused` on a `refuse` verdict.
 */

import {
  dataKeyToColumnKey,
  dataKeyWrapAad,
  deriveTenantKek,
  unwrapDataKey,
} from "@crossengin/crypto";
import {
  DATA_KEY_PROVENANCES,
  SET_TENANT_CONTEXT_SQL,
  type DataKeyProvenance,
} from "@crossengin/crypto-pg";
import {
  introspectEncryptedColumns,
  probeSessionPolicyVisibility,
  readRowsWithUnreadable,
  sessionWouldBeConfined,
  textIdentity,
  type PgConnection,
  type UnreadableRow,
} from "@crossengin/kernel-pg";

import { COLUMN_ENCRYPTION_SECRET_VAR } from "./column-encryption.js";
import {
  COLUMN_ENCRYPTION_SECRET_GENERATION_VAR,
  COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR,
  kekResolverFor,
  seedSecretOf,
  type ColumnSecretRing,
} from "./column-secret-ring.js";
import { COLUMN_KEY_MODE_FLAG, derivedSeed, type ColumnKeyMode } from "./data-key-envelope.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Rows opened per (provenance, KEK generation), drawn at random. Enough that a refusal cannot be
 * manufactured by a few tenants corrupting their own rows; an AEAD open is microseconds, so the cost
 * is the read, not the check.
 */
export const SAMPLES_PER_GROUP = 32;

/** Ciphertext values (one per tenant without a key row) tried before a secret is called wrong. */
export const KEYLESS_CIPHERTEXT_SAMPLES = 32;

/**
 * How many tenants the confined route reads, one transaction and two statements each. Past it the
 * remainder is reported as unexamined rather than read: a boot that takes minutes is its own outage.
 */
export const PER_TENANT_SURVEY_CEILING = 10_000;

export const COLUMN_KEY_CONDITIONS = [
  /** Ciphertext held by tenants with no key row does not open under the secret that would read it. */
  "ciphertext_key_mismatch",
  /** Derived mode, and tenants whose current key is a stored random key derived mode never reads. */
  "derived_mode_over_random_keys",
  /** Derived mode, and seeded tenants whose key is not the one this secret derives. */
  "derived_secret_not_seed",
  /** Envelope mode, and rows wrapped under a KEK generation the ring holds no secret for. */
  "kek_generation_unheld",
  /** Envelope mode, and no sampled row at a held generation opens under the ring's secret for it. */
  "kek_secret_mismatch",
  /** Envelope mode, ciphertext with no key row, and a ring that no longer holds the seed secret. */
  "ciphertext_seed_unheld",
  /** Whether the keyless tenants' ciphertext opens could not be asked. */
  "ciphertext_unchecked",
  /** The secret opened some samples and not others: those rows are corrupt, the secret is right. */
  "rows_unopenable",
  /** Key rows the survey could not read as data key rows at all, so nothing was tried on them. */
  "rows_unreadable",
  /** Derived mode, seeded rows at a KEK generation derived mode holds no secret for. */
  "seed_unverifiable",
  /** The table could not be read at all. */
  "survey_unreadable",
  /** The confined route stopped at its ceiling, or could not read every tenant. */
  "survey_incomplete",
] as const;
export type ColumnKeyCondition = (typeof COLUMN_KEY_CONDITIONS)[number];

/**
 * What each condition does to the boot, as a total map so a new condition is a compile error
 * rather than one inheriting whichever branch an `if`-chain ended on.
 *
 * `rows_unopenable` is a `warn` and not an `unknown`: it is an established fact about named rows,
 * and the remedy is per tenant. `ciphertext_seed_unheld` is a `warn` for a stated reason: those
 * tenants are refused per request by name (`ColumnKeySeedUnavailable`) and nothing is written, and the
 * only remedy — putting the generation-1 secret back as the previous one — would leave every row at a
 * later generation unheld, so a boot refusal would trade a per-tenant refusal for a whole-deployment
 * one with no configuration that clears it. The `unknown` conditions are the honest arm — nothing was
 * established, so neither a refusal nor an all-clear is said.
 */
export const COLUMN_KEY_CONDITION_EFFECT: Readonly<
  Record<ColumnKeyCondition, "refuse" | "warn" | "unknown">
> = {
  ciphertext_key_mismatch: "refuse",
  ciphertext_seed_unheld: "warn",
  ciphertext_unchecked: "unknown",
  derived_mode_over_random_keys: "refuse",
  derived_secret_not_seed: "refuse",
  kek_generation_unheld: "refuse",
  kek_secret_mismatch: "refuse",
  rows_unopenable: "warn",
  rows_unreadable: "unknown",
  seed_unverifiable: "unknown",
  survey_unreadable: "unknown",
  survey_incomplete: "unknown",
};

/** One sampled key row. `wrappedKey` is ciphertext and is never rendered. */
export interface DataKeyRowSample {
  readonly tenantId: string;
  readonly generation: number;
  readonly kekGeneration: number;
  readonly provenance: DataKeyProvenance;
  readonly wrappedKey: Uint8Array;
}

/** Tenants whose **current** (highest-generation) row has this provenance and KEK generation. */
export interface DataKeyRowGroup {
  readonly provenance: DataKeyProvenance;
  readonly kekGeneration: number;
  readonly tenants: number;
  readonly samples: readonly DataKeyRowSample[];
}

export type DataKeyRowSurvey =
  | {
      readonly readable: true;
      /** `unconfined`: one read saw every tenant. `per_tenant`: each tenant read under its context. */
      readonly route: "unconfined" | "per_tenant";
      readonly groups: readonly DataKeyRowGroup[];
      /** Tenants the per-tenant route did not read; 0 on the unconfined route. */
      readonly unexaminedTenants: number;
      /** Why some tenants were not read, when `unexaminedTenants > 0`. */
      readonly incompleteReason: string | null;
      /**
       * Rows refused as data key rows (`readRowsWithUnreadable`), field path and issue code only.
       * Part of the answer rather than a throw: one malformed row must not take the survey with it
       * (ADR-0373), and it must not vanish either, since its tenant is the one that will fail.
       */
      readonly unreadable: readonly UnreadableRow[];
    }
  | { readonly readable: false; readonly reason: string };

export interface ColumnKeyFinding {
  readonly condition: ColumnKeyCondition;
  /** Affected tenants, or `null` where the condition is about the survey rather than tenants. */
  readonly tenants: number | null;
  readonly kekGeneration: number | null;
  readonly detail: string;
}

export interface ColumnKeyConsistency {
  readonly verdict: "consistent" | "refuse" | "unknown";
  readonly mode: ColumnKeyMode;
  /** Tenants holding a data key row, among those examined. */
  readonly tenantsWithKeys: number;
  readonly findings: readonly ColumnKeyFinding[];
  /** What was established about tenants with no key row, which the consistent line has to say. */
  readonly ciphertext: KeylessCiphertextCheck;
}

export class ColumnKeyConfigurationRefused extends Error {
  constructor(readonly consistency: ColumnKeyConsistency) {
    super(
      formatColumnKeyConsistency(consistency)
        .filter((line) => line.level === "error")
        .map((line) => line.text)
        .join("\n"),
    );
    this.name = "ColumnKeyConfigurationRefused";
  }
}

// ---------------------------------------------------------------------------------------------
// The survey.

interface CatalogRow {
  readonly table_exists: unknown;
  readonly can_select: unknown;
}

interface KeyRow {
  readonly tenant_id: unknown;
  readonly generation: unknown;
  readonly wrapped_key: unknown;
  readonly kek_generation: unknown;
  readonly provenance: unknown;
}

interface CountRow {
  readonly provenance: unknown;
  readonly kek_generation: unknown;
  readonly tenants: unknown;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asInt(value: unknown, column: string): number {
  const n = Number(value);
  // No value in the message: `unreadableDetail` passes a mapper's own message through (ADR-0373).
  if (!Number.isInteger(n)) throw new Error(`${column} is not an integer`);
  return n;
}

function asProvenance(value: unknown): DataKeyProvenance {
  const raw = String(value);
  if (!(DATA_KEY_PROVENANCES as readonly string[]).includes(raw)) {
    throw new Error("provenance is not a known data key provenance");
  }
  return raw as DataKeyProvenance;
}

function asSample(row: KeyRow): DataKeyRowSample {
  if (!(row.wrapped_key instanceof Uint8Array)) {
    throw new Error(`wrapped_key is not a BYTEA buffer (got ${typeof row.wrapped_key})`);
  }
  return {
    tenantId: String(row.tenant_id),
    generation: asInt(row.generation, "generation"),
    kekGeneration: asInt(row.kek_generation, "kek_generation"),
    provenance: asProvenance(row.provenance),
    wrappedKey: row.wrapped_key,
  };
}

function groupKey(provenance: DataKeyProvenance, kekGeneration: number): string {
  return `${provenance}|${kekGeneration.toString()}`;
}

/**
 * Reads the current row of every tenant's data key, grouped by (provenance, KEK generation), with
 * up to `SAMPLES_PER_GROUP` sample rows per group.
 *
 * Never throws: a failed read is `readable: false`, which the assessment turns into an `unknown`
 * line. Two routes, chosen by asking Postgres whether this session is confined on the table.
 */
export async function surveyDataKeyRows(
  conn: PgConnection,
  opts: {
    readonly schema?: string;
    readonly ceiling?: number;
    /** Draws the confined route's samples; injected so a test can pin them. */
    readonly random?: () => number;
  } = {},
): Promise<DataKeyRowSurvey> {
  const schema = opts.schema ?? "meta";
  if (!SCHEMA_RE.test(schema)) {
    return { readable: false, reason: `invalid schema identifier ${JSON.stringify(schema)}` };
  }
  const ceiling = opts.ceiling ?? PER_TENANT_SURVEY_CEILING;
  const table = `${schema}.tenant_data_keys`;
  try {
    const catalog = await conn.query<CatalogRow>(
      `SELECT to_regclass($1) IS NOT NULL AS table_exists,
              COALESCE(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false) AS can_select`,
      [table],
    );
    const row = catalog.rows[0];
    if (row === undefined || row.table_exists !== true) {
      // An absent table holds no keys: conclusive, and the applier's own refusal will meet the
      // first provisioning. Said as zero rows rather than as `unknown`.
      return {
        readable: true,
        route: "unconfined",
        groups: [],
        unexaminedTenants: 0,
        incompleteReason: null,
        unreadable: [],
      };
    }
    if (row.can_select !== true) {
      return { readable: false, reason: `this role may not SELECT ${table}` };
    }
    const visibility = await probeSessionPolicyVisibility(conn, schema, "tenant_data_keys");
    if (visibility === null) {
      return { readable: false, reason: `${table} vanished between two catalog reads` };
    }
    return sessionWouldBeConfined(visibility)
      ? await surveyPerTenant(conn, schema, ceiling, opts.random ?? Math.random)
      : await surveyUnconfined(conn, schema);
  } catch (err) {
    return { readable: false, reason: message(err) };
  }
}

async function surveyUnconfined(conn: PgConnection, schema: string): Promise<DataKeyRowSurvey> {
  // `latest` is each tenant's highest generation, which is the row the serving path opens. Samples
  // are ranked by `random()`, not by id: a fixed sample would let the same few tenants' rows decide
  // every boot (the module comment). The table is one row per tenant per data-key generation, so the
  // sort is over a small set.
  const latest = `WITH latest AS (
       SELECT DISTINCT ON (tenant_id) tenant_id, generation, wrapped_key, kek_generation, provenance
         FROM ${schema}.tenant_data_keys
        ORDER BY tenant_id, generation DESC)`;
  const counts = await conn.query<CountRow>(
    `${latest}
     SELECT provenance, kek_generation, count(*) AS tenants
       FROM latest
      GROUP BY provenance, kek_generation`,
    [],
  );
  const samples = await conn.query<KeyRow>(
    `${latest},
     ranked AS (
       SELECT tenant_id, generation, wrapped_key, kek_generation, provenance,
              row_number() OVER (PARTITION BY provenance, kek_generation ORDER BY random()) AS rank
         FROM latest)
     SELECT tenant_id, generation, wrapped_key, kek_generation, provenance
       FROM ranked
      WHERE rank <= $1`,
    [SAMPLES_PER_GROUP],
  );
  const read = readRowsWithUnreadable(samples.rows, asSample, (r) => textIdentity(r, "tenant_id"));
  const byGroup = new Map<string, DataKeyRowSample[]>();
  for (const sample of read.records) {
    const key = groupKey(sample.provenance, sample.kekGeneration);
    byGroup.set(key, [...(byGroup.get(key) ?? []), sample]);
  }
  // A count row the CHECKs make unrepresentable is still refused rather than trusted, and it is the
  // whole group that goes unexamined — so it joins the unreadable rows and the assessment says so.
  const tallied = readRowsWithUnreadable(
    counts.rows,
    (raw): DataKeyRowGroup => {
      const provenance = asProvenance(raw.provenance);
      const kekGeneration = asInt(raw.kek_generation, "kek_generation");
      return {
        provenance,
        kekGeneration,
        tenants: asInt(raw.tenants, "tenants"),
        samples: byGroup.get(groupKey(provenance, kekGeneration)) ?? [],
      };
    },
    () => null,
  );
  return {
    readable: true,
    route: "unconfined",
    groups: tallied.records,
    unexaminedTenants: 0,
    incompleteReason: null,
    unreadable: [...read.unreadable, ...tallied.unreadable],
  };
}

async function surveyPerTenant(
  conn: PgConnection,
  schema: string,
  ceiling: number,
  random: () => number,
): Promise<DataKeyRowSurvey> {
  // One past the ceiling, so "exactly at the ceiling" and "more than it" are told apart without a
  // second count.
  const tenantRows = await conn.query<{ id: unknown }>(
    `SELECT id FROM ${schema}.tenants ORDER BY id LIMIT $1`,
    [ceiling + 1],
  );
  const ids = tenantRows.rows.map((r) => String(r.id));
  const examined = ids.slice(0, ceiling);
  let unexaminedTenants = 0;
  let incompleteReason: string | null = null;
  if (ids.length > ceiling) {
    const total = await conn.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${schema}.tenants`, []);
    unexaminedTenants = asInt(total.rows[0]?.n ?? 0, "count") - ceiling;
    incompleteReason =
      `this role is confined by ${schema}.tenant_data_keys' isolation policy, so each tenant is read ` +
      `under its own context, and the survey stops at ${ceiling.toString()} tenants`;
  }
  const groups = new Map<string, { group: Omit<DataKeyRowGroup, "samples">; samples: DataKeyRowSample[] }>();
  const unreadable: UnreadableRow[] = [];
  await conn.transaction(async (tx) => {
    for (const tenantId of examined) {
      await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      const result = await tx.query<KeyRow>(
        `SELECT tenant_id, generation, wrapped_key, kek_generation, provenance
           FROM ${schema}.tenant_data_keys
          WHERE tenant_id = $1
          ORDER BY generation DESC
          LIMIT 1`,
        [tenantId],
      );
      const read = readRowsWithUnreadable(result.rows, asSample, (r) => textIdentity(r, "tenant_id"));
      unreadable.push(...read.unreadable);
      const sample = read.records[0];
      if (sample === undefined) continue;
      const key = groupKey(sample.provenance, sample.kekGeneration);
      const entry = groups.get(key) ?? {
        group: { provenance: sample.provenance, kekGeneration: sample.kekGeneration, tenants: 0 },
        samples: [],
      };
      entry.group = { ...entry.group, tenants: entry.group.tenants + 1 };
      // Reservoir sampling: every tenant of the group is equally likely to be among the samples,
      // whatever its position in id order, so the unconfined route's `random()` holds here too.
      if (entry.samples.length < SAMPLES_PER_GROUP) entry.samples.push(sample);
      else {
        const slot = Math.floor(random() * entry.group.tenants);
        if (slot < SAMPLES_PER_GROUP) entry.samples[slot] = sample;
      }
      groups.set(key, entry);
    }
  });
  return {
    readable: true,
    route: "per_tenant",
    groups: [...groups.values()].map(({ group, samples }) => ({ ...group, samples })),
    unexaminedTenants,
    incompleteReason,
    unreadable,
  };
}

// ---------------------------------------------------------------------------------------------
// Tenants with no key row: the one question key rows cannot answer.

export type KeylessCiphertextCheck =
  | {
      readonly checked: true;
      /** The data schema whose at-rest columns were asked. Per-tenant manifest schemas are not. */
      readonly schema: string;
      /** At-rest-encrypted columns found in `schema`; 0 means there was nothing to ask. */
      readonly columns: number;
      /** False when the ring holds no secret such ciphertext would be read under (`seedSecretOf`). */
      readonly keyHeld: boolean;
      /** Ciphertext values found, one per tenant without a key row, and tried when `keyHeld`. */
      readonly found: number;
      /** How many of those opened. The check stops at the first that does. */
      readonly opened: number;
      /** Tenants the per-tenant route did not reach, when it stopped without a decision. */
      readonly unexaminedTenants: number;
    }
  | { readonly checked: false; readonly reason: string };

/**
 * The secret ciphertext held by a tenant with no key row is read under: the current secret in derived
 * mode, and in envelope mode the seed `buildEnvelopeKeySource` would provision that tenant from —
 * `null` once the ring no longer holds it, which is the per-request `ColumnKeySeedUnavailable`.
 */
export function keylessCiphertextSecret(mode: ColumnKeyMode, ring: ColumnSecretRing): Uint8Array | null {
  return mode === "derived" ? ring.current : seedSecretOf(ring);
}

/** pgcrypto's `Wrong key or corrupt data` (ERRCODE_EXTERNAL_ROUTINE_INVOCATION_EXCEPTION). */
const PGCRYPTO_REFUSED_SQLSTATE = "39000";

/** Opens `ciphertext` under `key` and returns the plaintext's length only, never the plaintext. */
const DECRYPT_SQL = "SELECT octet_length(pgp_sym_decrypt_bytea($1::bytea, $2)) AS n";

function sqlState(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function quoteIdent(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

interface CiphertextColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * Whether ciphertext held by tenants with **no** data key row opens under the key this configuration
 * would read it with. Never throws: a failed read, an absent `pgcrypto` or any decrypt error but
 * pgcrypto's own wrong-key refusal is `checked: false`.
 *
 * One value per tenant, so a few tenants corrupting their own rows cannot decide it; the per-tenant
 * order is random for the same reason. On a confined session each tenant is read under its own
 * context, and the decrypt runs inside a savepoint so pgcrypto's refusal does not abort the scan.
 */
export async function checkKeylessCiphertext(
  conn: PgConnection,
  opts: {
    readonly keySchema?: string;
    readonly bootSchema: string;
    readonly secret: Uint8Array | null;
    readonly ceiling?: number;
    readonly samples?: number;
  },
): Promise<KeylessCiphertextCheck> {
  const keySchema = opts.keySchema ?? "meta";
  const { bootSchema, secret } = opts;
  for (const name of [keySchema, bootSchema]) {
    if (!SCHEMA_RE.test(name)) {
      return { checked: false, reason: `invalid schema identifier ${JSON.stringify(name)}` };
    }
  }
  const ceiling = opts.ceiling ?? PER_TENANT_SURVEY_CEILING;
  const wanted = opts.samples ?? KEYLESS_CIPHERTEXT_SAMPLES;
  const keyFor = (tenantId: string): string | null =>
    secret === null ? null : dataKeyToColumnKey(derivedSeed(secret, tenantId));
  try {
    const columns: CiphertextColumn[] = (await introspectEncryptedColumns(conn, bootSchema))
      .filter((c) => c.encryptedStorage)
      .map((c) => ({ table: c.table, column: c.column }));
    const base = { checked: true as const, schema: bootSchema, columns: columns.length, keyHeld: secret !== null };
    if (columns.length === 0) return { ...base, found: 0, opened: 0, unexaminedTenants: 0 };
    const keyTable = await conn.query<{ present: unknown }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`${keySchema}.tenant_data_keys`],
    );
    const keyTablePresent = keyTable.rows[0]?.present === true;
    let confined = false;
    for (const table of new Set(columns.map((c) => c.table))) {
      const v = await probeSessionPolicyVisibility(conn, bootSchema, table);
      if (v === null || sessionWouldBeConfined(v)) confined = true;
    }
    return confined
      ? { ...base, ...(await keylessPerTenant(conn, { keySchema, bootSchema, columns, keyTablePresent, keyFor, keyHeld: base.keyHeld, wanted, ceiling })) }
      : { ...base, ...(await keylessUnconfined(conn, { keySchema, bootSchema, columns, keyTablePresent, keyFor, keyHeld: base.keyHeld, wanted })), unexaminedTenants: 0 };
  } catch (err) {
    return { checked: false, reason: message(err) };
  }
}

interface KeylessScan {
  readonly keySchema: string;
  readonly bootSchema: string;
  readonly columns: readonly CiphertextColumn[];
  readonly keyTablePresent: boolean;
  readonly keyFor: (tenantId: string) => string | null;
  readonly keyHeld: boolean;
  readonly wanted: number;
}

/** `opened` or `refused`; any other failure is rethrown, so the whole check reads `unchecked`. */
async function tryDecrypt(conn: PgConnection, ciphertext: unknown, key: string): Promise<"opened" | "refused"> {
  try {
    await conn.query(DECRYPT_SQL, [ciphertext, key]);
    return "opened";
  } catch (err) {
    if (sqlState(err) === PGCRYPTO_REFUSED_SQLSTATE) return "refused";
    throw err;
  }
}

async function keylessUnconfined(
  conn: PgConnection,
  scan: KeylessScan,
): Promise<{ readonly found: number; readonly opened: number }> {
  // One value per tenant, from as many tenants as `wanted`. Each column is asked for more rows than
  // `wanted` so a tenant with many rows does not fill the sample on its own.
  const byTenant = new Map<string, unknown>();
  for (const { table, column } of scan.columns) {
    if (byTenant.size >= scan.wanted) break;
    const keyless = scan.keyTablePresent
      ? ` AND NOT EXISTS (SELECT 1 FROM ${scan.keySchema}.tenant_data_keys k WHERE k.tenant_id = t.tenant_id)`
      : "";
    const result = await conn.query<{ tenant_id: unknown; ciphertext: unknown }>(
      `SELECT t.tenant_id::text AS tenant_id, t.${quoteIdent(column)} AS ciphertext
         FROM ${quoteIdent(scan.bootSchema)}.${quoteIdent(table)} t
        WHERE t.${quoteIdent(column)} IS NOT NULL${keyless}
        LIMIT $1`,
      [scan.wanted * 8],
    );
    for (const row of result.rows) {
      const tenantId = String(row.tenant_id);
      if (byTenant.size >= scan.wanted) break;
      if (!byTenant.has(tenantId)) byTenant.set(tenantId, row.ciphertext);
    }
  }
  let found = 0;
  for (const [tenantId, ciphertext] of byTenant) {
    found += 1;
    const key = scan.keyFor(tenantId);
    if (key === null) return { found, opened: 0 };
    if ((await tryDecrypt(conn, ciphertext, key)) === "opened") return { found, opened: 1 };
  }
  return { found, opened: 0 };
}

async function keylessPerTenant(
  conn: PgConnection,
  scan: KeylessScan & { readonly ceiling: number },
): Promise<{ readonly found: number; readonly opened: number; readonly unexaminedTenants: number }> {
  const tenantRows = await conn.query<{ id: unknown }>(
    `SELECT id FROM ${scan.keySchema}.tenants ORDER BY random() LIMIT $1`,
    [scan.ceiling + 1],
  );
  const ids = tenantRows.rows.map((r) => String(r.id));
  const examined = ids.slice(0, scan.ceiling);
  // One statement per tenant: the first non-NULL value across the at-rest columns, only when the
  // tenant has no key row. `$1` is the tenant; the key-row test reads under that tenant's context.
  const branches = scan.columns.map(
    ({ table, column }) =>
      `(SELECT ${quoteIdent(column)} AS ciphertext FROM ${quoteIdent(scan.bootSchema)}.${quoteIdent(table)} ` +
      `WHERE tenant_id = $1::uuid AND ${quoteIdent(column)} IS NOT NULL LIMIT 1)`,
  );
  const keyless = scan.keyTablePresent
    ? ` WHERE NOT EXISTS (SELECT 1 FROM ${scan.keySchema}.tenant_data_keys k WHERE k.tenant_id = $1::uuid)`
    : "";
  const sampleSql = `SELECT ciphertext FROM (${branches.join(" UNION ALL ")}) u${keyless} LIMIT 1`;
  let found = 0;
  let opened = 0;
  let reached = 0;
  await conn.transaction(async (tx) => {
    for (const tenantId of examined) {
      if (opened > 0 || found >= scan.wanted) break;
      reached += 1;
      await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      const result = await tx.query<{ ciphertext: unknown }>(sampleSql, [tenantId]);
      const row = result.rows[0];
      if (row === undefined) continue;
      found += 1;
      const key = scan.keyFor(tenantId);
      if (key === null) break;
      // A savepoint, because pgcrypto's refusal is an error and would abort the transaction.
      await tx.query("SAVEPOINT column_key_probe", []);
      try {
        await tx.query(DECRYPT_SQL, [row.ciphertext, key]);
        opened += 1;
        await tx.query("RELEASE SAVEPOINT column_key_probe", []);
      } catch (err) {
        if (sqlState(err) !== PGCRYPTO_REFUSED_SQLSTATE) throw err;
        await tx.query("ROLLBACK TO SAVEPOINT column_key_probe", []);
      }
    }
  });
  const decided = opened > 0 || found >= scan.wanted || (found > 0 && !scan.keyHeld);
  let unexaminedTenants = 0;
  if (!decided) {
    unexaminedTenants = examined.length - reached;
    if (ids.length > scan.ceiling) {
      const total = await conn.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${scan.keySchema}.tenants`, []);
      unexaminedTenants += asInt(total.rows[0]?.n ?? 0, "count") - scan.ceiling;
    }
  }
  return { found, opened, unexaminedTenants };
}

// ---------------------------------------------------------------------------------------------
// The assessment. Pure: everything it needs is in the survey and the ring.

type SampleOutcome = "opened_matches" | "opened_differs" | "did_not_open" | "no_secret";

/** Opens one sample under `kekFor`; `compareTo` is the column key it must equal, when asked. */
function trySample(
  sample: DataKeyRowSample,
  kekFor: (tenantId: string, kekGeneration: number) => Uint8Array,
  compareTo?: (tenantId: string) => string,
): SampleOutcome {
  let kek: Uint8Array;
  try {
    kek = kekFor(sample.tenantId, sample.kekGeneration);
  } catch {
    return "no_secret";
  }
  const dek = unwrapDataKey(kek, sample.wrappedKey, dataKeyWrapAad(sample.tenantId, sample.generation));
  if (dek === null) return "did_not_open";
  if (compareTo === undefined) return "opened_matches";
  return dataKeyToColumnKey(dek) === compareTo(sample.tenantId) ? "opened_matches" : "opened_differs";
}

function byKekGeneration(groups: readonly DataKeyRowGroup[]): Map<number, DataKeyRowGroup[]> {
  const out = new Map<number, DataKeyRowGroup[]>();
  for (const g of groups) out.set(g.kekGeneration, [...(out.get(g.kekGeneration) ?? []), g]);
  return new Map([...out.entries()].sort(([a], [b]) => a - b));
}

function tenantsIn(groups: readonly DataKeyRowGroup[]): number {
  return groups.reduce((n, g) => n + g.tenants, 0);
}

function ringHolds(ring: ColumnSecretRing): string {
  return ring.previous === null
    ? `generation ${ring.currentGeneration.toString()}`
    : `generations ${(ring.currentGeneration - 1).toString()} and ${ring.currentGeneration.toString()}`;
}

/** Which variable holds the ring's secret for `g`, which the remedy has to name. */
function variableFor(ring: ColumnSecretRing, g: number): string {
  return g === ring.currentGeneration ? COLUMN_ENCRYPTION_SECRET_VAR : COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR;
}

function unheldRemedy(ring: ColumnSecretRing, g: number): string {
  if (g > ring.currentGeneration) {
    return (
      `rows record a generation newer than ${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR}=` +
      `${ring.currentGeneration.toString()}, so the secret was rolled back: restore the generation-` +
      `${g.toString()} secret as ${COLUMN_ENCRYPTION_SECRET_VAR} with ` +
      `${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR}=${g.toString()}`
    );
  }
  if (g === ring.currentGeneration - 1) {
    return (
      `set ${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR} to the generation-${g.toString()} secret, run ` +
      "`operate-server rekey --rewrap-kek --tenant <id>` for each tenant, and unset it only then"
    );
  }
  return (
    `the ring holds one previous generation, and these rows are ${(ring.currentGeneration - g).toString()} ` +
    `back: set ${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR}=${(g + 1).toString()} with the generation-` +
    `${(g + 1).toString()} secret as ${COLUMN_ENCRYPTION_SECRET_VAR} and the generation-${g.toString()} ` +
    `secret as ${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR}, re-wrap every tenant, then rotate forward again`
  );
}

/**
 * What to change when the ring's secret for `g` opens none of the rows. Three shapes, because the
 * advice that fits one is a no-op or a loss in another: the previous secret is the wrong one (the
 * generation is already right, so only the value is), the current secret is wrong mid-rotation (a
 * second rotation would drop the previous generation's rows), or the current secret was replaced
 * with no rotation in progress (which may have been meant as one).
 */
function mismatchRemedy(ring: ColumnSecretRing, g: number): string {
  if (g === ring.currentGeneration - 1) {
    return (
      `${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR} is not the generation-${g.toString()} secret: set it to ` +
      "the secret that wrapped these rows"
    );
  }
  if (ring.previous !== null) {
    return (
      `${COLUMN_ENCRYPTION_SECRET_VAR} is not the generation-${g.toString()} secret these rows were ` +
      "wrapped under: restore that secret, keeping the previous one in place until the rotation completes"
    );
  }
  return (
    `if a new secret was meant as a rotation, restore the old one as ${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR}, ` +
    `the new one as ${COLUMN_ENCRYPTION_SECRET_VAR} and set ${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR}=` +
    `${(g + 1).toString()}; otherwise restore the secret that wrapped them`
  );
}

function assessEnvelope(ring: ColumnSecretRing, groups: readonly DataKeyRowGroup[]): ColumnKeyFinding[] {
  const kekFor = kekResolverFor(ring);
  const findings: ColumnKeyFinding[] = [];
  for (const [g, atGeneration] of byKekGeneration(groups)) {
    const tenants = tenantsIn(atGeneration);
    const outcomes = atGeneration.flatMap((grp) => grp.samples.map((s) => trySample(s, kekFor)));
    if (outcomes.length === 0) continue;
    if (outcomes.every((o) => o === "no_secret")) {
      findings.push({
        condition: "kek_generation_unheld",
        tenants,
        kekGeneration: g,
        detail:
          `${tenants.toString()} tenant(s) hold data keys wrapped under key-encryption-key generation ` +
          `${g.toString()}, and this deployment holds a secret for ${ringHolds(ring)} only, so every ` +
          `PHI read and write for them fails (DataKeyKekUnavailable). Remedy: ${unheldRemedy(ring, g)}`,
      });
      continue;
    }
    const opened = outcomes.filter((o) => o === "opened_matches").length;
    if (opened === 0) {
      findings.push({
        condition: "kek_secret_mismatch",
        tenants,
        kekGeneration: g,
        detail:
          `no sampled data key at key-encryption-key generation ${g.toString()} (${outcomes.length.toString()} ` +
          `tried) opens under the secret this deployment holds for that generation (${variableFor(ring, g)}), ` +
          `so it is not the secret those ${tenants.toString()} tenant(s)' keys were wrapped under and every ` +
          `PHI read and write for them fails (DataKeyUnwrapFailed). Remedy: ${mismatchRemedy(ring, g)}`,
      });
    } else if (opened < outcomes.length) {
      findings.push({
        condition: "rows_unopenable",
        tenants: null,
        kekGeneration: g,
        detail:
          `${(outcomes.length - opened).toString()} of ${outcomes.length.toString()} sampled data keys at ` +
          `key-encryption-key generation ${g.toString()} did not open while the others did, so the secret ` +
          `is right and those rows are corrupt; each such tenant's PHI requests fail ` +
          `(DataKeyUnwrapFailed, answered as a 500) until its row is restored`,
      });
    }
  }
  return findings;
}

function assessDerived(ring: ColumnSecretRing, groups: readonly DataKeyRowGroup[]): ColumnKeyFinding[] {
  const findings: ColumnKeyFinding[] = [];
  const random = groups.filter((g) => g.provenance === "random");
  if (random.length > 0) {
    const tenants = tenantsIn(random);
    findings.push({
      condition: "derived_mode_over_random_keys",
      tenants,
      kekGeneration: null,
      detail:
        `${tenants.toString()} tenant(s) hold a stored random data key (meta.tenant_data_keys, provenance ` +
        `random): their columns are encrypted under that key, which ${COLUMN_KEY_MODE_FLAG} derived ` +
        "never reads, so every PHI read for them fails and every write would land under the derived key, " +
        "splitting each tenant's columns across two keys with nothing recording which. Remedy: run " +
        `${COLUMN_KEY_MODE_FLAG} envelope, with the secret ring that opens those rows`,
    });
  }
  // Derived mode holds one secret at generation 1. A seeded key was seeded from the generation-1
  // secret, so it is this deployment's derived key exactly when that is the secret in hand — and
  // the KEK is derived from the same secret, so opening the row under it at the row's own KEK
  // generation proves which secret this is.
  const kekFor = (tenantId: string, g: number): Uint8Array => deriveTenantKek(ring.current, tenantId, g);
  const derivedKey = (tenantId: string): string => dataKeyToColumnKey(derivedSeed(ring.current, tenantId));
  const seeded = groups.filter((g) => g.provenance === "seeded_from_derived");
  for (const [g, atGeneration] of byKekGeneration(seeded)) {
    const tenants = tenantsIn(atGeneration);
    const outcomes = atGeneration.flatMap((grp) => grp.samples.map((s) => trySample(s, kekFor, derivedKey)));
    if (outcomes.length === 0) continue;
    const matched = outcomes.filter((o) => o === "opened_matches").length;
    const differed = outcomes.filter((o) => o === "opened_differs").length;
    if (differed > 0 || (g === 1 && matched === 0)) {
      // Generation 1 rows were wrapped by the generation-1 secret, so failing to open every sample
      // is proof this secret is not it. Opening and differing is proof at any generation.
      findings.push({
        condition: "derived_secret_not_seed",
        tenants,
        kekGeneration: g,
        detail:
          `${tenants.toString()} tenant(s) hold a data key seeded from the generation-1 column secret ` +
          `(key-encryption-key generation ${g.toString()}), and ${COLUMN_ENCRYPTION_SECRET_VAR} is not that ` +
          "secret, so the key derived mode computes is not the key their columns are under. Remedy: " +
          `restore the generation-1 secret as ${COLUMN_ENCRYPTION_SECRET_VAR}, or run ` +
          `${COLUMN_KEY_MODE_FLAG} envelope with the secret ring that opens those rows`,
      });
    } else if (matched === 0) {
      findings.push({
        condition: "seed_unverifiable",
        tenants,
        kekGeneration: g,
        detail:
          `${tenants.toString()} tenant(s) hold a seeded data key wrapped under key-encryption-key ` +
          `generation ${g.toString()}, which derived mode holds no secret for, so whether ` +
          `${COLUMN_ENCRYPTION_SECRET_VAR} is the secret their columns are under cannot be settled from the ` +
          `key rows; if it is not, their PHI requests fail. ${COLUMN_KEY_MODE_FLAG} envelope with the ring ` +
          "that opens those rows settles it",
      });
    } else if (matched < outcomes.length) {
      findings.push({
        condition: "rows_unopenable",
        tenants: null,
        kekGeneration: g,
        detail:
          `${(outcomes.length - matched).toString()} of ${outcomes.length.toString()} sampled seeded data ` +
          `keys at key-encryption-key generation ${g.toString()} did not open while the others did, so ` +
          "those rows are corrupt; derived mode does not read them, but envelope mode would refuse those tenants",
      });
    }
  }
  return findings;
}

function assessKeylessCiphertext(
  mode: ColumnKeyMode,
  ring: ColumnSecretRing,
  check: KeylessCiphertextCheck,
): ColumnKeyFinding[] {
  if (!check.checked) {
    return [
      {
        condition: "ciphertext_unchecked",
        tenants: null,
        kekGeneration: null,
        detail:
          `whether ciphertext held by tenants with no data key row opens under this configuration could ` +
          `not be asked (${check.reason}); if ${COLUMN_ENCRYPTION_SECRET_VAR} is not the secret it was ` +
          "written under, their PHI requests fail with a 500" +
          (mode === "envelope" ? " and their first data key is seeded from the wrong secret" : ""),
      },
    ];
  }
  const findings: ColumnKeyFinding[] = [];
  if (check.found > 0 && !check.keyHeld) {
    findings.push({
      condition: "ciphertext_seed_unheld",
      tenants: null,
      kekGeneration: null,
      detail:
        `at least one tenant with no data key row holds ciphertext in ${check.schema}, written in derived ` +
        `mode under the generation-1 column secret, and this ring (${ringHolds(ring)}) no longer holds it, ` +
        "so each such tenant is refused per request (ColumnKeySeedUnavailable) and nothing is written. " +
        `Remedy: ${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR} set to the generation-1 secret at ` +
        `${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR}=2 while those tenants are served once`,
    });
  } else if (check.found > 0 && check.opened === 0) {
    const which =
      mode === "derived"
        ? `${COLUMN_ENCRYPTION_SECRET_VAR} (the key derived mode reads every such tenant with)`
        : `the generation-1 secret this ring holds (${
            ring.currentGeneration === 1 ? COLUMN_ENCRYPTION_SECRET_VAR : COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR
          }), which ${COLUMN_KEY_MODE_FLAG} envelope seeds each such tenant's first data key from — permanently`;
    findings.push({
      condition: "ciphertext_key_mismatch",
      tenants: null,
      kekGeneration: null,
      detail:
        `ciphertext held by tenants with no data key row (${check.found.toString()} tenant(s) sampled in ` +
        `${check.schema}) opens under none of the keys derived from ${which}, so it is not the secret ` +
        "that ciphertext was written under and every PHI read for those tenants fails. Remedy: restore " +
        "the column secret those tenants' data was written under",
    });
  } else if (check.opened > 0 && check.found > check.opened) {
    findings.push({
      condition: "rows_unopenable",
      tenants: null,
      kekGeneration: null,
      detail:
        `${(check.found - check.opened).toString()} of ${check.found.toString()} sampled ciphertext values ` +
        `held by tenants with no data key row (${check.schema}) did not open while another did, so the ` +
        "secret is right and those values are corrupt; reads of them fail with a 500",
    });
  }
  if (check.unexaminedTenants > 0) {
    findings.push({
      condition: "survey_incomplete",
      tenants: check.unexaminedTenants,
      kekGeneration: null,
      detail:
        `${check.unexaminedTenants.toString()} tenant(s) were not asked whether they hold ciphertext with no ` +
        "data key row (the per-tenant scan stopped at its ceiling with nothing decided). Nothing is claimed of them",
    });
  }
  return findings;
}

export function assessColumnKeyConsistency(input: {
  readonly mode: ColumnKeyMode;
  readonly ring: ColumnSecretRing;
  readonly survey: DataKeyRowSurvey;
  /** Required: a deployment holding no key row is exactly where this is the only evidence. */
  readonly ciphertext: KeylessCiphertextCheck;
}): ColumnKeyConsistency {
  const { mode, ring, survey, ciphertext } = input;
  const findings: ColumnKeyFinding[] = [];
  if (!survey.readable) {
    findings.push({
      condition: "survey_unreadable",
      tenants: null,
      kekGeneration: null,
      detail:
        `the stored data keys could not be surveyed (${survey.reason}), so whether this column-key ` +
        "configuration can open the stored keys was not established — a PHI request for a tenant it " +
        "cannot open will fail with a 500",
    });
  } else {
    findings.push(...(mode === "envelope" ? assessEnvelope(ring, survey.groups) : assessDerived(ring, survey.groups)));
    // A group with tenants and no sample was not examined: every one of its sample rows was refused.
    // Those refusals are already counted below, so the group adds no second finding.
    if (survey.unreadable.length > 0) {
      const reasons = [...new Set(survey.unreadable.map((u) => u.detail))].sort().join("; ");
      findings.push({
        condition: "rows_unreadable",
        tenants: null,
        kekGeneration: null,
        detail:
          `${survey.unreadable.length.toString()} data key row(s) could not be read as a data key row ` +
          `(${reasons}), so nothing was tried on them; their tenants' PHI requests will be refused until ` +
          "the rows are restored",
      });
    }
    if (survey.unexaminedTenants > 0) {
      findings.push({
        condition: "survey_incomplete",
        tenants: survey.unexaminedTenants,
        kekGeneration: null,
        detail:
          `${survey.unexaminedTenants.toString()} tenant(s) were not examined: ${survey.incompleteReason ?? ""}. ` +
          "What was examined is reported; nothing is claimed of the rest",
      });
    }
  }
  findings.push(...assessKeylessCiphertext(mode, ring, ciphertext));
  const effects = findings.map((f) => COLUMN_KEY_CONDITION_EFFECT[f.condition]);
  const verdict = effects.includes("refuse") ? "refuse" : effects.includes("unknown") ? "unknown" : "consistent";
  return {
    verdict,
    mode,
    tenantsWithKeys: survey.readable ? tenantsIn(survey.groups) : 0,
    findings,
    ciphertext,
  };
}

export interface ColumnKeyConsistencyLine {
  readonly level: "info" | "warn" | "error";
  readonly text: string;
}

const EFFECT_LEVEL: Readonly<Record<"refuse" | "warn" | "unknown", ColumnKeyConsistencyLine["level"]>> = {
  refuse: "error",
  warn: "warn",
  unknown: "warn",
};

/**
 * The boot lines. Said either way: a consistent survey says how many tenants it examined, so an
 * operator can tell "checked, and fine" from "not checked" — the second is always a `warn`.
 */
/** What the consistent line says about tenants with no key row. Only reached when `checked`. */
function keylessClause(check: KeylessCiphertextCheck): string {
  if (!check.checked) return "tenants with no key row were not checked";
  const where = `${check.schema} (per-tenant manifest schemas are not asked)`;
  if (check.columns === 0) return `${where} has no at-rest-encrypted column, so no tenant without a key row holds ciphertext`;
  if (check.found === 0) return `no tenant without a key row holds ciphertext in ${where}`;
  if (!check.keyHeld) return `tenants without a key row hold ciphertext in ${where} that this ring cannot read (reported above)`;
  return `ciphertext held by a tenant without a key row opened under the key this configuration reads it with, in ${where}`;
}

export function formatColumnKeyConsistency(c: ColumnKeyConsistency): ColumnKeyConsistencyLine[] {
  const lines: ColumnKeyConsistencyLine[] = c.findings.map((f) => ({
    level: EFFECT_LEVEL[COLUMN_KEY_CONDITION_EFFECT[f.condition]],
    text: `column keys: ${f.condition.toUpperCase()} — ${f.detail}`,
  }));
  if (c.verdict === "consistent") {
    // Qualified when some sampled rows did not open: "every one" would contradict the warn above it.
    const someCorrupt = c.findings.some((f) => f.condition === "rows_unopenable");
    const keys =
      c.tenantsWithKeys === 0
        ? `no stored data key rows, so ${COLUMN_KEY_MODE_FLAG} ${c.mode} has none it could fail to open`
        : `${c.tenantsWithKeys.toString()} tenant(s) hold a stored data key, and ` +
          (c.mode === "envelope"
            ? "a sample at every key-encryption-key generation opened under this deployment's secret ring"
            : someCorrupt
              ? "every sampled seeded key that opened is a key this secret derives (the rows reported above did not open)"
              : "every one is a seeded key this secret derives, so derived mode reads their columns");
    lines.push({ level: "info", text: `column keys: consistent — ${keys}; ${keylessClause(c.ciphertext)}` });
  } else if (c.verdict === "refuse") {
    lines.push({
      level: "error",
      text:
        "column keys: REFUSED — this configuration cannot open data keys or ciphertext the database already holds; " +
        "booting would answer those tenants' PHI requests with a 500 (no escape hatch: every remedy above " +
        "is a configuration change)",
    });
  }
  return lines;
}
