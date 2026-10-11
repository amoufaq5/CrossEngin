import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import { sha256 } from "./hashing.js";

export interface Ed25519Keypair {
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
}

const RAW_PUBLIC_KEY_LENGTH = 32;
const RAW_PRIVATE_SEED_LENGTH = 32;

function base64UrlToStandardBase64(s: string): string {
  let padded = s.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  return padded;
}

function exportRawPublicKey(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") {
    throw new Error("ed25519 public key JWK is missing the 'x' field");
  }
  const bytes = Buffer.from(base64UrlToStandardBase64(jwk.x), "base64");
  if (bytes.length !== RAW_PUBLIC_KEY_LENGTH) {
    throw new Error(`ed25519 public key must be ${RAW_PUBLIC_KEY_LENGTH} bytes`);
  }
  return new Uint8Array(bytes);
}

function exportRawPrivateSeed(privateKey: KeyObject): Uint8Array {
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  if (typeof jwk.d !== "string") {
    throw new Error("ed25519 private key JWK is missing the 'd' field");
  }
  const bytes = Buffer.from(base64UrlToStandardBase64(jwk.d), "base64");
  if (bytes.length !== RAW_PRIVATE_SEED_LENGTH) {
    throw new Error(`ed25519 private seed must be ${RAW_PRIVATE_SEED_LENGTH} bytes`);
  }
  return new Uint8Array(bytes);
}

function publicKeyFromRaw(rawBytes: Uint8Array): KeyObject {
  if (rawBytes.length !== RAW_PUBLIC_KEY_LENGTH) {
    throw new Error(`ed25519 public key must be ${RAW_PUBLIC_KEY_LENGTH} bytes`);
  }
  const x = Buffer.from(rawBytes).toString("base64url");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x },
    format: "jwk",
  });
}

function privateKeyFromRawSeed(seedBytes: Uint8Array, publicBytes: Uint8Array): KeyObject {
  if (seedBytes.length !== RAW_PRIVATE_SEED_LENGTH) {
    throw new Error(`ed25519 private seed must be ${RAW_PRIVATE_SEED_LENGTH} bytes`);
  }
  const d = Buffer.from(seedBytes).toString("base64url");
  const x = Buffer.from(publicBytes).toString("base64url");
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x, d },
    format: "jwk",
  });
}

export function generateEd25519Keypair(): Ed25519Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = exportRawPublicKey(publicKey);
  const rawSeed = exportRawPrivateSeed(privateKey);
  return {
    publicKeyBase64: Buffer.from(rawPub).toString("base64"),
    privateKeyBase64: Buffer.from(rawSeed).toString("base64"),
  };
}

function decodeBase64Strict(value: string, expectedLength: number, label: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not valid base64`);
  }
  const buf = Buffer.from(value, "base64");
  if (buf.length !== expectedLength) {
    throw new Error(`${label} must decode to ${expectedLength} bytes, got ${buf.length}`);
  }
  return new Uint8Array(buf);
}

function decodeBase64Signature(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("signature is not valid base64");
  }
  return Buffer.from(value, "base64");
}

export function signEd25519(
  privateKeyBase64: string,
  publicKeyBase64: string,
  message: Uint8Array | string,
): string {
  const seed = decodeBase64Strict(privateKeyBase64, RAW_PRIVATE_SEED_LENGTH, "private key");
  const pub = decodeBase64Strict(publicKeyBase64, RAW_PUBLIC_KEY_LENGTH, "public key");
  const key = privateKeyFromRawSeed(seed, pub);
  const msg = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  const sig = cryptoSign(null, msg, key);
  return Buffer.from(sig).toString("base64");
}

export function verifyEd25519(
  publicKeyBase64: string,
  signatureBase64: string,
  message: Uint8Array | string,
): boolean {
  let pubBytes: Uint8Array;
  try {
    pubBytes = decodeBase64Strict(publicKeyBase64, RAW_PUBLIC_KEY_LENGTH, "public key");
  } catch {
    return false;
  }
  let signature: Buffer;
  try {
    signature = decodeBase64Signature(signatureBase64);
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const key = publicKeyFromRaw(pubBytes);
  const msg = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  return cryptoVerify(null, msg, key, signature);
}

export function ed25519PublicKeyFingerprint(publicKeyBase64: string): string {
  const bytes = decodeBase64Strict(publicKeyBase64, RAW_PUBLIC_KEY_LENGTH, "public key");
  return sha256(bytes);
}

export function isEd25519PublicKeyBase64(value: string): boolean {
  try {
    decodeBase64Strict(value, RAW_PUBLIC_KEY_LENGTH, "public key");
    return true;
  } catch {
    return false;
  }
}

export function isEd25519PrivateSeedBase64(value: string): boolean {
  try {
    decodeBase64Strict(value, RAW_PRIVATE_SEED_LENGTH, "private seed");
    return true;
  } catch {
    return false;
  }
}

/**
 * RFC 8410 PKCS#8 prefix for a raw Ed25519 seed: SEQUENCE { INTEGER 0,
 * AlgorithmIdentifier { 1.3.101.112 }, OCTET STRING { OCTET STRING[32] } }.
 * Fixed-length, so the seed is simply appended.
 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Derives the public half of an Ed25519 key from its 32-byte seed alone.
 *
 * This exists so a deployment that signs its own tokens needs **one** secret and no second
 * declaration: `signEd25519` wants both halves and `privateKeyFromRawSeed` cannot be reached
 * without an `x`, so without this a signer would have to be configured with a public key beside
 * its private one -- and a pair that can be stated twice can be stated inconsistently, which is
 * the class this repository keeps finding. Derived, the two cannot disagree.
 *
 * The seed must go in through PKCS#8 rather than the JWK route the rest of this module uses,
 * because an OKP JWK private key requires `x` as well as `d` -- i.e. the JWK form already assumes
 * the answer this function computes.
 */
export function ed25519PublicKeyFromSeed(privateKeyBase64: string): string {
  const seed = decodeBase64Strict(privateKeyBase64, RAW_PRIVATE_SEED_LENGTH, "private seed");
  const priv = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return Buffer.from(exportRawPublicKey(createPublicKey(priv))).toString("base64");
}
