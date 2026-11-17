import {
  verifyChainEntrySignature,
  type ChainedLogEntry,
} from "@crossengin/forensics";
import type { UnreadableRow } from "@crossengin/kernel-pg";

import type { PostgresChainLogReader } from "./chain-log-store.js";

/**
 * Resolves a signing-key fingerprint to its base64 Ed25519 public key, or null when the fingerprint
 * is unknown. A thin adapter over `@crossengin/crypto-pg`'s `PostgresKeyRegistry` satisfies this —
 * `{ resolveByFingerprint: async (fp) => (await registry.getByFingerprint(fp))?.publicKeyBase64 ?? null }`
 * — kept as a structural interface here so forensics-pg stays decoupled from crypto-pg.
 */
export interface PublicKeyResolver {
  resolveByFingerprint(fingerprint: string): Promise<string | null>;
  /**
   * Whether this resolver vouches for the key a fingerprint names, asked **before** resolving it.
   * Present on a pinned resolver and absent on the registry one, and the absence is the registry's
   * real semantics rather than a permissive default: a registry resolves whatever is registered in
   * scope, which is exactly why it cannot be the trust root — a tenant-context session can insert a
   * key into `meta.crypto_keys` and sign a forged entry under it (H-18).
   */
  trusts?(fingerprint: string): boolean;
}

/**
 * A resolver over the deployment's own chain keys and nothing else. It reads no table: the keys
 * come from the deployment's configuration, so a row a database writer adds to `meta.crypto_keys`
 * cannot make an entry it signed verify. An entry signed by any other key is `untrusted_key` —
 * distinct from `unresolved_key`, because "this deployment did not sign this" and "the registry has
 * no row for this key" send an operator to different places.
 */
export function pinnedKeyResolver(trustedKeys: ReadonlyMap<string, string>): PublicKeyResolver {
  return {
    trusts: (fingerprint) => trustedKeys.has(fingerprint),
    resolveByFingerprint: async (fingerprint) => trustedKeys.get(fingerprint) ?? null,
  };
}

export const ENTRY_SIGNATURE_FAILURES = ["unresolved_key", "untrusted_key", "bad_signature"] as const;
export type EntrySignatureFailure = (typeof ENTRY_SIGNATURE_FAILURES)[number];

export interface EntrySignatureResult {
  readonly sequenceNumber: number;
  readonly fingerprint: string;
  readonly ok: boolean;
  readonly reason?: EntrySignatureFailure;
}

export interface ChainSignatureVerdict {
  readonly valid: boolean;
  readonly checked: number;
  readonly results: readonly EntrySignatureResult[];
  readonly unresolvedFingerprints: readonly string[];
  /**
   * Rows the contract refuses, which no append path could have written: both parse
   * `ChainAppendInputSchema` before any statement. Its own axis rather than an
   * `EntrySignatureResult` with a third `reason`, because that shape requires a `fingerprint` and
   * the fingerprint is one of the columns whose unreadability lands a row here — reporting `""` for
   * it would read as a value (ADR-0331's rule inside a verdict).
   */
  readonly unreadable: readonly UnreadableRow[];
}

/**
 * Per-entry signature verification, and the rows that could not be read.
 *
 * `unreadable` is a **required** third parameter, and that is the fence this increment turns on.
 * Blanking a chain entry's `actor_reference` is a genuine signature-breaking tamper — the field is
 * inside `canonicalEntryBytes`, and no CHECK refused `''` — and this function is the **only** check
 * in the stack that binds an entry's stored columns to its content (ADR-0371: both folds compare a
 * stored `priorEntryHash` against a stored `entryHash` and recompute neither). So a reader that
 * threw on the refused row stopped the one detector that could see the tamper, and a reader that
 * silently dropped it would hand this function a shorter array it would pronounce `valid`.
 * Required, so the compiler names every caller that has loaded a chain and must now say what in it
 * did not read — an optional parameter defaulting to `[]` would be that silence restored as a
 * default (ADR-0364's addendum, ADR-0371's `onRefused`).
 *
 * `checked` stays the number of entries actually examined, which is ADR-0371's point about zero
 * being a readable figure: `checked: 2` beside one unreadable row says what happened, where
 * `checked: 3` would claim an examination that did not occur.
 */
export async function verifyChainSignatures(
  entries: readonly ChainedLogEntry[],
  resolver: PublicKeyResolver,
  unreadable: readonly UnreadableRow[],
): Promise<ChainSignatureVerdict> {
  const cache = new Map<string, string | null>();
  const results: EntrySignatureResult[] = [];
  const unresolved: string[] = [];
  let allOk = true;

  for (const entry of entries) {
    const fingerprint = entry.signingKeyFingerprint;
    if (resolver.trusts !== undefined && !resolver.trusts(fingerprint)) {
      allOk = false;
      results.push({
        sequenceNumber: entry.sequenceNumber,
        fingerprint,
        ok: false,
        reason: "untrusted_key",
      });
      continue;
    }
    let publicKey = cache.get(fingerprint);
    if (publicKey === undefined) {
      publicKey = await resolver.resolveByFingerprint(fingerprint);
      cache.set(fingerprint, publicKey);
    }

    if (publicKey === null) {
      allOk = false;
      results.push({
        sequenceNumber: entry.sequenceNumber,
        fingerprint,
        ok: false,
        reason: "unresolved_key",
      });
      if (!unresolved.includes(fingerprint)) unresolved.push(fingerprint);
      continue;
    }

    const ok = verifyChainEntrySignature(entry, publicKey);
    if (!ok) allOk = false;
    results.push({
      sequenceNumber: entry.sequenceNumber,
      fingerprint,
      ok,
      ...(ok ? {} : { reason: "bad_signature" as const }),
    });
  }

  return {
    // A refused row fails the verdict rather than being absent from it: the signature is what binds
    // a row's columns to its content, so a row whose columns the contract refuses has failed that
    // binding in the one way this check cannot examine.
    valid: allOk && unreadable.length === 0,
    checked: entries.length,
    results,
    unresolvedFingerprints: unresolved,
    unreadable,
  };
}

export async function verifyStoredChainSignatures(
  reader: PostgresChainLogReader,
  tenantId: string | null,
  resolver: PublicKeyResolver,
): Promise<ChainSignatureVerdict> {
  const read = await reader.loadChain(tenantId);
  return verifyChainSignatures(read.entries, resolver, read.unreadable);
}
