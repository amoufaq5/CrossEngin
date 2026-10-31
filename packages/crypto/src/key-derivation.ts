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
 * The three derivations are separated **only** by their info strings, which is what keeps
 * one compromise from being three: a leaked cursor key must not decrypt a PHI column, and
 * a leaked key-encryption key must not be either. Each new consumer therefore gets its own
 * `*_KEY_DERIVATION_INFO`, never a reuse of another's.
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
 * The info string for the key-encryption key that wraps a per-tenant data key. A third
 * label and not a reuse of either: see the module header. The KEK is derived from the
 * **same** deployment secret as the column key, so the info string is the entire
 * separation between a key that encrypts PHI and a key that encrypts the key that
 * encrypts PHI — which is why there is no parser and no second variable for it.
 */
export const KEK_KEY_DERIVATION_INFO = "crossengin.key-encryption.v1";

/**
 * The info string for a request-signing key, salted by **key id** rather than by tenant.
 *
 * A fourth label and not a reuse of any of the three, per the module header — but it differs from
 * them on an axis none of those three has, and the difference is the whole of why this one is
 * derived rather than stored. The column, cursor and key-encryption keys are **never disclosed**:
 * they exist only inside this process. A request-signing key is the opposite — it is handed to a
 * client, which is the only way a symmetric signature can work — so its secrecy rests on the key id
 * being the unit of issuance and revocation, not on the key never leaving.
 *
 * Deriving it therefore buys exactly what it buys for the bounce webhook (ADR-0302's
 * `HMAC-SHA256(platform_secret, "bounce-webhook:" || tenantId)`): one deployment secret instead of
 * N stored ones, and no column anywhere holding material a reader could sign with. It does **not**
 * buy per-key rotation — a key id's secret is a pure function of the deployment secret and the id,
 * so rotating one client means issuing a new key id, which is the honest unit anyway and is what
 * `meta.crypto_keys.key_version` and `rotated_from_key_id` already model for a stored key.
 *
 * Salted by key id because the key id is what the wire carries and what the verifier is told: a
 * tenant-salted key would make every key id in a tenant interchangeable, which is precisely the
 * collision `principals.ts` records as unfixable for an api-key spec.
 */
export const REQUEST_SIGNING_KEY_DERIVATION_INFO = "crossengin.request-signing.v1";

/**
 * The human names the refusals use. A deployment reading `column encryption secret
 * refused` while it was configuring the cursor secret would be sent to the wrong
 * variable, which is the whole reason the label is a parameter.
 *
 * The key-encryption label names a *role* rather than a variable, because the KEK has no
 * variable of its own: a deployment turning the envelope on supplies no new secret, so
 * the operator reading this refusal is being told which derivation refused, and the
 * secret to fix is `COLUMN_ENCRYPTION_SECRET` either way.
 */
const COLUMN_SECRET_LABEL = "column encryption secret";
const CURSOR_SECRET_LABEL = "list-cursor encryption secret";
const CREDENTIAL_PEPPER_LABEL = "credential pepper";
const REQUEST_SIGNING_SECRET_LABEL = "request-signing secret";
// Names the variable as well as the role, unlike its two siblings, and the asymmetry is the point:
// those two each have an environment variable of their own, so naming the role points at it. The KEK
// has none — it reads `COLUMN_ENCRYPTION_SECRET`, which is what makes the envelope a mode switch
// rather than a new credential — so a refusal saying only "key-encryption secret" would name a
// variable that does not exist and send an operator looking for it.
const KEK_SECRET_LABEL = "key-encryption secret (COLUMN_ENCRYPTION_SECRET)";

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

/**
 * The marker every `deploy/.env.example` placeholder carries, matched case-sensitively at the
 * start of the value (ADR-0377).
 *
 * It exists because `REPLACE_WITH_32_PLUS_RANDOM_CHARS` is **33 bytes with 19 distinct byte
 * values** and therefore passes both floors below — so until this refusal, a deployment that
 * copied `.env.example` and replaced the one secret the binary happens to reject
 * (`OPERATE_TOKEN_SIGNING_KEY`'s placeholder is 31 chars, so it fails a length check of its own)
 * booted with every *other* secret derived from a string committed to a public repository. The
 * damage is worse than a weak secret: a placeholder is **accepted**, so the surfaces that report
 * on the secret switch from a true warning to a confident "sealed", which is the falsely-true
 * control direction this repo ranks as the dangerous one (ADR-0337). It was measured as live for
 * `CREDENTIAL_PEPPER`, which `meta.users` has no RLS to fall back on, and would have been created
 * for `CURSOR_ENCRYPTION_SECRET` by the very change that was uncommenting it.
 *
 * A **prefix** and not an exact match, because the three placeholders differ after it and a list
 * of exact strings is a maintained list in another package (ADR-0288's shape, wrong three times
 * here). A real secret beginning with these fourteen characters is refused, which is the correct
 * direction: the remedy is to generate one, and the refusal prints how.
 */
export const SECRET_PLACEHOLDER_PREFIX = "REPLACE_WITH_";

export const COLUMN_SECRET_REFUSAL_REASONS = [
  "too_short",
  "too_uniform",
  "unreplaced_placeholder",
] as const;
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
  // Checked **first**, because the placeholder passes both floors below and a deployment that
  // never replaced it would otherwise be told nothing at all. Decoded back to text rather than
  // compared against bytes: the caller has already encoded, and the comparison is about a literal
  // an operator typed, so reading it as text is what the check is actually about.
  if (new TextDecoder().decode(bytes).startsWith(SECRET_PLACEHOLDER_PREFIX)) {
    throw new ColumnSecretRefused(
      "unreplaced_placeholder",
      `secret is still the placeholder from deploy/.env.example; generate one with ` +
        `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'`,
      label,
    );
  }
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
 * The same validation for the credential pepper -- the deployment secret HMAC'd into a password
 * before scrypt stretches it, so that reading `meta.users` is not enough to attack the hashes.
 *
 * A third parser rather than a second floor, which is `refuseWeakSecret`'s own stated intent: a
 * secret good enough for a PHI column is good enough here, and only the variable an operator is
 * told to fix differs. The floor applies to the **deployment's** secret and explicitly not to a
 * user's password -- a 32-byte, 16-distinct-byte minimum would be a hostile password rule, and
 * `password.ts` deliberately imposes none.
 *
 * Returns bytes for the other two parsers' symmetry, though `hashPassword` takes the pepper as a
 * string: the HMAC key is the raw UTF-8 either way, so a caller validating here and passing the
 * original string is keying on exactly these bytes.
 *
 * @throws ColumnSecretRefused `too_short` or `too_uniform`.
 */
export function parseCredentialPepper(raw: string): Uint8Array {
  const bytes = new TextEncoder().encode(raw);
  refuseWeakSecret(bytes, CREDENTIAL_PEPPER_LABEL);
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

function kekKeyInfo(generation: number): string {
  return `${KEK_KEY_DERIVATION_INFO}:gen${generation.toString()}`;
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
 * HKDF-SHA256(ikm = secret, salt = tenantId utf8,
 * info = `${KEK_KEY_DERIVATION_INFO}:gen${generation}`, `AEAD_KEY_BYTES`), as **raw
 * bytes** — the key-encryption key that `wrapDataKey` seals a per-tenant data key under.
 *
 * **The same deployment secret as the column key, separated only by the info string.**
 * That makes the envelope a *mode switch* rather than a new credential: a deployment
 * enabling it deploys nothing, and so cannot reach the half-configured state where a data
 * key is wrapped under a key-encryption key nobody has — which, for a key that exists only
 * wrapped, would be indistinguishable from the key having been destroyed. The separation
 * that does the work is the label, exactly as it is between the column and cursor keys.
 *
 * Bytes and not base64, for `deriveTenantCursorKey`'s reason: the consumer is `aeadSeal`
 * in this process and takes bytes.
 *
 * Salt and generation discipline, and the refusal of an empty `tenantId`, are
 * `deriveTenantColumnKey`'s.
 */
export function deriveTenantKek(
  secret: Uint8Array,
  tenantId: string,
  generation: number = DEFAULT_KEY_GENERATION,
): Uint8Array {
  refuseWeakSecret(secret, KEK_SECRET_LABEL);
  requireDerivationArguments(tenantId, generation);
  return new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      new TextEncoder().encode(tenantId),
      new TextEncoder().encode(kekKeyInfo(generation)),
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

/**
 * The same validation for the request-signing deployment secret, differing only in the variable
 * the refusal names. A fourth parser for `parseCredentialPepper`'s stated reason: a secret good
 * enough for a PHI column is good enough here, and only the name an operator is told to fix
 * differs.
 *
 * @throws ColumnSecretRefused `unreplaced_placeholder`, `too_short` or `too_uniform`.
 */
export function parseRequestSigningSecret(raw: string): Uint8Array {
  const bytes = new TextEncoder().encode(raw);
  refuseWeakSecret(bytes, REQUEST_SIGNING_SECRET_LABEL);
  return bytes;
}

/**
 * HKDF-SHA256(ikm = secret, salt = keyId utf8, info = `REQUEST_SIGNING_KEY_DERIVATION_INFO`,
 * `AEAD_KEY_BYTES`) — the shared secret a client signs a request with.
 *
 * **No generation parameter**, which is the one place this departs from its three siblings and is
 * a decision rather than an omission. A generation is a *context for one key* there, so that a
 * tenant's ciphertext can be re-encrypted from generation N to N+1 while the tenant stays the
 * same. Here the key is held by a client: there is nothing to re-encrypt, and a second generation
 * for one key id would mean two secrets simultaneously valid for one credential — a window in
 * which a revoked key still works, which is the opposite of what issuing a new key id buys. So
 * **the key id is the generation**, and `deriveRequestSigningKey(s, "k1")` is total.
 *
 * Bytes and not base64, for `deriveTenantCursorKey`'s reason: the consumer is `hmacSha256Hex` in
 * this process and takes bytes. `AEAD_KEY_BYTES` is 32, comfortably above `hmacSha256Hex`'s
 * 16-byte floor, so a derived key can never be refused by the primitive it is derived for.
 *
 * The key id is refused empty rather than salted with nothing — an empty salt is legal HKDF, so
 * without the check every unnamed key would share one secret, which is the collision this
 * derivation is salted by key id to prevent.
 */
export function deriveRequestSigningKey(secret: Uint8Array, keyId: string): Uint8Array {
  refuseWeakSecret(secret, REQUEST_SIGNING_SECRET_LABEL);
  if (keyId.length === 0) {
    throw new Error("keyId must be non-empty: an empty salt would give every key one secret");
  }
  return new Uint8Array(
    hkdfSync(
      "sha256",
      secret,
      new TextEncoder().encode(keyId),
      new TextEncoder().encode(REQUEST_SIGNING_KEY_DERIVATION_INFO),
      AEAD_KEY_BYTES,
    ),
  );
}
