import { timingSafeEqual } from "node:crypto";

import { hmacSha256Hex } from "@crossengin/crypto";

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface VerifyStripeWebhookOptions {
  readonly toleranceSeconds?: number;
  readonly now?: Date;
}

export type StripeWebhookReason =
  | "malformed_header"
  | "missing_timestamp"
  | "missing_signature"
  | "timestamp_outside_tolerance"
  | "signature_mismatch"
  | "invalid_event_json";

export interface StripeWebhookResult {
  readonly valid: boolean;
  readonly reason?: StripeWebhookReason;
  readonly event?: unknown;
}

interface ParsedSignatureHeader {
  readonly timestamp: number | null;
  readonly signatures: readonly string[];
}

export function parseStripeSignatureHeader(header: string): ParsedSignatureHeader {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        timestamp = parsed;
      }
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length || aBuf.length === 0) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function verifyStripeWebhook(
  payload: string,
  signatureHeader: string,
  secret: string,
  opts: VerifyStripeWebhookOptions = {},
): StripeWebhookResult {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);

  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);
  if (timestamp === null) {
    return { valid: false, reason: "missing_timestamp" };
  }
  if (signatures.length === 0) {
    return { valid: false, reason: "missing_signature" };
  }

  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_outside_tolerance" };
  }

  const signedMessage = `${timestamp.toString()}.${payload}`;
  const expected = hmacSha256Hex(new TextEncoder().encode(secret), signedMessage);
  const matched = signatures.some((candidate) => constantTimeHexEqual(expected, candidate));
  if (!matched) {
    return { valid: false, reason: "signature_mismatch" };
  }

  try {
    const event = JSON.parse(payload) as unknown;
    return { valid: true, event };
  } catch {
    return { valid: false, reason: "invalid_event_json" };
  }
}

export function computeStripeSignatureHeader(
  payload: string,
  secret: string,
  timestampSeconds: number,
): string {
  const signedMessage = `${timestampSeconds.toString()}.${payload}`;
  const signature = hmacSha256Hex(new TextEncoder().encode(secret), signedMessage);
  return `t=${timestampSeconds.toString()},v1=${signature}`;
}
