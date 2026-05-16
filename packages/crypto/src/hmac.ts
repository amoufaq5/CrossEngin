import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADER_REGEX = /^t=(\d+),v1=([0-9a-f]+)$/;

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input;
}

export function hmacSha256Hex(
  keyBytes: Uint8Array,
  message: Uint8Array | string,
): string {
  if (keyBytes.length < 16) {
    throw new Error(`HMAC key must be at least 16 bytes, got ${keyBytes.length}`);
  }
  return createHmac("sha256", Buffer.from(keyBytes))
    .update(toBytes(message))
    .digest("hex");
}

export function generateHmacKey(byteLength = 32): Uint8Array {
  if (byteLength < 16 || byteLength > 64) {
    throw new Error(`HMAC key length must be between 16 and 64 bytes, got ${byteLength}`);
  }
  return new Uint8Array(randomBytes(byteLength));
}

export interface SignedWebhookPayload {
  readonly timestampSeconds: number;
  readonly signatureHex: string;
  readonly header: string;
}

function canonicalWebhookMessage(timestampSeconds: number, body: Uint8Array): Buffer {
  const tsBytes = new TextEncoder().encode(`${timestampSeconds.toString()}.`);
  return Buffer.concat([Buffer.from(tsBytes), Buffer.from(body)]);
}

export function signWebhookPayload(
  keyBytes: Uint8Array,
  body: Uint8Array | string,
  timestampSeconds: number,
): SignedWebhookPayload {
  if (!Number.isInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new Error(`timestampSeconds must be a positive integer, got ${timestampSeconds}`);
  }
  const message = canonicalWebhookMessage(timestampSeconds, toBytes(body));
  const signatureHex = hmacSha256Hex(keyBytes, message);
  return {
    timestampSeconds,
    signatureHex,
    header: `t=${timestampSeconds.toString()},v1=${signatureHex}`,
  };
}

export type WebhookVerifyOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "malformed_header"
        | "timestamp_outside_tolerance"
        | "signature_mismatch";
    };

export interface WebhookVerifyOptions {
  readonly toleranceSeconds: number;
  readonly nowSeconds: number;
}

export function parseWebhookSignatureHeader(
  header: string,
): { readonly timestampSeconds: number; readonly signatureHex: string } | null {
  const match = SIGNATURE_HEADER_REGEX.exec(header);
  if (match === null) return null;
  const ts = Number.parseInt(match[1]!, 10);
  const sig = match[2]!;
  if (!Number.isInteger(ts) || ts <= 0) return null;
  if (sig.length !== 64) return null;
  return { timestampSeconds: ts, signatureHex: sig };
}

export function verifyWebhookSignature(
  keyBytes: Uint8Array,
  body: Uint8Array | string,
  header: string,
  opts: WebhookVerifyOptions,
): WebhookVerifyOutcome {
  const parsed = parseWebhookSignatureHeader(header);
  if (parsed === null) return { ok: false, reason: "malformed_header" };
  const skew = Math.abs(opts.nowSeconds - parsed.timestampSeconds);
  if (skew > opts.toleranceSeconds) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }
  const message = canonicalWebhookMessage(parsed.timestampSeconds, toBytes(body));
  const expected = hmacSha256Hex(keyBytes, message);
  if (!constantTimeEqualBuffers(expected, parsed.signatureHex)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

function constantTimeEqualBuffers(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
