/**
 * Authenticated encryption over a key held in process.
 *
 * This is the package's **first and only cipher**, and it is deliberately not a
 * `KeyHandle` operation. `KEY_ALGORITHMS`, `KEY_PURPOSES` and `CRYPTO_OPERATIONS`
 * describe the key *registry* — which algorithms a registered key may have, what a
 * registered key may be for, and which key-management acts are audited — so all three
 * stay exactly as they are and `isCryptoOperation("encrypt")` stays false. A key passed
 * here is derived on demand (see `deriveTenantCursorKey`): it has no material at rest,
 * no registry row and no lifecycle, so there is nothing for the registry to hold and
 * nothing for the key-management audit to record. The same argument ADR-0338 made for
 * the derivation applies to using what it derives.
 *
 * **Wire format: `nonce || ciphertext || tag`**, 12 || n || 16. Other code persists and
 * transports these bytes, so the layout is a contract rather than an implementation
 * detail. The nonce is first so `aeadOpen` can slice it off before it knows anything
 * else about the buffer; the tag is last because that is where GCM conceptually leaves
 * it, and because a fixed-width suffix is sliceable without a length prefix. The
 * ciphertext is the only variable-width component, so both ends are addressable from a
 * length alone.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AEAD_ALGORITHM = "aes-256-gcm";
export const AEAD_KEY_BYTES = 32;
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;

/** The smallest buffer that could carry a nonce and a tag: an empty plaintext. */
export const AEAD_MIN_SEALED_BYTES = AEAD_NONCE_BYTES + AEAD_TAG_BYTES;

/**
 * A wrong-length key is a **throw**, where a failed authentication is a `null`. The two
 * are different kinds of fact and must not be answered the same way: a 31-byte key is a
 * deployment bug that is wrong for every input and will never start working, while a
 * failed open is ordinary input. Answering a misconfiguration with `null` would make it
 * indistinguishable from a tampered value, so every request would look like an attack
 * and nothing would name the real cause.
 *
 * The message carries the two lengths and nothing else — never the key.
 */
function requireAeadKey(key: Uint8Array): void {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new Error(
      `${AEAD_ALGORITHM} key must be exactly ${AEAD_KEY_BYTES.toString()} bytes, got ${key.length.toString()}`,
    );
  }
}

/**
 * Seals `plaintext` under `key`, bound to `aad`, as `nonce || ciphertext || tag`.
 *
 * **A fresh random nonce per seal, from `randomBytes`, never a counter.** There is no
 * state in this module and nothing to persist a counter in, so a counter would restart
 * at zero on every process — and GCM nonce reuse under one key is catastrophic rather
 * than merely weakening: two messages under one nonce disclose the XOR of their
 * plaintexts and leak the authentication subkey, which lets an attacker forge tags for
 * messages that were never sealed. A 96-bit random nonce is the construction AES-GCM is
 * specified for and makes the collision probability negligible at any volume this
 * platform will reach. The consequence to accept is that output is non-deterministic:
 * two seals of one plaintext differ, so sealed bytes are not an equality key.
 *
 * **`aad` is required, not optional.** An AEAD used with no associated data is the easy
 * mistake — it still encrypts and still authenticates, so nothing looks wrong, while
 * the seal is valid in every context instead of the one it was issued for. Making the
 * parameter required forces a caller to decide what the seal is bound to. An empty
 * binding stays expressible by passing an empty array, which is then visible at the
 * call site as a decision rather than an omission.
 *
 * @throws Error when `key` is not `AEAD_KEY_BYTES` long.
 */
export function aeadSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  requireAeadKey(key);
  const nonce = randomBytes(AEAD_NONCE_BYTES);
  const cipher = createCipheriv(AEAD_ALGORITHM, key, nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * Opens a buffer sealed by `aeadSeal`, or answers `null`.
 *
 * **`null` is the answer for every rejection, and nothing is thrown for one.** A failed
 * open is *expected input*: the first consumer's `sealed` is a string a client sends
 * back, so a stale value, a value issued under another key, a value bound to another
 * context and a value somebody edited all arrive by the ordinary path. A throw would
 * turn each of them into a 500 — an error class that pages someone — for what is a
 * client sending the wrong thing. A buffer too short to contain a nonce and a tag is
 * the same fact arriving earlier and answers `null` too, rather than reaching
 * `createDecipheriv` with a truncated nonce and throwing from inside it.
 *
 * The `try` covers the decrypt only. Once the key length and the buffer length are
 * settled, the one thing that can throw there is `final()` on an unauthenticated
 * message, so the catch cannot swallow a programming error — and it deliberately
 * inspects nothing about the error and logs nothing, because the only material in
 * scope is the key, the ciphertext and the plaintext.
 *
 * @throws Error when `key` is not `AEAD_KEY_BYTES` long — a deployment bug, not input.
 */
export function aeadOpen(
  key: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Uint8Array | null {
  requireAeadKey(key);
  if (sealed.length < AEAD_MIN_SEALED_BYTES) return null;
  const nonce = sealed.subarray(0, AEAD_NONCE_BYTES);
  const ciphertext = sealed.subarray(
    AEAD_NONCE_BYTES,
    sealed.length - AEAD_TAG_BYTES,
  );
  const tag = sealed.subarray(sealed.length - AEAD_TAG_BYTES);
  const decipher = createDecipheriv(AEAD_ALGORITHM, key, nonce, {
    authTagLength: AEAD_TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}
