import { randomBytes } from "node:crypto";
import { z } from "zod";

import { type KeyAlgorithm, type KeyPurpose } from "./algorithms.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_ID_REGEX = /^key_(hmac-sha256|ed25519)_[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KeyId = `key_${string}`;

function encodeBase32(bytes: Uint8Array): string {
  const length = 26;
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      bits -= 5;
      out += CROCKFORD_BASE32[(buffer >> bits) & 0x1f];
    }
  }
  while (out.length < length) {
    out += CROCKFORD_BASE32[(buffer << (5 - bits)) & 0x1f];
    bits = 0;
  }
  return out.slice(0, length);
}

export function generateKeyId(algorithm: KeyAlgorithm): KeyId {
  return `key_${algorithm}_${encodeBase32(new Uint8Array(randomBytes(17)))}` as KeyId;
}

export function isKeyId(value: unknown): value is KeyId {
  return typeof value === "string" && KEY_ID_REGEX.test(value);
}

export function parseKeyIdAlgorithm(keyId: string): KeyAlgorithm | null {
  if (!isKeyId(keyId)) return null;
  const parts = keyId.split("_");
  const alg = parts[1];
  if (alg === "hmac-sha256" || alg === "ed25519") return alg;
  return null;
}

export const KeyHandleSchema = z.object({
  id: z.string().regex(KEY_ID_REGEX),
  tenantId: z.string().regex(UUID_REGEX).nullable(),
  algorithm: z.enum(["hmac-sha256", "ed25519"]),
  purpose: z.enum([
    "pack_signing",
    "webhook_signing",
    "evidence_sealing",
    "tombstone_anchoring",
  ]),
  version: z.number().int().positive(),
});

export type KeyHandle = z.infer<typeof KeyHandleSchema>;

export interface NewKeyInput {
  readonly algorithm: KeyAlgorithm;
  readonly purpose: KeyPurpose;
  readonly tenantId: string | null;
}

export function serializeKeyHandle(handle: KeyHandle): string {
  KeyHandleSchema.parse(handle);
  return Buffer.from(JSON.stringify(handle), "utf8").toString("base64");
}

export function parseKeyHandle(serialized: string): KeyHandle {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(serialized)) {
    throw new Error("serialized key handle is not valid base64");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(serialized, "base64").toString("utf8"));
  } catch {
    throw new Error("serialized key handle is not valid base64-encoded JSON");
  }
  return KeyHandleSchema.parse(parsed);
}

export function assertHandleTenant(
  handle: KeyHandle,
  tenantId: string | null,
): void {
  if (handle.tenantId === null) {
    return;
  }
  if (handle.tenantId !== tenantId) {
    throw new Error(
      `key handle ${handle.id} belongs to tenant ${handle.tenantId}, not ${tenantId ?? "<null>"}`,
    );
  }
}

export function withRotatedVersion(handle: KeyHandle): KeyHandle {
  return { ...handle, version: handle.version + 1, id: generateKeyId(handle.algorithm) };
}
