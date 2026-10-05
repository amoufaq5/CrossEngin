import { describe, expect, it } from "vitest";

import type { FetchLike } from "./email-ses.js";
import type { PageChannelSender } from "./page-dispatch.js";
import type { PageContent } from "./page-pagerduty.js";
import {
  EmailPageSender,
  MAX_PAGE_EMAIL_SUBJECT_LENGTH,
  PAGE_EMAIL_PREFIX,
  emailPageBody,
  emailPageSubject,
  type EmailPageSenderOptions,
} from "./page-email.js";

const INC = "INC-2026-0007";
const FROM = "pages@crossengin.example";
const TO = "oncall@crossengin.example";
const AT = new Date("2026-10-05T04:05:06.000Z");
/** A real AWS secret access key is 40 characters; SigV4's key derivation refuses under 16. */
const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";

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

class SignalFetch {
  readonly calls: Recorded[] = [];

  constructor(
    private readonly status: number,
    private readonly body: string,
    private readonly headers?: Headers,
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
        ...(this.headers === undefined ? {} : { headers: this.headers }),
      };
    };
  }

  get only(): Recorded {
    const first = this.calls[0];
    if (first === undefined) throw new Error("SignalFetch: no request recorded");
    return first;
  }

  get payload(): Record<string, unknown> {
    return JSON.parse(this.only.body ?? "{}") as Record<string, unknown>;
  }
}

/** Resolves never; rejects only when the sender's own timer aborts it. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(new Error("the operation was aborted"));
    });
  });

const ACCEPTED = JSON.stringify({ MessageId: "0100018c-ses-message-id" });

function sender(
  fetchImpl: FetchLike,
  over: Partial<EmailPageSenderOptions> = {},
): EmailPageSender {
  return new EmailPageSender({
    region: "eu-west-1",
    fromAddress: FROM,
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: SECRET },
    fetch: fetchImpl,
    now: () => AT,
    ...over,
  });
}

describe("emailPageSubject", () => {
  it("carries the grade, the signal and the incident id", () => {
    const subject = emailPageSubject(CONTENT);
    expect(subject).toBe(`[${PAGE_EMAIL_PREFIX} SEV1] deletion-evidence ${INC}`);
  });

  it("uppercases the severity so it reads at a glance in a preview", () => {
    expect(emailPageSubject({ ...CONTENT, severity: "sev2" })).toContain("SEV2");
  });

  it("drops the signal rather than the incident id when they overflow", () => {
    // The rule `page-sms.ts` reasons through: the label is a hint about what fired, the id is the
    // only thing a woken responder can look the detail up by.
    const subject = emailPageSubject({ ...CONTENT, signal: "x".repeat(400) });
    expect(subject.length).toBeLessThanOrEqual(MAX_PAGE_EMAIL_SUBJECT_LENGTH);
    expect(subject).toContain(INC);
  });

  it("leaves the id intact even when the prefix and id alone fill the budget", () => {
    const long = "INC-2026-" + "9".repeat(MAX_PAGE_EMAIL_SUBJECT_LENGTH);
    const subject = emailPageSubject({ ...CONTENT, incidentId: long });
    // Long rather than mangled: a two-line subject is a cost, a truncated id is a dead end.
    expect(subject).toContain(long);
  });

  it("carries nothing but the three PageContent fields", () => {
    // ADR-0310's rule. A subject renders in a lock-screen preview and crosses at least one
    // third-party mail server, so a tenant uuid or a tombstone id must not reach it.
    const subject = emailPageSubject(CONTENT);
    expect(subject).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(subject).not.toContain("tomb_");
  });
});

describe("emailPageBody", () => {
  it("names the severity, the signal and the incident", () => {
    const body = emailPageBody(CONTENT);
    expect(body).toContain("SEV1: deletion-evidence");
    expect(body).toContain(`Incident: ${INC}`);
  });

  it("says out loud that it carries no detail", () => {
    // So a responder does not go looking in the mail for something that is deliberately absent.
    expect(emailPageBody(CONTENT)).toContain("deliberately carries none of it");
  });

  it("is text and contains no markup", () => {
    // Text only on purpose: the one input that could carry markup is the deployment-declared
    // signal, so an HTML body would add an injection surface to render three unformatted fields.
    const body = emailPageBody({ ...CONTENT, signal: "<img src=x onerror=alert(1)>" });
    expect(body).not.toContain("<html");
    // The signal is reproduced verbatim rather than escaped, which is safe precisely because the
    // body is never rendered as markup — and a test pins that so nobody adds an HTML part without
    // also escaping it.
    expect(body).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("construction", () => {
  it("refuses a blank region", () => {
    expect(() => sender(new SignalFetch(200, ACCEPTED).fn, { region: "  " })).toThrow(
      /region is required/,
    );
  });

  it("refuses a from address that is not an address", () => {
    for (const bad of ["+15550000000", "#oncall", "oncall", "oncall@localhost", ""]) {
      expect(() => sender(new SignalFetch(200, ACCEPTED).fn, { fromAddress: bad }), bad).toThrow(
        /fromAddress/,
      );
    }
  });

  it("refuses half-configured credentials", () => {
    expect(() =>
      sender(new SignalFetch(200, ACCEPTED).fn, {
        credentials: { accessKeyId: "", secretAccessKey: SECRET },
      }),
    ).toThrow(/accessKeyId and secretAccessKey/);
    expect(() =>
      sender(new SignalFetch(200, ACCEPTED).fn, {
        credentials: { accessKeyId: "AKIA", secretAccessKey: "" },
      }),
    ).toThrow(/accessKeyId and secretAccessKey/);
  });

  it("refuses a secret too short to derive a SigV4 signing key", () => {
    // Not cosmetic: `hmacSha256Hex` refuses a key under 16 bytes, so without this the failure
    // lands on the first send — a `sev1` reporting `failed` for a reason no retry can fix.
    expect(() =>
      sender(new SignalFetch(200, ACCEPTED).fn, {
        credentials: { accessKeyId: "AKIA", secretAccessKey: "tooshort" },
      }),
    ).toThrow(/at least 16 characters/);
  });

  it("accepts a session token, which SigV4 must sign rather than merely send", () => {
    const fake = new SignalFetch(200, ACCEPTED);
    const s = sender(fake.fn, {
      credentials: {
        accessKeyId: "AKIA",
        secretAccessKey: SECRET,
        sessionToken: "token",
      },
    });
    expect(s).toBeInstanceOf(EmailPageSender);
  });
});

describe("send", () => {
  it("delivers and reports the SES message id", async () => {
    const fake = new SignalFetch(200, ACCEPTED);
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result).toMatchObject({
      outcome: "delivered",
      provider: "ses",
      httpStatus: 200,
      reference: "0100018c-ses-message-id",
      errorMessage: null,
    });
  });

  it("posts a Simple SES v2 message to the regional endpoint", async () => {
    const fake = new SignalFetch(200, ACCEPTED);
    await sender(fake.fn).send(CONTENT, TO);
    expect(fake.only.url).toBe(
      "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails",
    );
    expect(fake.only.method).toBe("POST");
    const payload = fake.payload as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Simple: { Subject: { Data: string } } };
    };
    expect(payload.FromEmailAddress).toBe(FROM);
    expect(payload.Destination.ToAddresses).toEqual([TO]);
    expect(payload.Content.Simple.Subject.Data).toContain(INC);
  });

  it("signs the request, including the payload hash", async () => {
    const fake = new SignalFetch(200, ACCEPTED);
    await sender(fake.fn).send(CONTENT, TO);
    expect(fake.only.headers["authorization"]).toContain("AWS4-HMAC-SHA256");
    expect(fake.only.headers["authorization"]).toContain("Credential=AKIAEXAMPLE/");
    expect(fake.only.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.only.headers["x-amz-date"]).toBe("20261005T040506Z");
  });

  it("asks for no configuration set and no tags", async () => {
    // Both are how a notification's SES event reaches the bounce webhook and becomes a
    // suppression. A page that bounces is a deployment to fix, not an address to stop paging.
    const fake = new SignalFetch(200, ACCEPTED);
    await sender(fake.fn).send(CONTENT, TO);
    const body = fake.only.body ?? "";
    expect(body).not.toContain("ConfigurationSetName");
    expect(body).not.toContain("EmailTags");
  });

  it("rejects a target that is not an email address, without calling SES", async () => {
    const fake = new SignalFetch(200, ACCEPTED);
    for (const bad of ["+15550000000", "#oncall", "https://hook.example", "oncall"]) {
      const result = await sender(fake.fn).send(CONTENT, bad);
      // `rejected`, not `failed`: an identical retry cannot succeed.
      expect(result.outcome, bad).toBe("rejected");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("names the position and not the value when it rejects a target", async () => {
    // A rejected "email address" is exactly the thing that might be somebody's phone number.
    const fake = new SignalFetch(200, ACCEPTED);
    const result = await sender(fake.fn).send(CONTENT, "+15551234567");
    expect(result.errorMessage).toBe("page email target is not an email address");
    expect(result.errorMessage).not.toContain("5551234567");
  });

  it("treats a 429 as retryable, not as a refusal", async () => {
    // `classifyPageFailure`'s whole reason for existing: every HTTP page sender had classified the
    // most ordinary transient provider failure into the never-retried set.
    const fake = new SignalFetch(
      429,
      JSON.stringify({ __type: "TooManyRequestsException", message: "slow down" }),
    );
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result.outcome).toBe("failed");
    expect(result.httpStatus).toBe(429);
  });

  it("surfaces the SES error message rather than the raw envelope", async () => {
    const fake = new SignalFetch(
      400,
      JSON.stringify({ __type: "MessageRejected", message: "Email address is not verified" }),
    );
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result.errorMessage).toBe("Email address is not verified");
  });

  it("falls back to the exception type when there is no message", async () => {
    const fake = new SignalFetch(400, JSON.stringify({ __type: "MessageRejected" }));
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result.errorMessage).toBe("MessageRejected");
  });

  it("falls back to the raw body when it is not SES JSON at all", async () => {
    const fake = new SignalFetch(502, "<html>bad gateway</html>");
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result.outcome).toBe("failed");
    expect(result.errorMessage).toContain("bad gateway");
  });

  it("carries Retry-After through on a retryable failure", async () => {
    const headers = new Headers({ "retry-after": "7" });
    const fake = new SignalFetch(503, "unavailable", headers);
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result.retryAfterMs).toBe(7000);
  });

  it("does not carry Retry-After on a terminal refusal", async () => {
    // The dispatcher only retries `failed`, so a wait attached to a decision would be noise at
    // best and a reason to hold a page at worst.
    const headers = new Headers({ "retry-after": "7" });
    const fake = new SignalFetch(400, JSON.stringify({ __type: "MessageRejected" }), headers);
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result.outcome).toBe("rejected");
    // `null`, not absent: `retryAfterFromResponse` returns null for a non-retryable outcome, so
    // the field is present and empty rather than missing — which is what the dispatcher reads.
    expect(result.retryAfterMs).toBeNull();
  });

  it("reports a transport failure as failed, never throwing", async () => {
    // The incident is already durable; a throw would make a successful declaration look like a
    // failed escalation, and the dispatcher's `catch` is for a sender that broke its contract.
    const result = await sender(async () => {
      throw new Error("ENOTFOUND email.eu-west-1.amazonaws.com");
    }).send(CONTENT, TO);
    expect(result).toMatchObject({ outcome: "failed", provider: "ses", httpStatus: null });
    expect(result.errorMessage).toContain("ENOTFOUND");
  });

  it("aborts rather than hanging a page behind a dead socket", async () => {
    const result = await sender(hangingFetch, { timeoutMs: 5 }).send(CONTENT, TO);
    expect(result.outcome).toBe("failed");
    expect(result.errorMessage).toContain("abort");
  });

  it("posts to an endpoint override while still signing the real SES host", async () => {
    // The signature commits to the host it was computed for, so a proxy forwarding the request
    // unchanged still presents one AWS accepts. Signing the proxy's host would break every send
    // through the configuration the override exists for.
    const fake = new SignalFetch(200, ACCEPTED);
    await sender(fake.fn, { endpoint: "http://127.0.0.1:9099/ses" }).send(CONTENT, TO);
    expect(fake.only.url).toBe("http://127.0.0.1:9099/ses");
    expect(fake.only.headers["host"]).toBe("email.eu-west-1.amazonaws.com");
  });

  it("reports delivered with a null reference when SES returns no message id", async () => {
    const fake = new SignalFetch(200, "{}");
    const result = await sender(fake.fn).send(CONTENT, TO);
    expect(result.outcome).toBe("delivered");
    expect(result.reference).toBeNull();
  });

  it("satisfies PageChannelSender structurally", () => {
    // Typecheck-only, and the reason ADR-0307's overlay exists: a sender that stopped satisfying
    // the dispatcher's contract would otherwise fail at runtime inside a catch.
    const s: PageChannelSender = sender(new SignalFetch(200, ACCEPTED).fn);
    expect(s.provider).toBe("ses");
  });

  it("offers no resolve, which an all-unsupported fan-out must not read as a failure", () => {
    // ADR-0326: `resolve` is optional, and a sent email cannot be unsent. The dispatcher reports
    // `unsupported`, which `asked` excludes, so a resolve over email alone is not `undelivered`.
    const s: PageChannelSender = sender(new SignalFetch(200, ACCEPTED).fn);
    expect(s.resolve).toBeUndefined();
  });
});
