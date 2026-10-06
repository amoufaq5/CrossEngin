/**
 * The boot-time decision about at-rest encryption of `phi`/`regulated` fields.
 *
 * This module is the pure decision layer: it surveys the manifest, reads one environment
 * variable's *presence* (never its value, which only `buildColumnKeySource` sees) and says
 * what will happen to PHI and whether the server may start. It issues no SQL and performs
 * no encryption — `ColumnMappedEntityStore` does that in Postgres through
 * `pgp_sym_encrypt(plaintext, key)`, and `@crossengin/crypto` derives the key.
 *
 * What it exists to end is a defect reproduced live on both stores, which failed two
 * different ways and neither of them loudly:
 *
 *   - `--store pg-columns`: every `phi`/`regulated` write was an **HTTP 500**
 *     (`unrecognized configuration parameter "app.column_encryption_key"`). The column
 *     genuinely is `BYTEA` and `DEFAULT_ENCRYPTION_KEY_REF` genuinely reads that GUC —
 *     nothing in the workspace ever set it. So the healthcare pack could not store one
 *     `Patient`, and found out on the first write rather than at boot.
 *   - `--store pg` (the default): the same write returned **201 and stored plaintext**.
 *     ADR-0091 attributes pgcrypto encryption to `ColumnMappedEntityStore` only; the JSONB
 *     store has no encryption at all, and that limitation was documented nowhere.
 *
 * The conversion from a request-time error to a boot refusal is ADR-0334's rule applied
 * again: it made an unservable `duration` field a boot failure naming entity and field,
 * because "serves every other field and 500s on page 1" is the shape of defect that reads
 * as healthy until the one request that matters.
 */

import { deriveTenantColumnKey, parseColumnEncryptionSecret } from "@crossengin/crypto";
import { resolvedFields, type Manifest } from "@crossengin/kernel";
import type { ColumnEncryptionKeySource } from "@crossengin/operate-runtime-pg";
import { requiresEncryptionAtRest } from "@crossengin/types/meta-schema";

/**
 * The deployment secret every tenant's column key is derived from.
 *
 * From the **environment and never from argv**: argv is readable via `ps`, which is
 * ADR-0301's established rule here, and `NOTIFICATION_BOUNCE_SECRET` (ADR-0302) is the
 * precedent for one deployment secret from which a per-tenant key is derived.
 */
export const COLUMN_ENCRYPTION_SECRET_VAR = "COLUMN_ENCRYPTION_SECRET";

/**
 * The opt-out named in every refusal. A constant rather than a string literal per message
 * so the refusal cannot name a flag the CLI does not parse.
 */
export const ALLOW_PLAINTEXT_PHI_FLAG = "--allow-plaintext-phi";

/** How many `entity.field` pairs a `detail` names before it summarises the rest. */
export const DETAIL_FIELD_LIMIT = 5;

export interface PhiField {
  readonly entity: string;
  readonly field: string;
  /**
   * The classification's own spelling (`phi` or `regulated`). Typed `string` because it is
   * carried for the boot line and the refusal text — nothing downstream re-decides from it,
   * and `requiresEncryptionAtRest` is the one place the set is read.
   */
  readonly classification: string;
}

/**
 * Every `phi`/`regulated` field in the manifest, including trait fields.
 *
 * Two things make this the survey rather than a loop over `entity.fields`:
 *
 *   - **`resolvedFields` is what the validator uses.** A classified field arriving through a
 *     trait is a real column, so surveying only `entity.fields` would be a blind spot of
 *     exactly the shape this repo keeps finding — a field `validateManifest` sees and the
 *     survey does not. The resolution rule is the kernel's: an entity's own field of the same
 *     name wins over a trait's, and a name is emitted once.
 *   - **`requiresEncryptionAtRest` is called, not restated.** The set lives in
 *     `ENCRYPT_AT_REST_DATA_CLASSIFICATIONS`; a second copy of it here would be a third
 *     spelling of one rule, and the divergence would be silent in the direction that stores
 *     plaintext.
 *
 * Order is entity declaration order, then resolved field order, so the `detail` a refusal
 * prints is stable across boots and diffable between two manifests.
 */
export function surveyPhiFields(manifest: Manifest): readonly PhiField[] {
  const traits = manifest.traits ?? [];
  const out: PhiField[] = [];
  for (const entity of manifest.entities ?? []) {
    for (const field of resolvedFields(entity, traits)) {
      const classification = field.classification;
      if (classification === undefined) continue;
      if (!requiresEncryptionAtRest(classification)) continue;
      out.push({ entity: entity.name, field: field.name, classification });
    }
  }
  return out;
}

export const PHI_STORAGE_VERDICTS = [
  "no_phi",
  "encrypted",
  "plaintext_accepted",
  "refused_no_secret",
  "refused_plaintext_store",
] as const;
export type PhiStorageVerdict = (typeof PHI_STORAGE_VERDICTS)[number];

/**
 * Whether each verdict permits a boot. A **total map** rather than a comparison against a
 * refusal set, so a sixth verdict is a compile error instead of a new member inheriting
 * whichever branch an `if`-chain happened to end on — `WORKFLOW_WORKER_NEEDS_DEFINITIONS`'
 * shape (ADR-0334), and the direction that matters here is that an unconsidered verdict
 * must not default to "serve".
 */
export const PHI_VERDICT_MAY_SERVE: Readonly<Record<PhiStorageVerdict, boolean>> = {
  no_phi: true,
  encrypted: true,
  plaintext_accepted: true,
  refused_no_secret: false,
  refused_plaintext_store: false,
};

export interface PhiStorageDecision {
  readonly verdict: PhiStorageVerdict;
  readonly fields: readonly PhiField[];
  /** One line for the boot log or the refusal. Names entity.field, never a value. */
  readonly detail: string;
  /** True iff the server may start. */
  readonly mayServe: boolean;
}

export interface PhiStorageInput {
  readonly store: "memory" | "pg" | "pg-columns";
  readonly phiFields: readonly PhiField[];
  readonly secretPresent: boolean;
  readonly allowPlaintextPhi: boolean;
}

/**
 * `entity.field, entity.field (+N more)` — names only. A field *value* must never reach a
 * boot line or a refusal: these are the fields whose whole purpose is that their values are
 * not disclosed, and a log file is a disclosure. The count is always present even when the
 * list is truncated, because the number is what an operator compares between two manifests.
 */
function nameFields(fields: readonly PhiField[]): string {
  const shown = fields.slice(0, DETAIL_FIELD_LIMIT).map((f) => `${f.entity}.${f.field}`);
  const hidden = fields.length - shown.length;
  const suffix = hidden > 0 ? ` (+${hidden.toString()} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function asDecision(
  verdict: PhiStorageVerdict,
  fields: readonly PhiField[],
  detail: string,
): PhiStorageDecision {
  return { verdict, fields, detail, mayServe: PHI_VERDICT_MAY_SERVE[verdict] };
}

/**
 * The decision table, one row per branch, each with the reason it is that way.
 *
 * | store         | phi fields | secret  | allowPlaintextPhi | verdict                   | mayServe |
 * |---------------|------------|---------|-------------------|---------------------------|----------|
 * | any           | none       | any     | any               | `no_phi`                  | yes      |
 * | `pg-columns`  | yes        | present | any               | `encrypted`               | yes      |
 * | `pg-columns`  | yes        | absent  | any               | `refused_no_secret`       | **no**   |
 * | `pg`          | yes        | any     | false             | `refused_plaintext_store` | **no**   |
 * | `pg`          | yes        | any     | true              | `plaintext_accepted`      | yes      |
 * | `memory`      | yes        | any     | false             | `refused_plaintext_store` | **no**   |
 * | `memory`      | yes        | any     | true              | `plaintext_accepted`      | yes      |
 */
export function decidePhiStorage(input: PhiStorageInput): PhiStorageDecision {
  const { store, phiFields, secretPresent, allowPlaintextPhi } = input;

  // Row 1 — no phi/regulated field is declared, so there is nothing to encrypt and no
  // question to answer. Checked first and for every store, because the secret's presence is
  // irrelevant to a manifest that declares no such field: refusing or warning here would
  // make a deployment configure a key for data it does not hold.
  if (phiFields.length === 0) {
    return asDecision(
      "no_phi",
      phiFields,
      "no phi/regulated fields are declared, so at-rest column encryption is not required",
    );
  }

  if (store === "pg-columns") {
    // Row 2 — the typed store encrypts these columns, and the key is derived per tenant from
    // the deployment secret. This is the only configuration in which a PHI write both
    // succeeds and is ciphertext at rest.
    if (secretPresent) {
      return asDecision(
        "encrypted",
        phiFields,
        `${phiFields.length.toString()} phi/regulated field(s) will be encrypted at rest on the ` +
          `column store with a per-tenant key derived from ${COLUMN_ENCRYPTION_SECRET_VAR}: ` +
          nameFields(phiFields),
      );
    }
    // Row 3 — a boot refusal, not a request-time error. Today this deployment serves every
    // other field and 500s on the first PHI write, which is ADR-0334's shape exactly: the
    // honest answer is a boot failure naming entity and field.
    //
    // `allowPlaintextPhi` deliberately does **not** rescue this row. The column is `BYTEA`
    // and the write expression is `pgp_sym_encrypt(…::text, keyRef)`; with no key the
    // statement cannot succeed at all, so "allow plaintext" names an outcome this store
    // cannot produce. Honouring the flag here would be a flag that promises something
    // impossible — the deployment would believe it had opted into plaintext and still get a
    // 500 on every PHI write.
    return asDecision(
      "refused_no_secret",
      phiFields,
      `${COLUMN_ENCRYPTION_SECRET_VAR} is not set and the column store writes ` +
        `${phiFields.length.toString()} phi/regulated field(s) into BYTEA columns through ` +
        `pgp_sym_encrypt, so every write to them would fail: ${nameFields(phiFields)}. ` +
        `${ALLOW_PLAINTEXT_PHI_FLAG} does not apply — a BYTEA column cannot hold plaintext.`,
    );
  }

  // Rows 4-7 — neither remaining store can encrypt at rest. `pg` is the JSONB document
  // store, where a classified value is written into `document` as it arrived (verified
  // live: `document->>'mrn'` reads the plaintext back); `memory` is not a store at all.
  //
  // They share one rule, and `memory` is not softened: a developer loading the healthcare
  // pack should be told once, loudly, at boot rather than discovering the limitation from a
  // document on disk — which is how it has been discovered until now. The opt-out is the
  // same flag for both, so there is one way to say "I know".
  if (allowPlaintextPhi) {
    // Rows 5 and 7 — accepted *because it was asked for*, and still said out loud on every
    // boot. The flag buys the deployment a server that starts; it does not buy silence.
    return asDecision(
      "plaintext_accepted",
      phiFields,
      `--store ${store} cannot encrypt at rest and ${ALLOW_PLAINTEXT_PHI_FLAG} was given, so ` +
        `${phiFields.length.toString()} phi/regulated field(s) will be stored as plaintext: ` +
        nameFields(phiFields),
    );
  }
  // Rows 4 and 6 — refused by default. ADR-0334's reasoning for `--tenant-status-gate`
  // being opt-in is **inverted** here and that inversion is the decision: that gate is off
  // by default because on-by-default would refuse requests of a deployment that works
  // today, whereas *nothing serves PHI correctly today* — `--store pg` returns 201 and
  // stores plaintext — so this refusal breaks no deployment that was doing the right thing.
  // There is no working configuration to preserve, which is what makes the safe default
  // available.
  return asDecision(
    "refused_plaintext_store",
    phiFields,
    `--store ${store} cannot encrypt at rest, so ${phiFields.length.toString()} phi/regulated ` +
      `field(s) would be stored as plaintext: ${nameFields(phiFields)}. Use --store pg-columns ` +
      `with ${COLUMN_ENCRYPTION_SECRET_VAR} set, or pass ${ALLOW_PLAINTEXT_PHI_FLAG} to accept it.`,
  );
}

/**
 * The per-tenant key source `ColumnMappedEntityStore` calls inside each transaction.
 *
 * `parseColumnEncryptionSecret` is called **once, eagerly**, before any closure is returned:
 * a refused secret then fails at boot, naming the measured figures, rather than on the first
 * PHI write — the same conversion `refused_no_secret` makes for an absent one. A lazily
 * validated secret would reproduce the defect this module exists to end, one layer in.
 *
 * The derived key is cached per tenant. Derivation is one HKDF-SHA256 extract-and-expand and
 * is cheap, but it runs on **every transaction** that touches an encrypted column, and a
 * `Map` hit keeps that path allocation-free.
 *
 * The cache is keyed on the **tenant id alone**, deliberately: a `generation` is fixed for the
 * life of one source, so a rotation is expressed by building a new source rather than by
 * invalidating entries. Keying on `${tenantId}:${generation}` would suggest a source can serve
 * two generations at once, which is not what a rotation is — during one, the deployment needs
 * to know which generation a column was written under, and that is `columnKeyFingerprint`'s
 * job, not a cache key's.
 */
export function buildColumnKeySource(
  rawSecret: string,
  opts: { readonly generation?: number } = {},
): ColumnEncryptionKeySource {
  const secret = parseColumnEncryptionSecret(rawSecret);
  const generation = opts.generation;
  const cache = new Map<string, string>();
  return (tenantId: string): string => {
    const hit = cache.get(tenantId);
    if (hit !== undefined) return hit;
    // `deriveTenantColumnKey` is loaded through the same package as the parser so the two
    // cannot disagree about what an acceptable secret is; it refuses an empty tenant id
    // rather than deriving one shared key, and that refusal is allowed to propagate — a
    // transaction with no tenant has no business reading an encrypted column.
    const derived =
      generation === undefined
        ? deriveTenantColumnKey(secret, tenantId)
        : deriveTenantColumnKey(secret, tenantId, generation);
    cache.set(tenantId, derived);
    return derived;
  };
}

/** The boot line. Carries the verdict first, because that is what an operator greps for. */
export function formatPhiStorageDecision(decision: PhiStorageDecision): string {
  const lead = decision.mayServe ? "phi storage" : "phi storage REFUSED";
  return `${lead}: ${decision.verdict} — ${decision.detail}`;
}
