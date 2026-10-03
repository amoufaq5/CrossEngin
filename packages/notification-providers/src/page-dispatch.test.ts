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
  classifyPageFailure,
  pagerDutyEventBody,
  pagerDutyResolveBody,
  pagerDutySeverityFor,
  type PageContent,
  type PageDeliveryOutcome,
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

function fakeFetch(responses: readonly { ok: boolean; status: number; text: string }[]): {
  readonly fetch: FetchLike;
  readonly calls: Call[];
} {
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

/**
 * A sender that answers a scripted sequence of outcomes, repeating the last. `resolvable: false`
 * omits `resolve` entirely, which is the shape Slack and the webhook really have.
 */
function sequenceSender(
  outcomes: readonly PageDeliveryOutcome[],
  opts: { readonly resolvable?: boolean; readonly provider?: string } = {},
): {
  readonly sender: PageChannelSender;
  readonly sends: string[];
  readonly resolves: Array<{ incidentId: string; address: string }>;
} {
  const sends: string[] = [];
  const resolves: Array<{ incidentId: string; address: string }> = [];
  const provider = opts.provider ?? "stub";
  let i = 0;
  const next = (): PageDeliveryOutcome => outcomes[Math.min(i++, outcomes.length - 1)] ?? "failed";
  const base: PageChannelSender = {
    provider,
    send: async (_content, address): Promise<PageSendResult> => {
      sends.push(address);
      const outcome = next();
      return {
        outcome,
        provider,
        httpStatus: outcome === "delivered" ? 202 : 503,
        reference: outcome === "delivered" ? address : null,
        errorMessage: outcome === "delivered" ? null : `stub said ${outcome}`,
      };
    },
  };
  if (opts.resolvable === false) return { sender: base, sends, resolves };
  return {
    sends,
    resolves,
    sender: {
      ...base,
      resolve: async (incidentId, address): Promise<PageSendResult> => {
        resolves.push({ incidentId, address });
        const outcome = next();
        return {
          outcome,
          provider,
          httpStatus: outcome === "delivered" ? 202 : 503,
          reference: outcome === "delivered" ? incidentId : null,
          errorMessage: outcome === "delivered" ? null : `stub said ${outcome}`,
        };
      },
    },
  };
}

/** Records every delay a retry asked for, and waits for none of them. */
function recordingSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly waits: number[];
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms): Promise<void> => {
      waits.push(ms);
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
      "unsupported",
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

describe("closing a PagerDuty alert", () => {
  it("resolves on the same dedup_key, so it closes the alert this incident opened", () => {
    const body = JSON.parse(pagerDutyResolveBody(INC, "svc-key-1")) as Record<string, unknown>;
    expect(body).toEqual({
      routing_key: "svc-key-1",
      event_action: "resolve",
      dedup_key: INC,
    });
  });

  it("sends no payload, because the Events API rejects one on a resolve", () => {
    const body = JSON.parse(pagerDutyResolveBody(INC, "k")) as Record<string, unknown>;
    expect("payload" in body).toBe(false);
    expect(Object.keys(body)).toEqual(["routing_key", "event_action", "dedup_key"]);
  });

  it("POSTs the resolve to the same endpoint with no auth header", async () => {
    const f = fakeFetch([{ ok: true, status: 202, text: `{"dedup_key":"${INC}"}` }]);
    const result = await new PagerDutyPageSender({ fetch: f.fetch }).resolve(INC, "svc-key-1");
    expect(result.outcome).toBe("delivered");
    expect(result.reference).toBe(INC);
    expect(f.calls[0]?.url).toBe(PAGERDUTY_EVENTS_URL);
    expect(f.calls[0]?.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toMatchObject({ event_action: "resolve" });
  });

  it("references the incident even when PagerDuty echoes no dedup_key", async () => {
    const result = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: true, status: 202, text: "{}" }]).fetch,
    }).resolve(INC, "k");
    expect(result.reference).toBe(INC);
  });

  it("distinguishes a refused resolve from a transport failure, exactly as send does", async () => {
    const rejected = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: false, status: 400, text: "no such dedup_key" }]).fetch,
    }).resolve(INC, "k");
    expect(rejected.outcome).toBe("rejected");
    const failed = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: false, status: 502, text: "bad gateway" }]).fetch,
    }).resolve(INC, "k");
    expect(failed.outcome).toBe("failed");
  });

  it("still names nothing but the incident", () => {
    const raw = pagerDutyResolveBody(INC, "k");
    expect(raw).not.toContain("tomb_");
    expect(raw).not.toContain("tenant");
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
      fetch: fakeFetch([
        { ok: true, status: 200, text: '{"ok":false,"error":"channel_not_found"}' },
      ]).fetch,
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

  it("reports one attempt per channel when nothing is retried", async () => {
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: senderStub().sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(report.outcomes[0]?.attemptsMade).toBe(1);
  });

  it("reports no attempt for a disposition settled before any call", async () => {
    const unroutable = await new PageDispatcher({ senders: {}, signal: "s" }).deliver(DIRECTIVE);
    expect(unroutable.outcomes[0]?.attemptsMade).toBe(0);
    const noAddress = await new PageDispatcher({
      senders: { slack: senderStub().sender },
      signal: "s",
    }).deliver({ severity: "sev1", incidentId: INC, channels: [{ kind: "slack" }] });
    expect(noAddress.outcomes[0]?.attemptsMade).toBe(0);
  });
});

describe("PageDispatcher.resolve", () => {
  it("closes the alert over every channel whose sender can close one", async () => {
    const pd = sequenceSender(["delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: pd.sender },
      signal: "deletion-evidence",
    }).resolve(DIRECTIVE);
    expect(report).toMatchObject({ attempted: 1, delivered: 1, undelivered: false });
    // A resolve needs the incident id and the address, and nothing else — there is no content.
    expect(pd.resolves).toEqual([{ incidentId: INC, address: "svc-key-1" }]);
    expect(pd.sends).toEqual([]);
  });

  it("reports a sender with no resolve as unsupported, not as a failure", async () => {
    const slack = sequenceSender(["delivered"], { resolvable: false, provider: "slack" });
    const report = await new PageDispatcher({
      senders: { slack: slack.sender },
      signal: "s",
    }).resolve({
      severity: "sev1",
      incidentId: INC,
      channels: [{ kind: "slack", channel: "#ops" }],
    });
    expect(report.outcomes[0]?.disposition).toBe("unsupported");
    // Nothing was asked of it, so it was not attempted and nothing was sent.
    expect(report.outcomes[0]?.attemptsMade).toBe(0);
    expect(slack.sends).toEqual([]);
  });

  it("is NOT undelivered when every channel is unsupported", async () => {
    const report = await new PageDispatcher({
      senders: {
        slack: sequenceSender(["delivered"], { resolvable: false }).sender,
        webhook: sequenceSender(["delivered"], { resolvable: false }).sender,
      },
      signal: "s",
    }).resolve({
      severity: "sev1",
      incidentId: INC,
      channels: [
        { kind: "slack", channel: "#ops" },
        { kind: "webhook", url: "https://ops.test/p" },
      ],
    });
    // `undelivered` means a page that should have gone out did not. Nothing was asked of either
    // transport, because a posted message cannot be unposted — that is not the same thing.
    expect(report.undelivered).toBe(false);
    expect(report.attempted).toBe(0);
    expect(report.delivered).toBe(0);
  });

  it("IS undelivered when the one resolvable channel did not take it", async () => {
    const report = await new PageDispatcher({
      senders: {
        slack: sequenceSender(["delivered"], { resolvable: false }).sender,
        pagerduty_phone: sequenceSender(["failed"]).sender,
      },
      signal: "s",
    }).resolve({
      severity: "sev1",
      incidentId: INC,
      channels: [
        { kind: "slack", channel: "#ops" },
        { kind: "pagerduty_phone", serviceKey: "k" },
      ],
    });
    expect(report.outcomes.map((o) => o.disposition)).toEqual(["unsupported", "failed"]);
    expect(report.undelivered).toBe(true);
  });

  it("reports a resolve for a channel with no sender as unroutable", async () => {
    const report = await new PageDispatcher({ senders: {}, signal: "s" }).resolve(DIRECTIVE);
    expect(report.outcomes[0]?.disposition).toBe("unroutable");
    expect(report.undelivered).toBe(true);
  });

  it("prefers unsupported over no_address, because the transport is the reason", async () => {
    const report = await new PageDispatcher({
      senders: { slack: sequenceSender(["delivered"], { resolvable: false }).sender },
      signal: "s",
    }).resolve({ severity: "sev1", incidentId: INC, channels: [{ kind: "slack" }] });
    expect(report.outcomes[0]?.disposition).toBe("unsupported");
  });

  it("attempts every channel even when one resolve throws", async () => {
    const throwing: PageChannelSender = {
      provider: "boom",
      send: async (): Promise<PageSendResult> => {
        throw new Error("unreachable");
      },
      resolve: async (): Promise<PageSendResult> => {
        throw new Error("resolve exploded");
      },
    };
    const ok = sequenceSender(["delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: throwing, pagerduty_business_hours: ok.sender },
      signal: "s",
    }).resolve({
      severity: "sev1",
      incidentId: INC,
      channels: [
        { kind: "pagerduty_phone", serviceKey: "a" },
        { kind: "pagerduty_business_hours", serviceKey: "b" },
      ],
    });
    expect(report.outcomes.map((o) => o.disposition)).toEqual(["failed", "delivered"]);
    expect(report.outcomes[0]?.errorMessage).toContain("resolve exploded");
  });

  it("reports through onReport, like deliver", async () => {
    const seen: number[] = [];
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["delivered"]).sender },
      signal: "s",
      onReport: (r) => seen.push(r.delivered),
    }).resolve(DIRECTIVE);
    expect(seen).toEqual([1]);
  });

  it("drives a real PagerDutyPageSender end to end", async () => {
    const f = fakeFetch([{ ok: true, status: 202, text: `{"dedup_key":"${INC}"}` }]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: new PagerDutyPageSender({ fetch: f.fetch }) },
      signal: "audit-integrity",
    }).resolve(DIRECTIVE);
    expect(report.delivered).toBe(1);
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toEqual({
      routing_key: "svc-key-1",
      event_action: "resolve",
      dedup_key: INC,
    });
  });
});

describe("retrying a page", () => {
  it("does not retry at all by default", async () => {
    const s = sequenceSender(["failed", "delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(s.sends).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ disposition: "failed", attemptsMade: 1 });
  });

  it("retries a failed page and reports the attempt that worked", async () => {
    const s = sequenceSender(["failed", "delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 50 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    expect(report.outcomes[0]).toMatchObject({ disposition: "delivered", attemptsMade: 2 });
    expect(report.delivered).toBe(1);
    expect(report.undelivered).toBe(false);
    // It stops as soon as it succeeds; it does not use its whole budget.
    expect(s.sends).toHaveLength(2);
  });

  it("NEVER retries a rejected page, because the provider already said no", async () => {
    const s = sequenceSender(["rejected", "delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 5, delayMs: 10 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    // A 400 on the routing key or a `channel_not_found` is settled. Retrying it would collect the
    // same refusal again — and the scripted second outcome proves a retry *would* have "worked",
    // which is exactly the wrong reason to send one.
    expect(s.sends).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ disposition: "rejected", attemptsMade: 1 });
  });

  it("never retries unroutable — no number of attempts wires a sender", async () => {
    const sleep = recordingSleep();
    const report = await new PageDispatcher({
      senders: {},
      signal: "s",
      retry: { attempts: 4, delayMs: 10 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(report.outcomes[0]).toMatchObject({ disposition: "unroutable", attemptsMade: 0 });
    expect(sleep.waits).toEqual([]);
  });

  it("never retries no_address or unsupported", async () => {
    const sleep = recordingSleep();
    const opts = {
      signal: "s",
      retry: { attempts: 4, delayMs: 10 },
      sleep: sleep.sleep,
    } as const;
    const noAddress = await new PageDispatcher({
      ...opts,
      senders: { slack: sequenceSender(["failed"]).sender },
    }).deliver({ severity: "sev1", incidentId: INC, channels: [{ kind: "slack" }] });
    expect(noAddress.outcomes[0]).toMatchObject({ disposition: "no_address", attemptsMade: 0 });
    const unsupported = await new PageDispatcher({
      ...opts,
      senders: { slack: sequenceSender(["failed"], { resolvable: false }).sender },
    }).resolve({ severity: "sev1", incidentId: INC, channels: [{ kind: "slack", channel: "#o" }] });
    expect(unsupported.outcomes[0]).toMatchObject({ disposition: "unsupported", attemptsMade: 0 });
    expect(sleep.waits).toEqual([]);
  });

  it("treats attempts as a total, so 1 means one call", async () => {
    const s = sequenceSender(["failed", "delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 1, delayMs: 10 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    expect(s.sends).toHaveLength(1);
    expect(report.outcomes[0]?.attemptsMade).toBe(1);
  });

  it("clamps a nonsensical budget to one attempt rather than dropping the page", async () => {
    const s = sequenceSender(["failed"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 0, delayMs: 10 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    // 0 attempts would silently drop a sev1.
    expect(s.sends).toHaveLength(1);
    expect(report.outcomes[0]?.attemptsMade).toBe(1);
  });

  it("waits the configured delay before each retry, through the injected sleep", async () => {
    const sleep = recordingSleep();
    const s = sequenceSender(["failed"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 250 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // Three calls, two waits — a delay precedes a retry, never the first attempt.
    expect(s.sends).toHaveLength(3);
    expect(sleep.waits).toEqual([250, 250]);
    expect(report.outcomes[0]).toMatchObject({ disposition: "failed", attemptsMade: 3 });
    expect(report.undelivered).toBe(true);
  });

  it("retries a sender that throws, since a throw is a transport failure", async () => {
    let calls = 0;
    const flaky: PageChannelSender = {
      provider: "flaky",
      send: async (_content, address): Promise<PageSendResult> => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        return {
          outcome: "delivered",
          provider: "flaky",
          httpStatus: 202,
          reference: address,
          errorMessage: null,
        };
      },
    };
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: flaky },
      signal: "s",
      retry: { attempts: 2, delayMs: 5 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    expect(calls).toBe(2);
    expect(report.outcomes[0]).toMatchObject({ disposition: "delivered", attemptsMade: 2 });
  });

  it("retries a failed resolve on the same policy", async () => {
    const s = sequenceSender(["failed", "delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 2, delayMs: 5 },
      sleep: recordingSleep().sleep,
    }).resolve(DIRECTIVE);
    expect(s.resolves).toHaveLength(2);
    expect(report.outcomes[0]).toMatchObject({ disposition: "delivered", attemptsMade: 2 });
  });

  it("retries each channel on its own budget", async () => {
    const a = sequenceSender(["failed", "failed", "delivered"]);
    const b = sequenceSender(["failed", "delivered"]);
    const sleep = recordingSleep();
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: a.sender, pagerduty_business_hours: b.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 20 },
      sleep: sleep.sleep,
    }).deliver({
      severity: "sev1",
      incidentId: INC,
      channels: [
        { kind: "pagerduty_phone", serviceKey: "a" },
        { kind: "pagerduty_business_hours", serviceKey: "b" },
      ],
    });
    expect(a.sends).toHaveLength(3);
    expect(b.sends).toHaveLength(2);
    expect(report.outcomes.map((o) => o.attemptsMade)).toEqual([3, 2]);
    expect(sleep.waits).toEqual([20, 20, 20]);
  });

  it("names the attempt count in the log line only when it retried", async () => {
    const retried = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 1 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    expect(formatPageReport(retried)).toContain("pagerduty_phone → failed ×3");
    const once = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["delivered"]).sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(formatPageReport(once)).not.toContain("×");
  });
});

describe("classifyPageFailure", () => {
  it("treats 429 as retryable, unlike every other 4xx", () => {
    // The rejected/failed split exists so the dispatcher retries one and not the other. PagerDuty's
    // Events API and Slack's chat.postMessage both answer 429 with Retry-After under load, so
    // grouping it with the other 4xx made the retry unable to help in the case it exists for.
    expect(classifyPageFailure(429)).toBe("failed");
    expect(classifyPageFailure(400)).toBe("rejected");
    expect(classifyPageFailure(401)).toBe("rejected");
    expect(classifyPageFailure(404)).toBe("rejected");
    expect(classifyPageFailure(500)).toBe("failed");
    expect(classifyPageFailure(503)).toBe("failed");
  });

  it("is retried by the dispatcher, end to end", async () => {
    const delays: number[] = [];
    let calls = 0;
    const sender: PageChannelSender = {
      provider: "pd",
      send: async (): Promise<PageSendResult> => {
        calls += 1;
        return calls === 1
          ? {
              outcome: classifyPageFailure(429),
              provider: "pd",
              httpStatus: 429,
              reference: null,
              errorMessage: "rate limited",
            }
          : {
              outcome: "delivered",
              provider: "pd",
              httpStatus: 202,
              reference: "ok",
              errorMessage: null,
            };
      },
    };
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: sender },
      signal: "s",
      retry: { attempts: 2, delayMs: 100 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).deliver(DIRECTIVE);
    expect(report.delivered).toBe(1);
    expect(delays).toEqual([100]);
  });
});
