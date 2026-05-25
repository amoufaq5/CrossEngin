import {
  type KeyHandle,
  type KeyStore,
  ed25519PublicKeyFingerprint,
  hashChainStep,
  sha256,
  signEd25519,
  verifyEd25519,
} from "@crossengin/crypto";

import { GENESIS_HASH, type ChainedLogEntry, type LogKind } from "./tamper-evident-logs.js";

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
  const signatureBase64 = signEd25519(input.privateKeyBase64, input.publicKeyBase64, canonical);
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
    throw new Error(`evidence sealing requires an ed25519 key, got ${input.handle.algorithm}`);
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
  if (ed25519PublicKeyFingerprint(input.publicKeyBase64) !== input.seal.signingKeyFingerprint) {
    return false;
  }
  const bytes =
    typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
  if (sha256(bytes) !== input.seal.sha256Hex) return false;
  const canonical = canonicalEvidenceBytes(bytes, input.seal.sha256Hex, input.seal.sealedAt);
  return verifyEd25519(input.publicKeyBase64, input.seal.signatureBase64, canonical);
}
