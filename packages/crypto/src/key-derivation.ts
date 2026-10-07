/**
 * Derivation of per-tenant keys from one deployment secret.
 *
 * This module is a **key-derivation function, not a cipher**. The column key it mints
 * is the text key `pgcrypto`'s `pgp_sym_encrypt(plaintext, key)` takes, so that
 * encryption happens in Postgres; the cursor key it mints is consumed by `aeadSeal` in
 * this process. Nothing here encrypts, decrypts or wraps anything.
 * `KEY_ALGORITHMS`, `KEY_PURPOSES` and `CRYPTO_OPERATIONS` are deliberately untouched —
 * they describe the key *registry*, and no key derived here is ever registered.
 *
 * A derived key is deliberately **not** a `KeyHandle`. A handle exists so a key with
 * material at rest can be registered, rotated, revoked and audited by reference; these
 * keys have no material at rest. They are recomputed on demand from the deployment
 * secret and the tenant id, so there is no registry row to keep, no public half to
 * publish, and nothing stored that a database read could disclose. Rotation is
 * expressed by the generation in the HKDF info string rather than by a lifecycle
 * record. The only thing that must be protected is the deployment secret itself.
 *
 * The two derivations are separated **only** by their info strings, which is what keeps
 * one compromise from being two: a leaked cursor key must not decrypt a PHI column.
 * Each new consumer therefore gets its own `*_KEY_DERIVATION_INFO`, never a reuse of
 * another's.
 */

import { hkdfSync } from "node:crypto";

import { AEAD_KEY_BYTES } from "./aead.js";
import { sha256 } from "./hashing.js";

/** HKDF-SHA256 info string. The generation suffix makes a rotation expressible. */
export const COLUMN_KEY_DERIVATION_INFO = "crossengin.column-encryption.v1";

/**
 * The info string for the entity-list cursor key. A separate label and not a reuse of
 * the column one: see the module header.
 */
export const CURSOR_KEY_DERIVATION_INFO = "crossengin.list-cursor.v1";

/**
 * The human names the two refusals use. A deployment reading `column encryption secret
 * refused` while it was configuring the cursor secret would be sent to the wrong
 * variable, which is the whole reason the label is a parameter.
 */
const COLUMN_SECRET_LABEL = "column encryption secret";
const CURSOR_SECRET_LABEL = "list-cursor encryption secret";

export const MIN_COLUMN_SECRET_BYTES = 32;

/**
 * Below this many distinct byte values a secret is a length-check being satisfied
 * rather than entropy being supplied. See `parseColumnEncryptionSecret`.
 */
export const MIN_COLUMN_SECRET_DISTINCT_BYTES = 16;

export const COLUMN_KEY_BYTES = 32;

/**
 * The generation used when a caller names none. A named constant rather than a bare
 * `1` so a rotation is a change of argument, not an invented string: every call site
 * and every test already agrees on what generation 1 means.
 */
export const DEFAULT_KEY_GENERATION = 1;

/**
 * The scope string standing in for "no tenant". Platform scope has to be spelled
 * explicitly because an empty salt is not a scope — HKDF substitutes a zero-filled
 * block for an absent salt, so `""` and "platform" would otherwise be two names for
 * one key.
 */
export const PLATFORM_COLUMN_KEY_SCOPE = "platform";

export const COLUMN_SECRET_REFUSAL_REASONS = ["too_short", "too_uniform"] as const;
export type ColumnSecretRefusalReason =
  (typeof COLUMN_SECRET_REFUSAL_REASONS)[number];

/**
 * The refusal for **every** deployment secret this module validates, not only the
 * column one — the name is now narrower than the class. Kept deliberately: renaming it
 * is 38 references across four files for a cosmetic gain, and the message is
 * parameterised instead, so an operator is sent to the right variable even though the
 * class they catch is misnamed. The imprecision is recorded as a follow-up rather than
 * fixed here.
 *
 * `label` defaults to the column secret because the only construction sites are the two
 * refusals in `refuseWeakSecret`, which both pass it explicitly, and because the
 * default is the behaviour every existing caller already saw.
 */
export class ColumnSecretRefused extends Error {
  readonly reason: ColumnSecretRefusalReason;

  constructor(
    reason: ColumnSecretRefusalReason,
    detail: string,
    label: string = COLUMN_SECRET_LABEL,
  ) {
    super(`${label} refused (${reason}): ${detail}`);
    this.name = "ColumnSecretRefused";
    this.reason = reason;
  }
}

export function isColumnSecretRefusalReason(
  value: unknown,
): value is ColumnSecretRefusalReason {
  return (
    typeof value === "string" &&
    (COLUMN_SECRET_REFUSAL_REASONS as readonly string[]).includes(value)
  );
}

/**
 * The one validator. Every parser and every derivation in this module calls it, so a
 * caller that skipped the parser cannot derive from a secret the parser would have
 * refused, and no two of them can drift into disagreeing about what an acceptable
 * deployment secret is. There is one floor, so a secret good enough for a PHI column is
 * good enough for a cursor and vice versa; `label` changes only which variable the
 * operator is told to fix.
 *
 * It **refuses**; it never pads, stretches or hashes a weak secret up to length. A
 * padded secret has exactly the entropy it arrived with and would read as compliant
 * in every later check, which is worse than failing to boot.
 *
 * Neither refusal's detail may contain any part of the secret — only the measured
 * figures, which is what an operator needs to fix it.
 */
function refuseWeakSecret(bytes: Uint8Array, label: string): void {
  if (bytes.length < MIN_COLUMN_SECRET_BYTES) {
    throw new ColumnSecretRefused(
      "too_short",
      `secret is ${bytes.length.toString()} bytes of UTF-8; minimum is ${MIN_COLUMN_SECRET_BYTES.toString()}`,
      label,
    );
  }
  const distinct = new Set(bytes).size;
  if (distinct < MIN_COLUMN_SECRET_DISTINCT_BYTES) {
    throw new ColumnSecretRefused(
      "too_uniform",
      `secret has ${distinct.toString()} distinct byte value(s) across ${bytes.length.toString()} bytes; minimum is ${MIN_COLUMN_SECRET_DISTINCT_BYTES.toString()}`,
      label,
    );
  }
}

/**
 * Validates and returns the deployment secret's bytes.
 *
 * The secret is read as **raw UTF-8 bytes, not base64**. The precedent is
 * `NOTIFICATION_BOUNCE_SECRET` (ADR-0302), which is a plain string: requiring base64
 * would add a decode failure mode — and a silent one, since most ASCII passphrases
 * are not valid base64 and some are — for no security gain, because HKDF's IKM is
 * fed through an extract step and need not be uniformly random.
 *
 * @throws ColumnSecretRefused `too_short` or `too_uniform`.
 */
export function parseColumnEncryptionSecret(raw: string): Uint8Array {
  const bytes = new TextEncoder().encode(raw);
  refuseWeakSecret(bytes, COLUMN_SECRET_LABEL);
  return bytes;
}

/**
 * The same validation for the list-cursor deployment secret, differing only in the
 * variable the refusal names. Read as raw UTF-8 bytes for
 * `parseColumnEncryptionSecret`'s reasons.
 *
 * @throws ColumnSecretRefused `too_short` or `too_uniform`.
 */
export function parseCursorEncryptionSecret(raw: string): Uint8Array {
  const bytes = new TextEncoder().encode(raw);
  refuseWeakSecret(bytes, CURSOR_SECRET_LABEL);
  return bytes;
}

/**
 * The HKDF info string for a generation. Rotation lives here, in the context label,
 * because every generation is derived from the same deployment secret for the same
 * tenant — the generation is a *context* for one key, not a separator between
 * independent instances of one.
 */
function columnKeyInfo(generation: number): string {
  return `${COLUMN_KEY_DERIVATION_INFO}:gen${generation.toString()}`;
}

function cursorKeyInfo(generation: number): string {
  return `${CURSOR_KEY_DERIVATION_INFO}:gen${generation.toString()}`;
}

/**
 * The salt and generation checks both derivations share, extracted so a second
 * derivation cannot be written with one of them weaker than the other. Neither detail
 * may contain the secret or the derived key; `tenantId` and `generation` are a caller's
 * own arguments and are quoted so the operator can see what was passed.
 */
function requireDerivationArguments(tenantId: string, generation: number): void {
  if (tenantId.length === 0) {
    throw new Error(
      `tenantId must be non-empty; platform scope is spelled "${PLATFORM_COLUMN_KEY_SCOPE}"`,
    );
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(
      `generation must be an integer >= 1, got ${String(generation)}`,
    );
  }
}

/**
 * HKDF-SHA256(ikm = secret, salt = tenantId utf8, info = `${INFO}:gen${generation}`,
 * 32 bytes), base64-encoded.
 *
 * Base64 and not hex or raw bytes because the consumer is
 * `pgp_sym_encrypt(plaintext, key)`, which takes the key as **text**.
 *
 * **The tenant id is the salt and the generation is in the info, not the reverse.**
 * HKDF's salt is the per-instance separator — the value that makes two derivations
 * from one IKM independent — and the info is the context label that binds a key to
 * what it is for. A tenant is exactly a separate instance; a generation is exactly a
 * context. Swapping them would still produce distinct keys, so nothing would look
 * broken, but two tenants' keys would then differ only in a field whose job is to
 * label purpose, and the salt — the field the extract step is built around — would
 * carry a value shared by the whole deployment.
 *
 * Platform scope is spelled by passing `PLATFORM_COLUMN_KEY_SCOPE`. An empty
 * `tenantId` is refused rather than treated as platform scope: HKDF substitutes a
 * zero-filled block for an absent salt, so an accidentally-empty tenant id would
 * derive one shared key across every caller that had it, silently.
 */
export function deriveTenantColumnKey(
  secret: Uint8Array,
  tenantId: string,
  generation: number = DEFAULT_KEY_GENERATION,
): string {
  refuseWeakSecret(secret, COLUMN_SECRET_LABEL);
  requireDerivationArguments(tenantId, generation);
  const derived = hkdfSync(
    "sha256",
    secret,
    new TextEncoder().encode(tenantId),
    new TextEncoder().encode(columnKeyInfo(generation)),
    COLUMN_KEY_BYTES,
  );
  return Buffer.from(derived).toString("base64");
}

/**
 * HKDF-SHA256(ikm = secret, salt = tenantId utf8,
 * info = `${CURSOR_KEY_DERIVATION_INFO}:gen${generation}`, `AEAD_KEY_BYTES`), as **raw
 * bytes**.
 *
 * Bytes and not base64, which is the one place this differs from
 * `deriveTenantColumnKey`: that key is base64 *because* its consumer is
 * `pgp_sym_encrypt(plaintext, key)` and takes the key as text, while this one's
 * consumer is `aeadSeal` in this process and takes it as bytes. Encoding here would be
 * an encode-then-decode round trip whose two ends can disagree about padding, for no
 * reader in between.
 *
 * The length is `AEAD_KEY_BYTES` rather than a second literal 32, so the derivation
 * cannot drift from the cipher that consumes it.
 *
 * Salt and info discipline, and the refusal of an empty `tenantId`, are
 * `deriveTenantColumnKey`'s — see its doc for why the tenant is the salt and the
 * generation is the info, and not the reverse.
 */
export function deriveTenantCursorKey(
  secret: Uint8Array,
  tenantId: string,
  generation: number = DEFAULT_KEY_GENERATION,
): Uint8Array {
  refuseWeakSecret(secret, CURSOR_SECRET_LABEL);
  requireDerivationArguments(tenantId, generation);
  return new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      new TextEncoder().encode(tenantId),
      new TextEncoder().encode(cursorKeyInfo(generation)),
      AEAD_KEY_BYTES,
    ),
  );
}

/**
 * sha256 of the derived key, first 16 hex chars — safe to log; the key itself never
 * is. 64 bits of a preimage-resistant digest identifies which key a column was
 * written under (so a rotation is checkable from a log line) and discloses nothing
 * about a 256-bit key.
 */
export function columnKeyFingerprint(derivedKey: string): string {
  if (derivedKey.length === 0) {
    throw new Error("columnKeyFingerprint requires a non-empty derived key");
  }
  return sha256(derivedKey).slice(0, 16);
}
