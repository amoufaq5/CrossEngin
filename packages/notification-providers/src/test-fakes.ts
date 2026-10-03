import { signWebhookPayload } from "@crossengin/crypto";

import type { FetchLike, SendRequest } from "./email-ses.js";

/*
 * Offline test support. Every test in this package runs against `FakeFetch`: no credentials, no
 * network, no database. A provider client is only testable this way if its `fetch` is injected,
 * which is why both senders take one — the same reason `billing-stripe` does.
 */

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface FakeResponse {
  readonly ok?: boolean;
  readonly status: number;
  readonly body: string;
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly responses: FakeResponse[];

  constructor(responses: readonly FakeResponse[] = []) {
    this.responses = [...responses];
  }

  /** Narrowed to `FetchLike` so a sender accepts it without a cast at the call site. */
  get fn(): FetchLike {
    return async (url, init) => {
      this.requests.push({
        url,
        method: init.method,
        headers: { ...init.headers },
        body: init.body,
      });
      const next = this.responses.shift();
      if (next === undefined) {
        throw new Error(`FakeFetch: no queued response for ${init.method} ${url}`);
      }
      return {
        ok: next.ok ?? (next.status >= 200 && next.status < 300),
        status: next.status,
        text: async (): Promise<string> => next.body,
      };
    };
  }

  get only(): RecordedRequest {
    const first = this.requests[0];
    if (first === undefined) throw new Error("FakeFetch: no request was recorded");
    return first;
  }
}

/** A fetch that rejects, standing in for a dead socket. */
export function throwingFetch(message = "ECONNRESET"): FetchLike {
  return async () => {
    throw new Error(message);
  };
}

export const TEST_TENANT_ID = "11111111-1111-4111-8111-111111111111";

export function sendRequest(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    dispatchId: "disp_0123456789abcdef0123456789abcdef",
    tenantId: TEST_TENANT_ID,
    channel: "email",
    templateId: "design_review.approved",
    locale: "en-US",
    recipientAddress: "ops@example.test",
    attemptNumber: 1,
    ...overrides,
  };
}

/**
 * Shaped like a real FCM registration token: an instance id, a colon, then a long base64url body.
 * Deliberately long enough to pass `looksLikeFcmRegistrationToken`, which a user id does not.
 */
export const TEST_FCM_REGISTRATION_TOKEN =
  "dQw4w9WgXcQ:APA91bHShapeOnly-not-a-real-token_0123456789abcdefghijklmnopqrstuvwxyz";

/** A test E.164 number, in the +1 555 range reserved for fiction. */
export const TEST_E164_NUMBER = "+15551234567";

/** 32 bytes, the minimum `hmacSha256Hex` is happy with and the length a deployment should use. */
export const TEST_WEBHOOK_SECRET: Uint8Array = new Uint8Array(32).fill(7);

export function signBody(
  body: string,
  timestampSeconds: number,
  secret: Uint8Array = TEST_WEBHOOK_SECRET,
): string {
  return signWebhookPayload(secret, body, timestampSeconds).header;
}

// --- provider payload fixtures -------------------------------------------------

export function sesBounceEvent(input: {
  readonly bounceType?: string;
  readonly bounceSubType?: string;
  readonly addresses?: readonly string[];
  readonly messageId?: string;
  readonly useNotificationType?: boolean;
}): string {
  const key = input.useNotificationType === true ? "notificationType" : "eventType";
  return JSON.stringify({
    [key]: "Bounce",
    mail: { messageId: input.messageId ?? "0100018f-ses-message-id" },
    bounce: {
      bounceType: input.bounceType ?? "Permanent",
      bounceSubType: input.bounceSubType ?? "General",
      bouncedRecipients: (input.addresses ?? ["gone@example.test"]).map(
        (emailAddress) => ({ emailAddress }),
      ),
      timestamp: "2026-09-30T12:00:00.000Z",
      feedbackId: "fb-1",
    },
  });
}

export function sesComplaintEvent(input: {
  readonly addresses?: readonly string[];
  readonly feedbackType?: string;
} = {}): string {
  return JSON.stringify({
    eventType: "Complaint",
    mail: { messageId: "0100018f-complaint" },
    complaint: {
      complainedRecipients: (input.addresses ?? ["angry@example.test"]).map(
        (emailAddress) => ({ emailAddress }),
      ),
      complaintFeedbackType: input.feedbackType ?? "abuse",
      feedbackId: "fb-2",
    },
  });
}

export function snsNotification(message: string): string {
  return JSON.stringify({
    Type: "Notification",
    MessageId: "sns-message-id",
    TopicArn: "arn:aws:sns:eu-west-1:000000000000:crossengin-bounces",
    Message: message,
    Timestamp: "2026-09-30T12:00:01.000Z",
  });
}

export function twilioStatusCallback(
  params: Readonly<Record<string, string>>,
): string {
  return new URLSearchParams(params).toString();
}
