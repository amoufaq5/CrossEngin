import {
  type KeyHandle,
  type KeyStore,
  ed25519PublicKeyFingerprint,
  hashChainStep,
  sha256,
  signEd25519,
  verifyEd25519,
} from "@crossengin/crypto";

import {
  ChainCheckpointSchema,
  GENESIS_HASH,
  type ChainCheckpoint,
  type ChainFoldVerdict,
  type ChainedLogEntry,
  type LogKind,
} from "./tamper-evident-logs.js";

const FORENSICS_HASH_ALGORITHM = "sha256" as const;
const EVIDENCE_DOMAIN_TAG = "crossengin.evidence.v1\n";
const ENTRY_DOMAIN_TAG = "crossengin.log.entry.v1\n";

export interface ChainEntryInput {
  readonly kind: LogKind;
  readonly recordedAt: string;
  readonly actorReference: string;
  readonly payloadBytes: Uint8Array | string;
}

export interface SealedChainEntry {
  readonly entry: ChainedLogEntry;
  readonly payloadSha256: string;
  readonly canonicalBytes: Uint8Array;
}

export function computePayloadSha256(payload: Uint8Array | string): string {
  return sha256(payload);
}

function canonicalEntryBytes(
  sequenceNumber: number,
  kind: LogKind,
  recordedAt: string,
  actorReference: string,
  payloadSha256Hex: string,
  payloadSizeBytes: number,
  priorEntryHash: string,
): Uint8Array {
  const json = JSON.stringify({
    sequenceNumber,
    kind,
    recordedAt,
    actorReference,
    payloadSha256: payloadSha256Hex,
    payloadSizeBytes,
    priorEntryHash,
  });
  return new TextEncoder().encode(ENTRY_DOMAIN_TAG + json);
}

export async function buildChainEntry(input: {
  readonly sequenceNumber: number;
  readonly priorEntryHash: string;
  readonly entry: ChainEntryInput;
  readonly signingKeyFingerprint: string;
  readonly sign: (canonicalBytes: Uint8Array) => Promise<string>;
}): Promise<SealedChainEntry> {
  const payloadBytes =
    typeof input.entry.payloadBytes === "string"
      ? new TextEncoder().encode(input.entry.payloadBytes)
      : input.entry.payloadBytes;
  const payloadSha256 = computePayloadSha256(payloadBytes);
  const canonicalBytes = canonicalEntryBytes(
    input.sequenceNumber,
    input.entry.kind,
    input.entry.recordedAt,
    input.entry.actorReference,
    payloadSha256,
    payloadBytes.byteLength,
    input.priorEntryHash,
  );
  const entryHash = hashChainStep(
    input.priorEntryHash,
    sha256(canonicalBytes),
    FORENSICS_HASH_ALGORITHM,
  );
  const signature = await input.sign(canonicalBytes);
  return {
    entry: {
      sequenceNumber: input.sequenceNumber,
      kind: input.entry.kind,
      recordedAt: input.entry.recordedAt,
      actorReference: input.entry.actorReference,
      payloadSha256,
      payloadSizeBytes: payloadBytes.byteLength,
      priorEntryHash: input.priorEntryHash,
      entryHash,
      signingKeyFingerprint: input.signingKeyFingerprint,
      signature,
    },
    payloadSha256,
    canonicalBytes,
  };
}

export async function buildChainWithKeyStore(input: {
  readonly store: KeyStore;
  readonly handle: KeyHandle;
  readonly tenantId: string | null;
  readonly entries: readonly ChainEntryInput[];
}): Promise<readonly SealedChainEntry[]> {
  if (input.handle.algorithm !== "ed25519") {
    throw new Error(
      `evidence chain signing requires an ed25519 key, got ${input.handle.algorithm}`,
    );
  }
  if (input.handle.purpose !== "evidence_sealing") {
    throw new Error(
      `evidence chain signing requires an evidence_sealing key, got purpose ${input.handle.purpose}`,
    );
  }
  const publicKeyBase64 = await input.store.getPublicMaterial(input.handle);
  const fingerprint = ed25519PublicKeyFingerprint(publicKeyBase64);
  const out: SealedChainEntry[] = [];
  let priorHash = GENESIS_HASH;
  let seq = 0;
  for (const e of input.entries) {
    const sealed = await buildChainEntry({
      sequenceNumber: seq,
      priorEntryHash: priorHash,
      entry: e,
      signingKeyFingerprint: fingerprint,
      sign: (bytes) => input.store.signWith(input.handle, input.tenantId, bytes),
    });
    out.push(sealed);
    priorHash = sealed.entry.entryHash;
    seq++;
  }
  return out;
}

export function verifyChainEntrySignature(
  entry: ChainedLogEntry,
  publicKeyBase64: string,
): boolean {
  if (ed25519PublicKeyFingerprint(publicKeyBase64) !== entry.signingKeyFingerprint) {
    return false;
  }
  const canonicalBytes = canonicalEntryBytes(
    entry.sequenceNumber,
    entry.kind,
    entry.recordedAt,
    entry.actorReference,
    entry.payloadSha256,
    entry.payloadSizeBytes,
    entry.priorEntryHash,
  );
  return verifyEd25519(publicKeyBase64, entry.signature, canonicalBytes);
}

/**
 * The entry hash this entry's stored content commits to, recomputed exactly as `buildChainEntry`
 * computed it.
 *
 * It exists because the two folds compare a stored `priorEntryHash` against a stored `entryHash` and
 * recompute neither, while the signature covers the canonical bytes and **not** `entryHash` — so the
 * one column every later entry links through was bound to its content by nothing. Rewriting the
 * tail entry's `entry_hash` passed both folds and every signature (no later entry to disagree), and
 * the next append then chained from the forged value. A content-addressed recompute closes that,
 * and it also binds every hashed column without a resolvable key, which the signature cannot.
 *
 * What it does **not** add is resistance to a writer who recomputes: every input is a stored
 * column, so an attacker who rewrites an entry and every hash after it produces a chain this check
 * passes. That is what the signature (under a key this deployment trusts) and the anchors are for.
 */
export function recomputeEntryHash(entry: ChainedLogEntry): string {
  const canonicalBytes = canonicalEntryBytes(
    entry.sequenceNumber,
    entry.kind,
    entry.recordedAt,
    entry.actorReference,
    entry.payloadSha256,
    entry.payloadSizeBytes,
    entry.priorEntryHash,
  );
  return hashChainStep(entry.priorEntryHash, sha256(canonicalBytes), FORENSICS_HASH_ALGORITHM);
}

/**
 * Every entry's stored `entryHash` against the hash its content commits to; the first that differs
 * breaks the verdict at its own sequence. Vacuously valid over no entries, like the link fold — an
 * empty chain is the truncation check's subject, not this one's.
 */
export function verifyChainEntryHashes(entries: readonly ChainedLogEntry[]): ChainFoldVerdict {
  for (const entry of entries) {
    if (recomputeEntryHash(entry) !== entry.entryHash) {
      return {
        valid: false,
        brokenAt: entry.sequenceNumber,
        reason: "entry hash does not match its content",
      };
    }
  }
  return { valid: true, brokenAt: null };
}

const CHECKPOINT_DOMAIN_TAG = "crossengin.chain.checkpoint.v1\n";

/**
 * The bytes a checkpoint signature commits to: the scope, the sequence and root hash it anchors, the
 * provenance a bounded proof trusts the prefix on, and when it was taken.
 *
 * **Scope is inside the bytes** so a signed checkpoint cannot be copied into another scope's table,
 * where it would witness a sequence that chain never reached. `checkpointedBy`, `algorithm` and
 * `externalAnchorReference` are deliberately outside: none decides what a verifier does with the
 * anchor, and `externalAnchorReference` has no producer — signing it would commit to a field nothing
 * fills. An absent provenance is signed as `null` rather than omitted, because `JSON.stringify` drops
 * `undefined` keys and a missing key would make two different claims sign to one byte string.
 */
export function canonicalCheckpointBytes(
  scope: string | null,
  checkpoint: Pick<
    ChainCheckpoint,
    "sequenceNumber" | "rootHash" | "provenance" | "checkpointedAt"
  >,
): Uint8Array {
  // Lowercased because a scope is a UUID and is compared as one everywhere else: `tenant_id = $1::uuid`
  // answers the same rows for either case, and `verify-chain --tenant` and a static `tenants` list
  // take whatever case was typed, so bytes over the raw string signed a lowercase scope and verified
  // an uppercase one as `bad_signature` — a forged-checkpoint finding about an honest row.
  const json = JSON.stringify({
    scope: scope === null ? null : scope.toLowerCase(),
    sequenceNumber: checkpoint.sequenceNumber,
    rootHash: checkpoint.rootHash,
    provenance: checkpoint.provenance ?? null,
    checkpointedAt: checkpoint.checkpointedAt,
  });
  return new TextEncoder().encode(CHECKPOINT_DOMAIN_TAG + json);
}

/**
 * What a checkpoint's signature establishes against a set of trusted keys, keyed by fingerprint.
 *
 * Four standings rather than a boolean because they mean different things to a verifier: `unsigned`
 * is a row an older binary wrote (a gap, not a finding), while `untrusted_key` and `bad_signature`
 * are rows the deployment's own writer cannot have produced — it signs every checkpoint with its own
 * key — so each is evidence that somebody else wrote or edited the row.
 */
export const CHECKPOINT_SIGNATURE_STANDINGS = [
  "signed",
  "unsigned",
  "untrusted_key",
  "bad_signature",
] as const;
export type CheckpointSignatureStanding = (typeof CHECKPOINT_SIGNATURE_STANDINGS)[number];

export function checkpointSignatureStanding(
  scope: string | null,
  checkpoint: ChainCheckpoint,
  trustedKeys: ReadonlyMap<string, string>,
): CheckpointSignatureStanding {
  if (checkpoint.signature === undefined || checkpoint.signingKeyFingerprint === undefined) {
    return "unsigned";
  }
  const publicKey = trustedKeys.get(checkpoint.signingKeyFingerprint);
  if (publicKey === undefined) return "untrusted_key";
  return verifyEd25519(publicKey, checkpoint.signature, canonicalCheckpointBytes(scope, checkpoint))
    ? "signed"
    : "bad_signature";
}

/**
 * The checkpoint with its signature attached. Signed **after** every other field is fixed, so the
 * bytes are exactly the ones a verifier will rebuild from the stored row.
 */
export async function signCheckpoint(
  scope: string | null,
  checkpoint: ChainCheckpoint,
  signer: {
    readonly fingerprint: string;
    sign(canonicalBytes: Uint8Array): Promise<string>;
  },
): Promise<ChainCheckpoint> {
  const signature = await signer.sign(canonicalCheckpointBytes(scope, checkpoint));
  return ChainCheckpointSchema.parse({
    ...checkpoint,
    signature,
    signingKeyFingerprint: signer.fingerprint,
  });
}

/**
 * The keys a chain verifier trusts, keyed by fingerprint, built from public keys alone so the
 * fingerprint is **derived** and a map stating one key under another's fingerprint cannot be formed.
 * A malformed key throws, naming its position and not its value: an operator declared it, and a
 * trusted-key set silently one key short would refuse every entry that key signed.
 */
export function trustedChainKeys(publicKeysBase64: readonly string[]): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  publicKeysBase64.forEach((publicKey, i) => {
    let fingerprint: string;
    try {
      fingerprint = ed25519PublicKeyFingerprint(publicKey);
    } catch {
      throw new Error(
        `trusted chain key #${(i + 1).toString()} is not a base64 Ed25519 public key (32 bytes)`,
      );
    }
    keys.set(fingerprint, publicKey);
  });
  return keys;
}

export interface EvidenceSeal {
  readonly sha256Hex: string;
  readonly signatureBase64: string;
  readonly signingKeyFingerprint: string;
  readonly sealedAt: string;
}

function canonicalEvidenceBytes(
  bytes: Uint8Array,
  sha256Hex: string,
  sealedAt: string,
): Uint8Array {
  const header = new TextEncoder().encode(
    EVIDENCE_DOMAIN_TAG + JSON.stringify({ sha256: sha256Hex, sealedAt }) + "\n",
  );
  return new Uint8Array(Buffer.concat([Buffer.from(header), Buffer.from(bytes)]));
}

export function sealEvidence(input: {
  readonly bytes: Uint8Array | string;
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
  readonly sealedAt: string;
}): EvidenceSeal {
  const bytes =
    typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
  const sha256Hex = sha256(bytes);
  const canonical = canonicalEvidenceBytes(bytes, sha256Hex, input.sealedAt);
  const signatureBase64 = signEd25519(
    input.privateKeyBase64,
    input.publicKeyBase64,
    canonical,
  );
  return {
    sha256Hex,
    signatureBase64,
    signingKeyFingerprint: ed25519PublicKeyFingerprint(input.publicKeyBase64),
    sealedAt: input.sealedAt,
  };
}

export async function sealEvidenceWithStore(input: {
  readonly bytes: Uint8Array | string;
  readonly store: KeyStore;
  readonly handle: KeyHandle;
  readonly tenantId: string | null;
  readonly sealedAt: string;
}): Promise<EvidenceSeal> {
  if (input.handle.algorithm !== "ed25519") {
    throw new Error(
      `evidence sealing requires an ed25519 key, got ${input.handle.algorithm}`,
    );
  }
  if (input.handle.purpose !== "evidence_sealing") {
    throw new Error(
      `evidence sealing requires an evidence_sealing key, got purpose ${input.handle.purpose}`,
    );
  }
  const publicKeyBase64 = await input.store.getPublicMaterial(input.handle);
  const bytes =
    typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
  const sha256Hex = sha256(bytes);
  const canonical = canonicalEvidenceBytes(bytes, sha256Hex, input.sealedAt);
  const signatureBase64 = await input.store.signWith(input.handle, input.tenantId, canonical);
  return {
    sha256Hex,
    signatureBase64,
    signingKeyFingerprint: ed25519PublicKeyFingerprint(publicKeyBase64),
    sealedAt: input.sealedAt,
  };
}

export function verifyEvidenceSeal(input: {
  readonly bytes: Uint8Array | string;
  readonly seal: EvidenceSeal;
  readonly publicKeyBase64: string;
}): boolean {
  if (
    ed25519PublicKeyFingerprint(input.publicKeyBase64) !== input.seal.signingKeyFingerprint
  ) {
    return false;
  }
  const bytes =
    typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
  if (sha256(bytes) !== input.seal.sha256Hex) return false;
  const canonical = canonicalEvidenceBytes(bytes, input.seal.sha256Hex, input.seal.sealedAt);
  return verifyEd25519(input.publicKeyBase64, input.seal.signatureBase64, canonical);
}
