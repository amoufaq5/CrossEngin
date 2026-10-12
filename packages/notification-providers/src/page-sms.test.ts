import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./email-ses.js";
import type { PageChannelSender } from "./page-dispatch.js";
import type { PageContent } from "./page-pagerduty.js";
import {
  MAX_PAGE_SMS_CHARACTERS,
  PAGE_SMS_PREFIX,
  SmsPageSender,
  smsPageBody,
  type SmsPageSenderOptions,
} from "./page-sms.js";
import { TWILIO_API_BASE_URL } from "./sms-twilio.js";
import { TEST_E164_NUMBER } from "./test-fakes.js";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const FROM = "+15550000000";
const INC = "INC-2026-0007";

const CONTENT: PageContent = {
  incidentId: INC,
  severity: "sev1",
  signal: "deletion-evidence",
};

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

/** Like `FakeFetch`, but it keeps the `AbortSignal` so the timeout wiring is observable. */
class SignalFetch {
  readonly calls: Recorded[] = [];

  constructor(
    private readonly status: number,
    private readonly body: string,
  ) {}

  get fn(): FetchLike {
    return async (url, init) => {
      this.calls.push({
        url,
        method: init.method,
        headers: { ...init.headers },
        body: init.body,
        signal: init.signal,
      });
      return {
        ok: this.status >= 200 && this.status < 300,
        status: this.status,
        text: async (): Promise<string> => this.body,
      };
    };
  }

  get only(): Recorded {
    const first = this.calls[0];
    if (first === undefined) throw new Error("SignalFetch: no request recorded");
    return first;
  }

  /** The form body parsed back into pairs, so assertions read as the wire does. */
  get form(): URLSearchParams {
    return new URLSearchParams(this.only.body ?? "");
  }
}

/** Resolves never; rejects only when the sender's own timer aborts it. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(new Error("the operation was aborted"));
    });
  });

const ACCEPTED = JSON.stringify({
  sid: "SM0123456789abcdef0123456789abcdef",
  status: "queued",
});

function sender(
  fetchImpl: FetchLike,
  overrides: Partial<SmsPageSenderOptions> = {},
): SmsPageSender {
  return new SmsPageSender({
    accountSid: ACCOUNT_SID,
    authToken: "auth-token-value",
    fromNumber: FROM,
    fetch: fetchImpl,
    ...overrides,
  });
}

describe("construction", () => {
  it("accepts an API key pair with a from number", () => {
    expect(
      () =>
        new SmsPageSender({
          accountSid: ACCOUNT_SID,
          apiKeySid: "SK0000000000000000000000000000001",
          apiKeySecret: "api-key-secret",
          fromNumber: FROM,
        }),
    ).not.toThrow();
  });

  it("accepts an auth token with a messaging service", () => {
    expect(
      () =>
        new SmsPageSender({
          accountSid: ACCOUNT_SID,
          authToken: "auth-token-value",
          messagingServiceSid: "MG0000000000000000000000000000001",
        }),
    ).not.toThrow();
  });

  it("refuses an empty accountSid", () => {
    expect(() => sender(new SignalFetch(201, ACCEPTED).fn, { accountSid: "" })).toThrow(
      /accountSid is required/,
    );
  });

  it("refuses an apiKeySid with no apiKeySecret", () => {
    expect(() =>
      sender(new SignalFetch(201, ACCEPTED).fn, {
        authToken: undefined,
        apiKeySid: "SK0000000000000000000000000000001",
      }),
    ).toThrow(/must be supplied together/);
  });

  it("refuses an apiKeySecret with no apiKeySid", () => {
    expect(() =>
      sender(new SignalFetch(201, ACCEPTED).fn, {
        authToken: undefined,
        apiKeySecret: "api-key-secret",
      }),
    ).toThrow(/must be supplied together/);
  });

  it("refuses no credential at all", () => {
    expect(() => sender(new SignalFetch(201, ACCEPTED).fn, { authToken: undefined })).toThrow(
      /apiKeySid \+ apiKeySecret or authToken/,
    );
  });

  it("treats an empty authToken as absent rather than as a credential", () => {
    expect(() => sender(new SignalFetch(201, ACCEPTED).fn, { authToken: "" })).toThrow(
      /apiKeySid \+ apiKeySecret or authToken/,
    );
  });

  it("refuses when neither sender identity is given", () => {
    expect(() => sender(new SignalFetch(201, ACCEPTED).fn, { fromNumber: undefined })).toThrow(
      /exactly one of fromNumber or messagingServiceSid/,
    );
  });

  it("refuses when both sender identities are given", () => {
    expect(() =>
      sender(new SignalFetch(201, ACCEPTED).fn, {
        messagingServiceSid: "MG0000000000000000000000000000001",
      }),
    ).toThrow(/exactly one of fromNumber or messagingServiceSid/);
  });

  it("refuses a fromNumber that is not E.164", () => {
    expect(() => sender(new SignalFetch(201, ACCEPTED).fn, { fromNumber: "555-0000" })).toThrow(
      /E\.164/,
    );
  });

  it("is assignable to PageChannelSender", () => {
    const asChannel: PageChannelSender = sender(new SignalFetch(201, ACCEPTED).fn);
    expect(asChannel.provider).toBe("twilio");
  });
});

describe("the body", () => {
  it("reads as the platform, the severity, the signal and the incident", () => {
    expect(smsPageBody(CONTENT)).toBe("CrossEngin SEV1 deletion-evidence INC-2026-0007");
  });

  it("is composed only of PageContent, so no tenant data can reach a lock screen", () => {
    const body = smsPageBody(CONTENT);
    // Everything left once the three declared inputs and the fixed prefix are removed must be
    // whitespace: there is no seam through which a tenant uuid or a tombstone id could arrive.
    const residue = body
      .replace(PAGE_SMS_PREFIX, "")
      .replace(CONTENT.severity.toUpperCase(), "")
      .replace(CONTENT.signal, "")
      .replace(CONTENT.incidentId, "");
    expect(residue.trim()).toBe("");
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(body.toLowerCase()).not.toContain("tomb_");
    expect(body.toLowerCase()).not.toContain("tenant");
  });

  it("fits one GSM-7 segment for realistic inputs", () => {
    for (const signal of ["audit-integrity", "deletion-evidence", "slo-availability"]) {
      for (const severity of ["sev1", "sev2"]) {
        const body = smsPageBody({ incidentId: INC, severity, signal });
        expect(body.length).toBeLessThanOrEqual(MAX_PAGE_SMS_CHARACTERS);
        // GSM-7 basic set, conservatively: a non-ASCII character would force UCS-2 and halve the
        // segment. Every input is platform-minted or deployment-declared, so this holds by
        // construction and the assertion pins it.
        expect(body).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });

  it("truncates an overlong signal rather than the incident id", () => {
    const body = smsPageBody({ ...CONTENT, signal: "x".repeat(400) });
    expect(body.length).toBeLessThanOrEqual(MAX_PAGE_SMS_CHARACTERS);
    expect(body.endsWith(INC)).toBe(true);
  });

  it("keeps the incident id whole even when the prefix and id alone overflow", () => {
    const longId = `INC-${"9".repeat(200)}`;
    const body = smsPageBody({ ...CONTENT, incidentId: longId });
    expect(body).toContain(longId);
    expect(body).not.toContain(CONTENT.signal);
  });
});

describe("the request", () => {
  it("posts form-encoded to the account's Messages resource", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn).send(CONTENT, TEST_E164_NUMBER);
    expect(fetchImpl.only.url).toBe(
      `${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
    expect(fetchImpl.only.method).toBe("POST");
    expect(fetchImpl.only.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("authenticates with the API key pair when one is configured", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn, {
      authToken: undefined,
      apiKeySid: "SK0000000000000000000000000000001",
      apiKeySecret: "api-key-secret",
    }).send(CONTENT, TEST_E164_NUMBER);
    const header = fetchImpl.only.headers["authorization"] ?? "";
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")).toBe(
      "SK0000000000000000000000000000001:api-key-secret",
    );
  });

  it("falls back to accountSid and the auth token", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn).send(CONTENT, TEST_E164_NUMBER);
    const header = fetchImpl.only.headers["authorization"] ?? "";
    expect(Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")).toBe(
      `${ACCOUNT_SID}:auth-token-value`,
    );
  });

  it("sends From and the page body, percent-encoding the plus", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn).send(CONTENT, TEST_E164_NUMBER);
    expect(fetchImpl.only.body).toContain(`To=${encodeURIComponent(TEST_E164_NUMBER)}`);
    expect(fetchImpl.only.body).toContain("%2B");
    expect(fetchImpl.form.get("From")).toBe(FROM);
    expect(fetchImpl.form.get("MessagingServiceSid")).toBeNull();
    expect(fetchImpl.form.get("Body")).toBe(smsPageBody(CONTENT));
  });

  it("sends MessagingServiceSid instead of From when that identity is configured", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn, {
      fromNumber: undefined,
      messagingServiceSid: "MG0000000000000000000000000000001",
    }).send(CONTENT, TEST_E164_NUMBER);
    expect(fetchImpl.form.get("MessagingServiceSid")).toBe(
      "MG0000000000000000000000000000001",
    );
    expect(fetchImpl.form.get("From")).toBeNull();
  });

  it("asks for no StatusCallback, so a page cannot feed the suppression machinery", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn).send(CONTENT, TEST_E164_NUMBER);
    expect(fetchImpl.form.get("StatusCallback")).toBeNull();
  });

  it("uses an endpoint override verbatim", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn, {
      endpoint: "http://127.0.0.1:9099/twilio/Messages.json",
    }).send(CONTENT, TEST_E164_NUMBER);
    expect(fetchImpl.only.url).toBe("http://127.0.0.1:9099/twilio/Messages.json");
  });

  it("passes an abort signal on every send", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    await sender(fetchImpl.fn).send(CONTENT, TEST_E164_NUMBER);
    expect(fetchImpl.only.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl.only.signal?.aborted).toBe(false);
  });
});

describe("mapping the response", () => {
  it("reports delivered with the message sid as the reference", async () => {
    const result = await sender(new SignalFetch(201, ACCEPTED).fn).send(
      CONTENT,
      TEST_E164_NUMBER,
    );
    expect(result).toEqual({
      outcome: "delivered",
      provider: "twilio",
      httpStatus: 201,
      reference: "SM0123456789abcdef0123456789abcdef",
      errorMessage: null,
    });
  });

  it("still reports delivered, with no reference, when the 2xx body has no sid", async () => {
    const result = await sender(new SignalFetch(200, "not json at all").fn).send(
      CONTENT,
      TEST_E164_NUMBER,
    );
    expect(result.outcome).toBe("delivered");
    expect(result.reference).toBeNull();
  });

  it("reports rejected on a 400", async () => {
    const body = JSON.stringify({ code: 21211, message: "Invalid 'To' phone number" });
    const result = await sender(new SignalFetch(400, body).fn).send(CONTENT, TEST_E164_NUMBER);
    expect(result.outcome).toBe("rejected");
    expect(result.httpStatus).toBe(400);
    expect(result.errorMessage).toContain("21211");
  });

  it("reports rejected on a 401, because a retry with the same credential cannot work", async () => {
    const result = await sender(new SignalFetch(401, "unauthorized").fn).send(
      CONTENT,
      TEST_E164_NUMBER,
    );
    expect(result.outcome).toBe("rejected");
  });

  it("reports failed on a 500, because a retry may work", async () => {
    const result = await sender(new SignalFetch(503, "upstream").fn).send(
      CONTENT,
      TEST_E164_NUMBER,
    );
    expect(result.outcome).toBe("failed");
    expect(result.httpStatus).toBe(503);
  });

  it("reports failed when the transport throws, and does not propagate", async () => {
    const dead: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await sender(dead).send(CONTENT, TEST_E164_NUMBER);
    expect(result).toEqual({
      outcome: "failed",
      provider: "twilio",
      httpStatus: null,
      reference: null,
      errorMessage: "ECONNRESET",
    });
  });

  it("rejects a target that is not E.164 without calling the provider", async () => {
    const fetchImpl = new SignalFetch(201, ACCEPTED);
    const result = await sender(fetchImpl.fn).send(CONTENT, "ops@example.test");
    expect(result.outcome).toBe("rejected");
    expect(result.errorMessage).toContain("E.164");
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe("the timeout", () => {
  it("aborts the request after timeoutMs and reports failed", async () => {
    vi.useFakeTimers();
    try {
      const pending = sender(hangingFetch, { timeoutMs: 25 }).send(CONTENT, TEST_E164_NUMBER);
      await vi.advanceTimersByTimeAsync(26);
      const result = await pending;
      expect(result.outcome).toBe("failed");
      expect(result.errorMessage).toContain("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to ten seconds, the same as the sibling page senders", async () => {
    vi.useFakeTimers();
    try {
      const pending = sender(hangingFetch).send(CONTENT, TEST_E164_NUMBER);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect((await pending).outcome).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer on a normal send, so the process is not held open", async () => {
    vi.useFakeTimers();
    try {
      await sender(new SignalFetch(201, ACCEPTED).fn).send(CONTENT, TEST_E164_NUMBER);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
