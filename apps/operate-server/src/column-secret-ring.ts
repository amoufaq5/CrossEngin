/**
 * The deployment secret behind every column key, as a **ring** of at most two generations (M-10).
 *
 * One secret derives every tenant's column key in derived mode and every tenant's key-encryption key
 * in envelope mode, and until this module there was no way to change it: a new value made every
 * stored data key unopenable at once. Envelope mode is what makes rotation cheap — the column key a
 * row encrypts under is the *data* key, which a rotation does not touch; only its wrapping changes —
 * so rotating the secret costs one row rewrite per tenant and re-encrypts no column.
 *
 * Three environment variables, never argv (ADR-0301):
 *
 * - `COLUMN_ENCRYPTION_SECRET` — the current secret, at key-encryption-key generation
 *   `COLUMN_ENCRYPTION_SECRET_GENERATION` (default 1, so a deployment that never rotated is
 *   unchanged: every row it wrote records generation 1 and is derived exactly as before);
 * - `COLUMN_ENCRYPTION_SECRET_PREVIOUS` — the secret one generation back, held only until every row
 *   is re-wrapped. Rows still naming it open under it; every row written or re-wrapped names the
 *   current one.
 *
 * The previous generation is always `current - 1`, so it is never stated twice: a pair that can be
 * declared independently can be declared inconsistently, which is ADR-0358's reason for deriving the
 * public half of a key rather than accepting it.
 *
 * **Derived mode refuses a previous secret**, because it has no wrapping to change: its column keys
 * are derived straight from the secret, so a new secret is a new key for every ciphertext. Its
 * rotation route is to move to envelope mode first (seeded from the secret the ciphertext is under)
 * and rotate there.
 *
 * **No KMS.** Both secrets are held by this process and every key is derived in-process; a KEK held
 * outside the database and the process is the one thing that would make a destroyed key
 * unrecoverable from every backup, and it is out of scope here.
 */
import { deriveTenantKek, parseColumnEncryptionSecret } from "@crossengin/crypto";

import { COLUMN_ENCRYPTION_SECRET_VAR } from "./column-encryption.js";
import type { ColumnKeyMode } from "./data-key-envelope.js";

export const COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR = "COLUMN_ENCRYPTION_SECRET_PREVIOUS";
export const COLUMN_ENCRYPTION_SECRET_GENERATION_VAR = "COLUMN_ENCRYPTION_SECRET_GENERATION";

/** Why a ring could not be built. Never carries a secret's value. */
export const COLUMN_SECRET_RING_REFUSALS = [
  "generation_malformed",
  "previous_needs_generation",
  "previous_identical",
  "previous_in_derived_mode",
  "generation_in_derived_mode",
] as const;
export type ColumnSecretRingRefusal = (typeof COLUMN_SECRET_RING_REFUSALS)[number];

export class ColumnSecretRingRefused extends Error {
  constructor(
    readonly reason: ColumnSecretRingRefusal,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "ColumnSecretRingRefused";
  }
}

export interface ColumnSecretRing {
  readonly current: Uint8Array;
  readonly currentGeneration: number;
  /** `null` when no rotation is in progress. */
  readonly previous: Uint8Array | null;
}

function parseGeneration(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]{0,8}$/.test(trimmed)) {
    throw new ColumnSecretRingRefused(
      "generation_malformed",
      `${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR} must be a positive integer, got "${trimmed}"`,
    );
  }
  return Number(trimmed);
}

/**
 * Builds the ring from the environment. Called only once a column secret is known to be wanted;
 * each secret goes through `parseColumnEncryptionSecret`, so a weak previous secret is refused by
 * the same rule as a weak current one.
 */
export function resolveColumnSecretRing(
  env: Readonly<Record<string, string | undefined>>,
  mode: ColumnKeyMode,
): ColumnSecretRing {
  const current = parseColumnEncryptionSecret(env[COLUMN_ENCRYPTION_SECRET_VAR] ?? "");
  const currentGeneration = parseGeneration(env[COLUMN_ENCRYPTION_SECRET_GENERATION_VAR]);
  const rawPrevious = env[COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR] ?? "";
  // Derived mode reads no generation, so a value other than 1 would be a variable that changes
  // nothing — and it would break the one fact `seedSecretOf` rests on: ciphertext written in derived
  // mode is under the secret an envelope deployment calls generation 1.
  if (mode === "derived" && currentGeneration !== 1 && rawPrevious.trim() === "") {
    throw new ColumnSecretRingRefused(
      "generation_in_derived_mode",
      `${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR} is ${currentGeneration.toString()} but ` +
        "--column-key-mode derived reads no generation; unset it (generations exist only in " +
        "envelope mode, starting at 1)",
    );
  }
  if (rawPrevious.trim() === "") return { current, currentGeneration, previous: null };
  if (mode === "derived") {
    throw new ColumnSecretRingRefused(
      "previous_in_derived_mode",
      `${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR} is set but --column-key-mode derived derives every ` +
        "column key straight from the secret, so a new secret is a new key for every existing " +
        "ciphertext. Rotate in envelope mode: keep the old value as " +
        `${COLUMN_ENCRYPTION_SECRET_VAR}, switch to --column-key-mode envelope, then rotate.`,
    );
  }
  if (currentGeneration < 2) {
    throw new ColumnSecretRingRefused(
      "previous_needs_generation",
      `${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR} is set, so ${COLUMN_ENCRYPTION_SECRET_GENERATION_VAR} ` +
        "must name the new secret's generation (at least 2); the previous one is that minus one",
    );
  }
  const previous = parseColumnEncryptionSecret(rawPrevious);
  if (Buffer.from(previous).equals(Buffer.from(current))) {
    throw new ColumnSecretRingRefused(
      "previous_identical",
      `${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR} equals ${COLUMN_ENCRYPTION_SECRET_VAR}: that is not ` +
        "a rotation, and would label two generations with one key",
    );
  }
  return { current, currentGeneration, previous };
}

/**
 * The key-encryption-key resolver a `PostgresDataKeyStore` opens rows with. Throws for a generation
 * the ring holds no secret for, which the store reports as `DataKeyKekUnavailable`.
 */
export function kekResolverFor(ring: ColumnSecretRing): (tenantId: string, g: number) => Uint8Array {
  return (tenantId, kekGeneration) => {
    if (kekGeneration === ring.currentGeneration) {
      return deriveTenantKek(ring.current, tenantId, kekGeneration);
    }
    if (ring.previous !== null && kekGeneration === ring.currentGeneration - 1) {
      return deriveTenantKek(ring.previous, tenantId, kekGeneration);
    }
    throw new Error(
      `no secret for key-encryption-key generation ${kekGeneration.toString()} ` +
        `(this deployment holds ${ringGenerations(ring).join(" and ")})`,
    );
  };
}

function ringGenerations(ring: ColumnSecretRing): string[] {
  return ring.previous === null
    ? [String(ring.currentGeneration)]
    : [String(ring.currentGeneration - 1), String(ring.currentGeneration)];
}

/**
 * The secret a tenant's first data key is seeded from when it may already hold derived-mode
 * ciphertext, or `null` when this ring no longer holds it.
 *
 * Derived mode reads no generation and refuses a previous secret, so ciphertext it wrote is under
 * the secret an envelope deployment calls **generation 1**: the current secret at generation 1, the
 * previous one during the first rotation, and **neither** once that rotation completes and the
 * previous secret is unset. Answering the current secret there — what "previous, else current" did —
 * seeds such a tenant with a key its ciphertext is not under, so every read of it fails and every new
 * write lands under a second key. The caller refuses instead (`ColumnKeySeedUnavailable`).
 */
export function seedSecretOf(ring: ColumnSecretRing): Uint8Array | null {
  if (ring.currentGeneration === 1) return ring.current;
  if (ring.currentGeneration === 2 && ring.previous !== null) return ring.previous;
  return null;
}

/** The boot line. Names generations and variables, never a value. */
export function formatColumnSecretRing(ring: ColumnSecretRing): string {
  if (ring.previous === null) {
    return (
      `column secret: key-encryption-key generation ${ring.currentGeneration.toString()} from ` +
      `${COLUMN_ENCRYPTION_SECRET_VAR}; no rotation in progress`
    );
  }
  return (
    `column secret: ROTATING — new rows and re-wraps use generation ` +
    `${ring.currentGeneration.toString()} (${COLUMN_ENCRYPTION_SECRET_VAR}); rows wrapped under ` +
    `generation ${(ring.currentGeneration - 1).toString()} still open under ` +
    `${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR} and are re-wrapped as they are read. Run ` +
    "`operate-server rekey --rewrap-kek --tenant <id>` for each tenant, then unset " +
    `${COLUMN_ENCRYPTION_SECRET_PREVIOUS_VAR}.` +
    (ring.currentGeneration === 2
      ? " A tenant that answers no_data_key_row there but holds ciphertext from derived mode is " +
        "seeded from the previous secret only while it is set: serve it once before unsetting, or " +
        "its first request afterwards is refused (ColumnKeySeedUnavailable)."
      : "")
  );
}
