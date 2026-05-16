import {
  type KeyHandle,
  type KeyStore,
  generateHmacKey,
  hmacSha256Hex,
  signWebhookPayload,
  verifyWebhookSignature,
  type WebhookVerifyOutcome,
} from "@crossengin/crypto";

import {
  SIGNATURE_HEADER_NAME,
  SIGNATURE_TOLERANCE_SECONDS,
  formatSignatureHeader,
  parseSignatureHeader,
} from "./webhooks.js";

export interface SignedWebhookDelivery {
  readonly signatureHeader: string;
  readonly signatureValue: string;
  readonly timestampSeconds: number;
  readonly headers: Readonly<Record<string, string>>;
}

export function generateWebhookSecret(): Uint8Array {
  return generateHmacKey(32);
}

export function hashWebhookSecret(secretBytes: Uint8Array): string {
  return hmacSha256Hex(secretBytes, "crossengin.webhook.secret.fingerprint");
}

export function signWebhookDelivery(input: {
  readonly secretBytes: Uint8Array;
  readonly body: Uint8Array | string;
  readonly timestampSeconds: number;
}): SignedWebhookDelivery {
  const signed = signWebhookPayload(input.secretBytes, input.body, input.timestampSeconds);
  return {
    signatureHeader: SIGNATURE_HEADER_NAME,
    signatureValue: signed.header,
    timestampSeconds: signed.timestampSeconds,
    headers: { [SIGNATURE_HEADER_NAME]: signed.header },
  };
}

export async function signWebhookDeliveryWithStore(input: {
  readonly store: KeyStore;
  readonly handle: KeyHandle;
  readonly tenantId: string | null;
  readonly body: Uint8Array | string;
  readonly timestampSeconds: number;
}): Promise<SignedWebhookDelivery> {
  if (input.handle.algorithm !== "hmac-sha256") {
    throw new Error(
      `webhook signing requires an hmac-sha256 key, got ${input.handle.algorithm}`,
    );
  }
  if (input.handle.purpose !== "webhook_signing") {
    throw new Error(
      `webhook signing requires a webhook_signing key, got purpose ${input.handle.purpose}`,
    );
  }
  if (!Number.isInteger(input.timestampSeconds) || input.timestampSeconds <= 0) {
    throw new Error(`timestampSeconds must be a positive integer, got ${input.timestampSeconds}`);
  }
  const bodyBytes =
    typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
  const canonical = new Uint8Array(
    Buffer.concat([
      Buffer.from(new TextEncoder().encode(`${input.timestampSeconds.toString()}.`)),
      Buffer.from(bodyBytes),
    ]),
  );
  const signatureHex = await input.store.hmacWith(input.handle, input.tenantId, canonical);
  const header = formatSignatureHeader(input.timestampSeconds, signatureHex);
  return {
    signatureHeader: SIGNATURE_HEADER_NAME,
    signatureValue: header,
    timestampSeconds: input.timestampSeconds,
    headers: { [SIGNATURE_HEADER_NAME]: header },
  };
}

export interface VerifyWebhookOptions {
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}

export function verifyWebhookDelivery(input: {
  readonly secretBytes: Uint8Array;
  readonly body: Uint8Array | string;
  readonly signatureHeader: string;
  readonly opts: VerifyWebhookOptions;
}): WebhookVerifyOutcome {
  const tolerance = input.opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  return verifyWebhookSignature(input.secretBytes, input.body, input.signatureHeader, {
    nowSeconds: input.opts.nowSeconds,
    toleranceSeconds: tolerance,
  });
}

export function isParsedSignatureFresh(
  parsedTimestampSeconds: number,
  nowSeconds: number,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  return Math.abs(nowSeconds - parsedTimestampSeconds) <= toleranceSeconds;
}

export function extractSignatureFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): { readonly timestampSeconds: number; readonly sha256: string } | null {
  const value =
    headers[SIGNATURE_HEADER_NAME] ?? headers[SIGNATURE_HEADER_NAME.toLowerCase()];
  if (value === undefined) return null;
  return parseSignatureHeader(value);
}
