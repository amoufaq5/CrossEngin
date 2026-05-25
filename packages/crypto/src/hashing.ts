import { createHash, timingSafeEqual } from "node:crypto";

import { type HashAlgorithm, isHashAlgorithm } from "./algorithms.js";

let readyPromise: Promise<void> | null = null;

export async function ensureCryptoReady(): Promise<void> {
  if (readyPromise === null) {
    readyPromise = Promise.resolve();
  }
  await readyPromise;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input;
}

export function sha256(input: Uint8Array | string): string {
  return createHash("sha256").update(toBytes(input)).digest("hex");
}

export function blake2b512Hex(input: Uint8Array | string): string {
  return createHash("blake2b512").update(toBytes(input)).digest("hex");
}

export function hashWith(algorithm: HashAlgorithm, input: Uint8Array | string): string {
  switch (algorithm) {
    case "sha256":
      return sha256(input);
    case "blake2b-512":
      return blake2b512Hex(input);
  }
}

export function hashChainStep(
  previousHashHex: string,
  payloadHashHex: string,
  algorithm: HashAlgorithm,
): string {
  if (!/^[0-9a-f]+$/.test(previousHashHex)) {
    throw new Error("previousHashHex must be lowercase hex");
  }
  if (!/^[0-9a-f]+$/.test(payloadHashHex)) {
    throw new Error("payloadHashHex must be lowercase hex");
  }
  if (!isHashAlgorithm(algorithm)) {
    throw new Error(`unsupported hash algorithm: ${String(algorithm)}`);
  }
  return hashWith(algorithm, previousHashHex + payloadHashHex);
}

export function sha256ContentAddress(bytes: Uint8Array | string): string {
  return `sha256:${sha256(bytes)}`;
}

export function parseContentAddress(
  address: string,
): { readonly algorithm: HashAlgorithm; readonly hex: string } | null {
  const idx = address.indexOf(":");
  if (idx < 0) return null;
  const algorithm = address.slice(0, idx);
  const hex = address.slice(idx + 1);
  if (!isHashAlgorithm(algorithm)) return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  return { algorithm, hex };
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
