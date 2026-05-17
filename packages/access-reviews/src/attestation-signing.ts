import {
  type KeyHandle,
  type KeyStore,
  ed25519PublicKeyFingerprint,
  sha256,
  signEd25519,
  verifyEd25519,
} from "@crossengin/crypto";

import {
  DecisionAttestationSchema,
  STRONG_ATTESTATION_KINDS,
  type AttestationKind,
} from "./decisions.js";

const ATTESTATION_DOMAIN_TAG = "crossengin.access-review.attestation.v1\n";

export interface AttestationSubject {
  readonly decisionId: string;
  readonly campaignId: string;
  readonly itemId: string;
  readonly tenantId: string;
}

export interface AttestationInput {
  readonly subject: AttestationSubject;
  readonly kind: AttestationKind;
  readonly attestedAt: string;
  readonly attestedByUserId: string;
  readonly attestationPhrase?: string;
  readonly coAttestingUserId?: string | null;
  readonly coAttestedAt?: string | null;
  readonly ipAddress: string;
  readonly userAgent: string;
}

export interface SignedAttestation {
  readonly kind: AttestationKind;
  readonly attestedAt: string;
  readonly attestedByUserId: string;
  readonly attestationPhrase: string | undefined;
  readonly signatureSha256: string | null;
  readonly signingKeyFingerprint: string | null;
  readonly coAttestingUserId: string | null;
  readonly coAttestedAt: string | null;
  readonly ipAddress: string;
  readonly userAgent: string;
}

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite numbers cannot be canonicalized");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + canonicalStringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

export function canonicalAttestationBytes(input: AttestationInput): Uint8Array {
  const json = canonicalStringify({
    subject: input.subject,
    kind: input.kind,
    attestedAt: input.attestedAt,
    attestedByUserId: input.attestedByUserId,
    attestationPhrase: input.attestationPhrase,
    coAttestingUserId: input.coAttestingUserId ?? null,
    coAttestedAt: input.coAttestedAt ?? null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  return new TextEncoder().encode(ATTESTATION_DOMAIN_TAG + json);
}

export function computeAttestationSha256(input: AttestationInput): string {
  return sha256(canonicalAttestationBytes(input));
}

export function signDecisionAttestation(input: {
  readonly attestation: AttestationInput;
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
}): SignedAttestation {
  const bytes = canonicalAttestationBytes(input.attestation);
  const sha256Hex = sha256(bytes);
  const signatureBase64 = signEd25519(
    input.privateKeyBase64,
    input.publicKeyBase64,
    bytes,
  );
  const out: SignedAttestation = {
    kind: input.attestation.kind,
    attestedAt: input.attestation.attestedAt,
    attestedByUserId: input.attestation.attestedByUserId,
    attestationPhrase: input.attestation.attestationPhrase,
    signatureSha256: sha256(signatureBase64 + ":" + sha256Hex),
    signingKeyFingerprint: ed25519PublicKeyFingerprint(input.publicKeyBase64),
    coAttestingUserId: input.attestation.coAttestingUserId ?? null,
    coAttestedAt: input.attestation.coAttestedAt ?? null,
    ipAddress: input.attestation.ipAddress,
    userAgent: input.attestation.userAgent,
  };
  DecisionAttestationSchema.parse(out);
  return out;
}

export async function signDecisionAttestationWithStore(input: {
  readonly attestation: AttestationInput;
  readonly store: KeyStore;
  readonly handle: KeyHandle;
  readonly tenantId: string | null;
}): Promise<SignedAttestation> {
  if (input.handle.algorithm !== "ed25519") {
    throw new Error(
      `attestation signing requires an ed25519 key, got ${input.handle.algorithm}`,
    );
  }
  if (input.handle.purpose !== "evidence_sealing") {
    throw new Error(
      `attestation signing requires an evidence_sealing key, got purpose ${input.handle.purpose}`,
    );
  }
  const publicKeyBase64 = await input.store.getPublicMaterial(input.handle);
  const bytes = canonicalAttestationBytes(input.attestation);
  const sha256Hex = sha256(bytes);
  const signatureBase64 = await input.store.signWith(input.handle, input.tenantId, bytes);
  const out: SignedAttestation = {
    kind: input.attestation.kind,
    attestedAt: input.attestation.attestedAt,
    attestedByUserId: input.attestation.attestedByUserId,
    attestationPhrase: input.attestation.attestationPhrase,
    signatureSha256: sha256(signatureBase64 + ":" + sha256Hex),
    signingKeyFingerprint: ed25519PublicKeyFingerprint(publicKeyBase64),
    coAttestingUserId: input.attestation.coAttestingUserId ?? null,
    coAttestedAt: input.attestation.coAttestedAt ?? null,
    ipAddress: input.attestation.ipAddress,
    userAgent: input.attestation.userAgent,
  };
  DecisionAttestationSchema.parse(out);
  return out;
}

export function verifyDecisionAttestation(input: {
  readonly attestation: SignedAttestation;
  readonly subject: AttestationSubject;
  readonly publicKeyBase64: string;
  readonly signatureBase64: string;
}): boolean {
  if (!STRONG_ATTESTATION_KINDS.has(input.attestation.kind)) {
    return true;
  }
  if (input.attestation.signatureSha256 === null) return false;
  if (input.attestation.signingKeyFingerprint === null) return false;
  if (
    ed25519PublicKeyFingerprint(input.publicKeyBase64) !==
    input.attestation.signingKeyFingerprint
  ) {
    return false;
  }
  const bytes = canonicalAttestationBytes({
    subject: input.subject,
    kind: input.attestation.kind,
    attestedAt: input.attestation.attestedAt,
    attestedByUserId: input.attestation.attestedByUserId,
    attestationPhrase: input.attestation.attestationPhrase,
    coAttestingUserId: input.attestation.coAttestingUserId,
    coAttestedAt: input.attestation.coAttestedAt,
    ipAddress: input.attestation.ipAddress,
    userAgent: input.attestation.userAgent,
  });
  if (!verifyEd25519(input.publicKeyBase64, input.signatureBase64, bytes)) {
    return false;
  }
  const expectedSha = sha256(input.signatureBase64 + ":" + sha256(bytes));
  return expectedSha === input.attestation.signatureSha256;
}
