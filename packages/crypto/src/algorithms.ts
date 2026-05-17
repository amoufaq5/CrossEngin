export const HASH_ALGORITHMS = ["sha256", "blake2b-512"] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

export const MAC_ALGORITHMS = ["hmac-sha256"] as const;
export type MacAlgorithm = (typeof MAC_ALGORITHMS)[number];

export const SIGNATURE_ALGORITHMS = ["ed25519"] as const;
export type SignatureAlgorithm = (typeof SIGNATURE_ALGORITHMS)[number];

export const KEY_PURPOSES = [
  "pack_signing",
  "webhook_signing",
  "evidence_sealing",
  "tombstone_anchoring",
] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

export const KEY_ALGORITHMS = [
  ...MAC_ALGORITHMS,
  ...SIGNATURE_ALGORITHMS,
] as const;
export type KeyAlgorithm = (typeof KEY_ALGORITHMS)[number];

export const CRYPTO_VERSION = 1;

export function isHashAlgorithm(value: unknown): value is HashAlgorithm {
  return typeof value === "string" && (HASH_ALGORITHMS as readonly string[]).includes(value);
}

export function isMacAlgorithm(value: unknown): value is MacAlgorithm {
  return typeof value === "string" && (MAC_ALGORITHMS as readonly string[]).includes(value);
}

export function isSignatureAlgorithm(value: unknown): value is SignatureAlgorithm {
  return typeof value === "string" && (SIGNATURE_ALGORITHMS as readonly string[]).includes(value);
}

export function isKeyAlgorithm(value: unknown): value is KeyAlgorithm {
  return typeof value === "string" && (KEY_ALGORITHMS as readonly string[]).includes(value);
}

export function isKeyPurpose(value: unknown): value is KeyPurpose {
  return typeof value === "string" && (KEY_PURPOSES as readonly string[]).includes(value);
}

export function allowedPurposesForAlgorithm(
  algorithm: KeyAlgorithm,
): readonly KeyPurpose[] {
  switch (algorithm) {
    case "ed25519":
      return ["pack_signing", "evidence_sealing", "tombstone_anchoring"];
    case "hmac-sha256":
      return ["webhook_signing"];
  }
}

export function isPurposeAllowed(
  algorithm: KeyAlgorithm,
  purpose: KeyPurpose,
): boolean {
  return allowedPurposesForAlgorithm(algorithm).includes(purpose);
}
