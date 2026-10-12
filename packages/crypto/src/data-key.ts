/**
 * The per-tenant data key and its envelope.
 *
 * Everything else in this package mints keys that are **derived**: recomputed on demand
 * from the deployment secret and the tenant id, with nothing at rest. This module mints
 * the one key that is not. A data key is generated from `randomBytes` and has no
 * derivation path, so the wrapped copy a deployment stores is the *only* copy — which is
 * the entire reason the envelope exists. A derived key cannot be destroyed; this one can,
 * by destroying the row.
 *
 * The key-encryption key that wraps it *is* derived (`deriveTenantKek`), so the envelope
 * adds no credential to hold — only a row to keep or destroy.
 *
 * This module is **thin over `aeadSeal`/`aeadOpen`**: the wire format, the nonce
 * discipline, the required AAD and the `null`-on-failure rule are all theirs, and nothing
 * here re-states or re-implements them. What it adds is the three things specific to
 * wrapping a key: that the key is random rather than derived, what the wrap is bound to,
 * and how a data key is rendered for the one consumer that takes it as text.
 */

import { randomBytes } from "node:crypto";

import { AEAD_KEY_BYTES, aeadOpen, aeadSeal } from "./aead.js";

/**
 * A data key is itself an AEAD-grade key, so its length is the cipher's rather than a
 * second literal 32 — the same reason `deriveTenantCursorKey` takes its length from here.
 */
export const DATA_KEY_BYTES = AEAD_KEY_BYTES;

/**
 * A wrong-length data key is a **throw**, inheriting `requireAeadKey`'s rule: it is wrong
 * for every input and will never start working, where a failed unwrap is a fact about one
 * stored row. It matters most on `dataKeyToColumnKey`, whose consumer is
 * `pgp_sym_encrypt(plaintext, key)` — that function accepts a key of any length, so a
 * short data key rendered to text would silently encrypt PHI under a weak key and report
 * success.
 *
 * The message carries the two lengths and nothing else — never the key.
 */
function requireDataKey(dek: Uint8Array): void {
  if (dek.length !== DATA_KEY_BYTES) {
    throw new Error(
      `data key must be exactly ${DATA_KEY_BYTES.toString()} bytes, got ${dek.length.toString()}`,
    );
  }
}

/**
 * A fresh data key, from `randomBytes` and **nothing else** — not derived, not seeded from
 * the tenant id, the deployment secret or anything a later process could reconstruct.
 *
 * That is the whole property this module is for, and it is the one thing here that must
 * not be "improved" into a derivation for reproducibility: a key that can be recomputed
 * cannot be destroyed, so wrapping it would buy a row to delete and no consequence for
 * deleting it.
 */
export function generateDataKey(): Uint8Array {
  return randomBytes(DATA_KEY_BYTES);
}

/**
 * What a wrapped data key is bound to, as **canonical JSON of `[tenantId, generation]`**.
 *
 * An array rather than a delimiter-joined string, for `cursorSealAad`'s reason: JSON
 * renders the pair unambiguously by construction, where a joined form would rest on an
 * assumption about which characters a tenant id cannot contain. If that assumption were
 * ever wrong, two different contexts would produce one AAD — and here the consequence is
 * sharper than a cursor's, because the context is *whose data key this is*.
 *
 * The consequence worth stating: a wrapped row copied from one tenant to another does not
 * unwrap, so the table's `tenant_id` column is not the only thing keeping two tenants'
 * keys apart. The generation is in the binding for the same reason — a row cannot be
 * replayed as an earlier generation of itself.
 *
 * It renders; it refuses nothing. There is no argument it could reject that
 * `deriveTenantKek` has not already rejected in producing the KEK this AAD is used with,
 * and a second copy of those checks is a second thing to keep in agreement.
 */
export function dataKeyWrapAad(tenantId: string, generation: number): Uint8Array {
  return Buffer.from(JSON.stringify([tenantId, generation]), "utf8");
}

/**
 * Seals a data key under a key-encryption key, bound to `aad`.
 *
 * @throws Error when `dek` is not `DATA_KEY_BYTES` long, or `kek` not `AEAD_KEY_BYTES`.
 */
export function wrapDataKey(
  kek: Uint8Array,
  dek: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  requireDataKey(dek);
  return aeadSeal(kek, dek, aad);
}

/**
 * Opens a wrapped data key, or answers `null`.
 *
 * **`null` here is a different kind of fact from `aeadOpen`'s other caller's, and a caller
 * must treat it differently.** A cursor that will not open is a client sending the wrong
 * thing, which is ordinary traffic and is answered by refusing that one request. A data
 * key that will not unwrap is a **wrong key-encryption key or a corrupted row** — the
 * deployment's own state, wrong for every request for that tenant until someone fixes it.
 * The caller's obligation is therefore to **refuse**, never to fall back: treating it as
 * "this tenant has no key yet" would generate a second data key and go on serving, which
 * splits one tenant's data across two keys, leaves the rows written under the first
 * unreadable, and reports success throughout.
 *
 * A plaintext that authenticates but is not `DATA_KEY_BYTES` long is folded into the same
 * `null`: it can only arrive from a row this module did not write, it is unusable as a
 * key, and the caller's answer to it — refuse — is already the answer `null` demands.
 */
export function unwrapDataKey(
  kek: Uint8Array,
  wrapped: Uint8Array,
  aad: Uint8Array,
): Uint8Array | null {
  const opened = aeadOpen(kek, wrapped, aad);
  if (opened === null || opened.length !== DATA_KEY_BYTES) return null;
  return opened;
}

/**
 * Renders a data key as the base64 text `pgp_sym_encrypt(plaintext, key)` takes.
 *
 * Base64 and not hex or raw bytes for `deriveTenantColumnKey`'s reason — that consumer
 * takes its key as text — and a named function rather than a `.toString("base64")` at each
 * call site so that there is one definition of how a data key becomes a pgcrypto key.
 * Changing that encoding makes every column already written under this key undecryptable,
 * so it must have exactly one site to change.
 *
 * @throws Error when `dek` is not `DATA_KEY_BYTES` long.
 */
export function dataKeyToColumnKey(dek: Uint8Array): string {
  requireDataKey(dek);
  return Buffer.from(dek).toString("base64");
}
