import { describe, expect, it } from "vitest";

import {
  PAGE_CHANNEL_DISPOSITIONS,
  PAGE_CHANNEL_KINDS,
  PageDispatcher,
  formatPageReport,
  pageAddressFor,
  type PageChannelSender,
  type PageDirectiveLike,
} from "./page-dispatch.js";
import {
  PAGERDUTY_EVENTS_URL,
  PagerDutyPageSender,
  pagerDutyEventBody,
  pagerDutySeverityFor,
  type PageContent,
  type PageSendResult,
} from "./page-pagerduty.js";
import {
  MIN_PAGE_SIGNING_SECRET_BYTES,
  PAGE_SIGNATURE_HEADER,
  PAGE_TIMESTAMP_HEADER,
  SlackPageSender,
  WebhookPageSender,
  slackPageBody,
} from "./page-slack.js";
import type { FetchLike } from "./email-ses.js";

const INC = "INC-2026-0007";
const CONTENT: PageContent = { incidentId: INC, severity: "sev1", signal: "deletion-evidence" };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(
  responses: readonly { ok: boolean; status: number; text: string }[],
): { readonly fetch: FetchLike; readonly calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body ?? "" });
      const r = responses[Math.min(i++, responses.length - 1)] ?? {
        ok: true,
        status: 202,
        text: "{}",
      };
      return { ok: r.ok, status: r.status, text: async () => r.text };
    },
  };
}

function senderStub(result: Partial<PageSendResult> = {}): {
  readonly sender: PageChannelSender;
  readonly seen: Array<{ content: PageContent; address: string }>;
} {
  const seen: Array<{ content: PageContent; address: string }> = [];
  return {
    seen,
    sender: {
      provider: "stub",
      send: async (content, address): Promise<PageSendResult> => {
        seen.push({ content, address });
        return {
          outcome: "delivered",
          provider: "stub",
          httpStatus: 202,
          reference: address,
          errorMessage: null,
          ...result,
        };
      },
    },
  };
}

const DIRECTIVE: PageDirectiveLike = {
  severity: "sev1",
  incidentId: INC,
  channels: [{ kind: "pagerduty_phone", serviceKey: "svc-key-1" }],
};

describe("the channel vocabulary", () => {
  it("mirrors every alert channel an AlertPolicy can name", () => {
    expect(PAGE_CHANNEL_KINDS).toEqual([
      "pagerduty_phone",
      "pagerduty_business_hours",
      "slack",
      "email_digest",
      "sms",
      "webhook",
    ]);
  });

  it("separates a transport failure from a policy that cannot be acted on", () => {
    expect(PAGE_CHANNEL_DISPOSITIONS).toEqual([
      "delivered",
      "rejected",
      "failed",
      "unroutable",
      "no_address",
    ]);
  });

  it("takes each kind's address from the field that kind carries", () => {
    expect(pageAddressFor({ kind: "pagerduty_phone", serviceKey: "k" })).toBe("k");
    expect(pageAddressFor({ kind: "pagerduty_business_hours", serviceKey: "k" })).toBe("k");
    expect(pageAddressFor({ kind: "slack", channel: "#ops" })).toBe("#ops");
    expect(pageAddressFor({ kind: "webhook", url: "https://x.test/p" })).toBe("https://x.test/p");
    expect(pageAddressFor({ kind: "email_digest", recipients: ["a@b.test"] })).toBe("a@b.test");
    expect(pageAddressFor({ kind: "sms", phoneNumbers: ["+15551234567"] })).toBe("+15551234567");
    expect(pageAddressFor({ kind: "slack" })).toBeNull();
  });
});

describe("PagerDuty", () => {
  it("puts the routing key in the body, because it IS the credential", async () => {
    const f = fakeFetch([{ ok: true, status: 202, text: '{"dedup_key":"INC-2026-0007"}' }]);
    const result = await new PagerDutyPageSender({ fetch: f.fetch }).send(CONTENT, "svc-key-1");
    expect(result.outcome).toBe("delivered");
    expect(f.calls[0]?.url).toBe(PAGERDUTY_EVENTS_URL);
    // No authorization header at all: the Events API authenticates on routing_key.
    expect(f.calls[0]?.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toMatchObject({ routing_key: "svc-key-1" });
  });

  it("dedups on the incident id, so re-paging updates one alert", () => {
    const body = JSON.parse(pagerDutyEventBody(CONTENT, "k", "crossengin")) as {
      dedup_key: string;
    };
    // The provider-level mirror of ADR-0294's once-per-episode rule.
    expect(body.dedup_key).toBe(INC);
  });

  it("carries no tenant data — an id, a severity and a declared label", () => {
    const raw = pagerDutyEventBody(CONTENT, "k", "crossengin");
    const body = JSON.parse(raw) as { payload: { summary: string; custom_details: unknown } };
    expect(body.payload.summary).toBe("deletion-evidence sev1 INC-2026-0007");
    // custom_details is the obvious place to put the finding, and is deliberately empty of it:
    // PagerDuty renders these into emails, SMS and push.
    expect(body.payload.custom_details).toEqual({ incidentId: INC, signal: "deletion-evidence" });
    expect(raw).not.toContain("tomb_");
    expect(raw).not.toContain("tenant");
  });

  it("maps our severities onto PagerDuty's", () => {
    expect(pagerDutySeverityFor("sev1")).toBe("critical");
    expect(pagerDutySeverityFor("sev2")).toBe("critical");
    expect(pagerDutySeverityFor("sev3")).toBe("error");
  });

  it("distinguishes a refusal from a transport failure", async () => {
    const rejected = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: false, status: 400, text: "bad routing key" }]).fetch,
    }).send(CONTENT, "k");
    expect(rejected.outcome).toBe("rejected");
    const failed = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: false, status: 503, text: "unavailable" }]).fetch,
    }).send(CONTENT, "k");
    // Retrying may work, so it is not the same answer as "PagerDuty said no".
    expect(failed.outcome).toBe("failed");
  });

  it("reports a thrown transport as failed rather than propagating", async () => {
    const result = await new PagerDutyPageSender({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    }).send(CONTENT, "k");
    expect(result.outcome).toBe("failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
  });
});

describe("Slack", () => {
  it("posts to the policy's channel with a bot token", async () => {
    const f = fakeFetch([{ ok: true, status: 200, text: '{"ok":true}' }]);
    const result = await new SlackPageSender({ botToken: "xoxb-1", fetch: f.fetch }).send(
      CONTENT,
      "#ops",
    );
    expect(result.outcome).toBe("delivered");
    expect(f.calls[0]?.headers["authorization"]).toBe("Bearer xoxb-1");
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toMatchObject({ channel: "#ops" });
  });

  it("reads Slack's 200-with-ok:false as a refusal, not a delivery", async () => {
    const result = await new SlackPageSender({
      botToken: "xoxb-1",
      fetch: fakeFetch([{ ok: true, status: 200, text: '{"ok":false,"error":"channel_not_found"}' }])
        .fetch,
    }).send(CONTENT, "#nope");
    // The HTTP status alone would report a page as delivered that Slack dropped.
    expect(result.outcome).toBe("rejected");
    expect(result.errorMessage).toContain("channel_not_found");
  });

  it("refuses an empty bot token at construction", () => {
    expect(() => new SlackPageSender({ botToken: "" })).toThrow();
  });

  it("names the severity and the incident, and nothing else", () => {
    expect(slackPageBody(CONTENT, "#ops")).toContain("SEV1 deletion-evidence — INC-2026-0007");
  });
});

describe("the signed webhook", () => {
  it("signs timestamp.body so a captured page cannot be replayed", async () => {
    const f = fakeFetch([{ ok: true, status: 200, text: "ok" }]);
    const at = new Date("2026-10-03T16:00:00.000Z");
    const result = await new WebhookPageSender({
      signingSecret: "x".repeat(32),
      fetch: f.fetch,
      clock: () => at,
    }).send(CONTENT, "https://ops.test/page");
    expect(result.outcome).toBe("delivered");
    expect(f.calls[0]?.headers[PAGE_TIMESTAMP_HEADER]).toBe(at.toISOString());
    expect(f.calls[0]?.headers[PAGE_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends unsigned when no secret is configured", async () => {
    const f = fakeFetch([{ ok: true, status: 200, text: "ok" }]);
    await new WebhookPageSender({ fetch: f.fetch }).send(CONTENT, "https://ops.test/page");
    expect(f.calls[0]?.headers[PAGE_SIGNATURE_HEADER]).toBeUndefined();
  });

  it("refuses a secret too short to sign with, at construction", () => {
    // A `sev1` paging is the worst moment to discover the key is unusable.
    expect(() => new WebhookPageSender({ signingSecret: "short" })).toThrow(
      new RegExp(MIN_PAGE_SIGNING_SECRET_BYTES.toString()),
    );
  });

  it("carries only the three fields", async () => {
    const f = fakeFetch([{ ok: true, status: 200, text: "ok" }]);
    await new WebhookPageSender({ fetch: f.fetch }).send(CONTENT, "https://ops.test/page");
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toEqual({
      incidentId: INC,
      severity: "sev1",
      signal: "deletion-evidence",
    });
  });
});

describe("PageDispatcher", () => {
  it("delivers through the sender wired for the channel's kind", async () => {
    const pd = senderStub();
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: pd.sender },
      signal: "deletion-evidence",
    }).deliver(DIRECTIVE);
    expect(report).toMatchObject({ attempted: 1, delivered: 1, undelivered: false });
    expect(pd.seen[0]?.address).toBe("svc-key-1");
    expect(pd.seen[0]?.content.signal).toBe("deletion-evidence");
  });

  it("attempts every channel even when one throws", async () => {
    const throwing: PageChannelSender = {
      provider: "boom",
      send: async () => {
        throw new Error("provider exploded");
      },
    };
    const ok = senderStub();
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: throwing, slack: ok.sender },
      signal: "s",
    }).deliver({
      severity: "sev1",
      incidentId: INC,
      channels: [
        { kind: "pagerduty_phone", serviceKey: "k" },
        { kind: "slack", channel: "#ops" },
      ],
    });
    // One dead provider must not mask the rest.
    expect(report.outcomes.map((o) => o.disposition)).toEqual(["failed", "delivered"]);
    expect(report.delivered).toBe(1);
    expect(report.undelivered).toBe(false);
  });

  it("reports a channel with no sender as unroutable, never skipped", async () => {
    const report = await new PageDispatcher({ senders: {}, signal: "s" }).deliver(DIRECTIVE);
    expect(report.outcomes[0]?.disposition).toBe("unroutable");
    // Nothing was attempted, and the directive delivered nothing — which is the loud case.
    expect(report.attempted).toBe(0);
    expect(report.undelivered).toBe(true);
  });

  it("reports a policy target with no address separately", async () => {
    const report = await new PageDispatcher({
      senders: { slack: senderStub().sender },
      signal: "s",
    }).deliver({ severity: "sev1", incidentId: INC, channels: [{ kind: "slack" }] });
    expect(report.outcomes[0]?.disposition).toBe("no_address");
    expect(report.attempted).toBe(0);
  });

  it("flags a directive that nothing took as undelivered", async () => {
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: senderStub({ outcome: "rejected" }).sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(report.delivered).toBe(0);
    expect(report.undelivered).toBe(true);
  });

  it("is not undelivered when the directive named no channels at all", async () => {
    const report = await new PageDispatcher({ senders: {}, signal: "s" }).deliver({
      severity: "sev1",
      incidentId: INC,
      channels: [],
    });
    // Nothing was asked for, so nothing failed; the alert policy is what is wrong.
    expect(report.undelivered).toBe(false);
  });

  it("reports through onReport", async () => {
    const seen: string[] = [];
    await new PageDispatcher({
      senders: { pagerduty_phone: senderStub().sender },
      signal: "s",
      onReport: (r) => seen.push(r.incidentId),
    }).deliver(DIRECTIVE);
    expect(seen).toEqual([INC]);
  });

  it("formats a report a human can read at 3am", async () => {
    const report = await new PageDispatcher({ senders: {}, signal: "s" }).deliver(DIRECTIVE);
    const text = formatPageReport(report);
    expect(text).toContain(`PAGE UNDELIVERED ${INC}`);
    expect(text).toContain("pagerduty_phone → unroutable");
  });
});
