import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_BACKOFF_FACTOR,
  DEFAULT_PAGE_JITTER_RATIO,
  JITTERED_PAGE_RETRY,
  PAGE_CHANNEL_DISPOSITIONS,
  PAGE_CHANNEL_KINDS,
  PageDispatcher,
  fitsPageRetryBudget,
  formatPageReport,
  pageAddressFor,
  pageBackoffMs,
  waitBefore,
  type PageChannelSender,
  type PageDirectiveLike,
  type PageRetryPolicy,
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
import {
  DEFAULT_PAGE_RETRY_BUDGET_MS,
  MAX_PAGE_RETRY_BUDGET_MS,
  MAX_RETRY_AFTER_MS,
  type PageFetchLike,
} from "./retry-after.js";

const INC = "INC-2026-0007";
const CONTENT: PageContent = { incidentId: INC, severity: "sev1", signal: "deletion-evidence" };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * `retryAfter` is optional, and a response without one exposes **no `headers` member at all** —
 * which is the shape every `FetchLike` double in this repo has, and the shape whose behaviour must
 * stay exactly what it was.
 */
interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
  readonly retryAfter?: string;
}

function fakeFetch(responses: readonly FakeResponse[]): {
  readonly fetch: PageFetchLike;
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
      const base = { ok: r.ok, status: r.status, text: async (): Promise<string> => r.text };
      if (r.retryAfter === undefined) return base;
      const value = r.retryAfter;
      return {
        ...base,
        headers: { get: (n): string | null => (n === "retry-after" ? value : null) },
      };
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

/**
 * A sender whose first `n - 1` answers carry a `Retry-After`, scripted as the dispatcher would see
 * it: a `retryAfterMs` already parsed by the sender that read the header.
 */
function rateLimitedSender(
  scripted: readonly { readonly outcome: PageDeliveryOutcome; readonly retryAfterMs?: number }[],
): { readonly sender: PageChannelSender; readonly calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  return {
    calls,
    sender: {
      provider: "pd",
      send: async (): Promise<PageSendResult> => {
        const step = scripted[Math.min(i, scripted.length - 1)];
        i += 1;
        calls.push(i);
        const outcome = step?.outcome ?? "failed";
        return {
          outcome,
          provider: "pd",
          httpStatus: outcome === "delivered" ? 202 : 429,
          reference: outcome === "delivered" ? "ok" : null,
          errorMessage: outcome === "delivered" ? null : "rate limited",
          ...(step?.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
        };
      },
    },
  };
}

/**
 * A jitter source answering a scripted sequence of draws, repeating the last, and counting how many
 * were taken — because "a flat policy consumes no randomness" is itself a rule worth pinning.
 */
function scriptedRandom(draws: readonly number[]): {
  readonly random: () => number;
  readonly taken: number[];
} {
  const taken: number[] = [];
  let i = 0;
  return {
    taken,
    random: (): number => {
      const draw = draws[Math.min(i++, draws.length - 1)] ?? 0;
      taken.push(draw);
      return draw;
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

describe("honouring Retry-After", () => {
  it("waits the provider's figure rather than the policy's when it is longer", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: 5000 },
      { outcome: "delivered" },
    ]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // ADR-0326 waited 2s here, inside a window the provider had already said it would refuse.
    expect(sleep.waits).toEqual([5000]);
    expect(report.outcomes[0]).toMatchObject({ disposition: "delivered", attemptsMade: 2 });
  });

  it("does NOT let a shorter instruction shorten the platform's floor", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: 250 },
      { outcome: "delivered" },
    ]);
    await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([2000]);
  });

  it("does not turn Retry-After: 0 into a hot loop", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([{ outcome: "failed", retryAfterMs: 0 }]);
    await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // Zero is an instruction, and the policy delay is the floor it cannot push below.
    expect(sleep.waits).toEqual([2000, 2000]);
    expect(s.calls).toHaveLength(3);
  });

  it("re-reads the instruction each attempt, so a changed figure is honoured", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: 3000 },
      { outcome: "failed", retryAfterMs: 8000 },
      { outcome: "delivered" },
    ]);
    await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 1000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([3000, 8000]);
  });

  it("stops retrying when the provider asks for longer than the ceiling", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: MAX_RETRY_AFTER_MS },
      { outcome: "delivered" },
    ]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 5, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // Holding the page that long is no longer a page, and the scripted second outcome proves a
    // retry *would* have worked — which is the wrong reason to hold it.
    expect(s.calls).toHaveLength(1);
    expect(sleep.waits).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({
      disposition: "failed",
      attemptsMade: 1,
      // Reported as the ceiling, so the log says what the provider effectively asked for.
      retryAfterMs: MAX_RETRY_AFTER_MS,
    });
    expect(report.undelivered).toBe(true);
  });

  it("ignores a header on a rejected outcome, because it is never retried", async () => {
    const sleep = recordingSleep();
    // A sender that reports one anyway — the senders here do not, and the dispatcher must not
    // start retrying a refusal just because one arrived.
    const s = rateLimitedSender([{ outcome: "rejected", retryAfterMs: 5000 }]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(s.calls).toHaveLength(1);
    expect(sleep.waits).toEqual([]);
    expect(report.outcomes[0]?.disposition).toBe("rejected");
  });

  it("reaches the channel outcome, parsed, so an audit record can hold it", async () => {
    const s = rateLimitedSender([{ outcome: "failed", retryAfterMs: 7000 }]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(report.outcomes[0]?.retryAfterMs).toBe(7000);
  });

  it("states no instruction as null rather than leaving the key off", async () => {
    const delivered = await new PageDispatcher({
      senders: { pagerduty_phone: senderStub().sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(delivered.outcomes[0]?.retryAfterMs).toBeNull();
    const unroutable = await new PageDispatcher({ senders: {}, signal: "s" }).deliver(DIRECTIVE);
    expect(unroutable.outcomes[0]?.retryAfterMs).toBeNull();
    const threw = await new PageDispatcher({
      senders: {
        pagerduty_phone: {
          provider: "boom",
          send: async (): Promise<PageSendResult> => {
            throw new Error("ECONNRESET");
          },
        },
      },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(threw.outcomes[0]?.retryAfterMs).toBeNull();
  });

  it("leaves the no-header retry exactly as ADR-0326 left it", async () => {
    // Pinned explicitly: a regression here silently un-fixes the uniform retry rather than
    // breaking anything, because a sender reporting nothing is the common case.
    const sleep = recordingSleep();
    const s = sequenceSender(["failed", "failed", "delivered"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([2000, 2000]);
    expect(report.outcomes[0]).toMatchObject({ disposition: "delivered", attemptsMade: 3 });
  });

  it("takes the longer of the two, which is the whole rule", () => {
    expect(waitBefore(2000, 5000)).toBe(5000);
    expect(waitBefore(2000, 250)).toBe(2000);
    expect(waitBefore(2000, 0)).toBe(2000);
    // No instruction leaves the policy untouched.
    expect(waitBefore(2000, null)).toBe(2000);
    expect(waitBefore(0, null)).toBe(0);
  });
});

describe("a 429 read off a real page sender", () => {
  it("parses PagerDuty's Retry-After into the result the dispatcher retries on", async () => {
    const f = fakeFetch([
      { ok: false, status: 429, text: "rate limited", retryAfter: "5" },
      { ok: true, status: 202, text: `{"dedup_key":"${INC}"}` },
    ]);
    const sleep = recordingSleep();
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: new PagerDutyPageSender({ fetch: f.fetch }) },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([5000]);
    expect(report.outcomes[0]).toMatchObject({ disposition: "delivered", attemptsMade: 2 });
  });

  it("carries no instruction from a 400, which is not retryable", async () => {
    const result = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: false, status: 400, text: "bad routing key", retryAfter: "5" }])
        .fetch,
    }).send(CONTENT, "k");
    expect(result.outcome).toBe("rejected");
    expect(result.retryAfterMs).toBeNull();
  });

  it("parses Slack's Retry-After on a 429 too", async () => {
    const result = await new SlackPageSender({
      botToken: "xoxb-1",
      fetch: fakeFetch([{ ok: false, status: 429, text: "ratelimited", retryAfter: "3" }]).fetch,
    }).send(CONTENT, "#ops");
    expect(result.outcome).toBe("failed");
    expect(result.retryAfterMs).toBe(3000);
  });

  it("does not read one off Slack's 200-with-ok:false, which is a refusal", async () => {
    const result = await new SlackPageSender({
      botToken: "xoxb-1",
      fetch: fakeFetch([
        { ok: true, status: 200, text: '{"ok":false,"error":"ratelimited"}', retryAfter: "3" },
      ]).fetch,
    }).send(CONTENT, "#ops");
    expect(result.outcome).toBe("rejected");
    expect(result.retryAfterMs).toBeNull();
  });

  it("parses one off the signed webhook's 503", async () => {
    const result = await new WebhookPageSender({
      fetch: fakeFetch([{ ok: false, status: 503, text: "overloaded", retryAfter: "11" }]).fetch,
    }).send(CONTENT, "https://ops.test/page");
    expect(result.outcome).toBe("failed");
    expect(result.retryAfterMs).toBe(11_000);
  });

  it("reports no instruction when the response exposes no headers", async () => {
    // Every pre-existing double in this repo has that shape, and it must behave as it did.
    const result = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: false, status: 503, text: "unavailable" }]).fetch,
    }).send(CONTENT, "k");
    expect(result.outcome).toBe("failed");
    expect(result.retryAfterMs).toBeNull();
  });

  it("caps an over-ceiling instruction rather than passing it through", async () => {
    const result = await new PagerDutyPageSender({
      fetch: fakeFetch([{ ok: false, status: 429, text: "slow down", retryAfter: "600" }]).fetch,
    }).send(CONTENT, "k");
    expect(result.retryAfterMs).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe("backing off instead of retrying in lockstep", () => {
  it("leaves a policy naming only attempts and delayMs exactly as ADR-0326 left it", async () => {
    const sleep = recordingSleep();
    const rng = scriptedRandom([0.5]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: sleep.sleep,
      random: rng.random,
    }).deliver(DIRECTIVE);
    // The flat two seconds, twice. A change of shape in the delay in front of a human is opt-in.
    expect(sleep.waits).toEqual([2000, 2000]);
    // And no randomness consumed at all, which is what makes "unchanged" assertable rather than
    // merely true of these two numbers.
    expect(rng.taken).toEqual([]);
    expect(report.outcomes[0]?.attemptsMade).toBe(3);
  });

  it("multiplies each gap by the factor, compounding", async () => {
    const sleep = recordingSleep();
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 4, delayMs: 1000, backoffFactor: 2 },
      sleep: sleep.sleep,
      random: scriptedRandom([0]).random,
    }).deliver(DIRECTIVE);
    // A blip clears in the first 1s gap and never pays for the outage; an outage gets the spread.
    expect(sleep.waits).toEqual([1000, 2000, 4000]);
  });

  it("clamps a factor below 1, because a shrinking gap is not a backoff", async () => {
    const sleep = recordingSleep();
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      // It would also push the wait under the floor `delayMs` exists to be.
      retry: { attempts: 3, delayMs: 1000, backoffFactor: 0.5 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([1000, 1000]);
  });

  it("spreads the wait over a window above the gap, never below it", async () => {
    const sleep = recordingSleep();
    const rng = scriptedRandom([0, 1]);
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000, jitterRatio: 1 },
      sleep: sleep.sleep,
      random: rng.random,
    }).deliver(DIRECTIVE);
    // A draw of 0 is the floor itself and a draw of 1 is the top of the window: `[2000, 4000]`.
    // Equal jitter's 2× spread, shifted above the floor rather than straddling it, because
    // ADR-0327 made that floor the thing that stops `Retry-After: 0` becoming a hot loop.
    expect(sleep.waits).toEqual([2000, 4000]);
    expect(rng.taken).toEqual([0, 1]);
  });

  it("scales a mid-window draw linearly", async () => {
    const sleep = recordingSleep();
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000, jitterRatio: 1 },
      sleep: sleep.sleep,
      random: scriptedRandom([0.5, 0.25]).random,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([3000, 2500]);
  });

  it("clamps the ratio to one gap's worth, so the window is never wider than 2×", async () => {
    const sleep = recordingSleep();
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 4, delayMs: 1000, jitterRatio: 5 },
      sleep: sleep.sleep,
      random: scriptedRandom([1]).random,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([2000, 2000, 2000]);
  });

  it("takes no jitter from a source answering outside its contract", async () => {
    const sleep = recordingSleep();
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 4, delayMs: 1000, jitterRatio: 1 },
      sleep: sleep.sleep,
      random: scriptedRandom([Number.NaN, -1, 2]).random,
    }).deliver(DIRECTIVE);
    // A broken source costs the spread and never the floor: NaN and a negative draw contribute
    // nothing, and an over-range one is the top of the window rather than a multiple of it.
    expect(sleep.waits).toEqual([1000, 1000, 2000]);
  });

  it("never returns a gap below the floor, for any draw in range", () => {
    const policy: PageRetryPolicy = { attempts: 2, delayMs: 2000, jitterRatio: 1 };
    for (let i = 0; i <= 10; i += 1) {
      const draw = i / 10;
      const ms = pageBackoffMs(policy, 1, () => draw);
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThanOrEqual(4000);
    }
  });

  it("computes the gap from the attempts already made, not from the attempt number", () => {
    const rng = scriptedRandom([0]);
    // The first gap follows one attempt, so it is the un-grown `delayMs`.
    expect(pageBackoffMs({ attempts: 9, delayMs: 1000, backoffFactor: 3 }, 1, rng.random)).toBe(
      1000,
    );
    expect(pageBackoffMs({ attempts: 9, delayMs: 1000, backoffFactor: 3 }, 3, rng.random)).toBe(
      9000,
    );
    // A nonsensical count floors at the first gap rather than inverting the exponent.
    expect(pageBackoffMs({ attempts: 9, delayMs: 1000, backoffFactor: 3 }, 0, rng.random)).toBe(
      1000,
    );
    expect(rng.taken).toEqual([]);
  });

  it("answers an unsleepably large gap rather than Infinity", () => {
    // Compounding overflows eventually, and a budget comparison against Infinity is not a number
    // the dispatcher can act on. Any finite budget refuses this, which is the point.
    const ms = pageBackoffMs({ attempts: 2, delayMs: 1000, backoffFactor: 2 }, 5000, () => 0);
    expect(ms).toBe(Number.MAX_SAFE_INTEGER);
    expect(fitsPageRetryBudget({ attempts: 2, delayMs: 1000 }, 0, ms)).toBe(false);
  });
});

describe("the total waiting budget", () => {
  it("stops retrying when the next gap would not fit, rather than sleeping the remainder", async () => {
    const sleep = recordingSleep();
    const s = sequenceSender(["failed"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 10, delayMs: 1000, backoffFactor: 2, totalBudgetMs: 5000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // 1000 then 2000 fit; the 4000 would make 7000, so it is not slept at all. A retry that slept
    // the remainder and called anyway would arrive before the gap it computed was over.
    expect(sleep.waits).toEqual([1000, 2000]);
    expect(s.sends).toHaveLength(3);
    expect(report.outcomes[0]).toMatchObject({
      disposition: "failed",
      attemptsMade: 3,
      waitedMs: 3000,
    });
    expect(report.undelivered).toBe(true);
  });

  it("spends a budget exactly to its limit", async () => {
    const sleep = recordingSleep();
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 10, delayMs: 1000, backoffFactor: 2, totalBudgetMs: 7000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([1000, 2000, 4000]);
    expect(report.outcomes[0]?.waitedMs).toBe(7000);
  });

  it("is on by default, so an unbounded policy cannot be configured by accident", async () => {
    const sleep = recordingSleep();
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      // Both inside the ranges `pageRetryFromEnv` accepts, and nine minutes of waiting in front of
      // a `sev1` before this bound existed. The one new field that defaults to active: a budget a
      // caller opts into bounds nothing.
      retry: { attempts: 10, delayMs: 20_000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([20_000]);
    expect(report.outcomes[0]?.waitedMs).toBe(20_000);
    expect(DEFAULT_PAGE_RETRY_BUDGET_MS).toBe(30_000);
  });

  it("cannot be raised past the platform's hard ceiling", async () => {
    const sleep = recordingSleep();
    await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 10, delayMs: 25_000, totalBudgetMs: 600_000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // Clamped to 60s, so two gaps fit and the third does not. Above that the retry is spending the
    // window in which a human was supposed to have answered.
    expect(sleep.waits).toEqual([25_000, 25_000]);
    expect(MAX_PAGE_RETRY_BUDGET_MS).toBe(60_000);
  });

  it("bounds waiting, not attempts: a zero-delay policy still retries on a zero budget", async () => {
    const sleep = recordingSleep();
    const s = sequenceSender(["failed"]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 0, totalBudgetMs: 0 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([0, 0]);
    expect(s.sends).toHaveLength(3);
    expect(report.outcomes[0]?.waitedMs).toBe(0);
  });

  it("counts a provider's own instruction against the budget too", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: 20_000 },
      { outcome: "failed", retryAfterMs: 20_000 },
      { outcome: "delivered" },
    ]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 5, delayMs: 2000 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // Two instructions this long exceed the whole budget, so the second is refused — the ceiling on
    // one wait and the ceiling on all of them are separate bounds and both apply.
    expect(sleep.waits).toEqual([20_000]);
    expect(report.outcomes[0]).toMatchObject({ attemptsMade: 2, waitedMs: 20_000 });
  });

  it("answers the budget question on the summed wait", () => {
    const flat: PageRetryPolicy = { attempts: 3, delayMs: 1000 };
    expect(fitsPageRetryBudget(flat, 0, DEFAULT_PAGE_RETRY_BUDGET_MS)).toBe(true);
    expect(fitsPageRetryBudget(flat, 0, DEFAULT_PAGE_RETRY_BUDGET_MS + 1)).toBe(false);
    expect(fitsPageRetryBudget(flat, 29_000, 1000)).toBe(true);
    expect(fitsPageRetryBudget(flat, 29_000, 1001)).toBe(false);
    expect(fitsPageRetryBudget({ ...flat, totalBudgetMs: 1500 }, 1000, 500)).toBe(true);
    expect(fitsPageRetryBudget({ ...flat, totalBudgetMs: 1500 }, 1000, 501)).toBe(false);
  });
});

describe("a backoff that still obeys Retry-After", () => {
  it("waits the provider's figure when it is longer than the grown gap", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: 9000 },
      { outcome: "failed" },
      { outcome: "delivered" },
    ]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000, backoffFactor: 2 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // ADR-0327's rule, unchanged by the backoff: 9s because the provider said so, then 4s because
    // the gap grew and the provider said nothing.
    expect(sleep.waits).toEqual([9000, 4000]);
    expect(report.outcomes[0]).toMatchObject({ disposition: "delivered", waitedMs: 13_000 });
  });

  it("keeps the grown gap as the floor when the instruction is shorter", async () => {
    const sleep = recordingSleep();
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: 3000 },
      { outcome: "failed", retryAfterMs: 3000 },
      { outcome: "delivered" },
    ]);
    await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000, backoffFactor: 2 },
      sleep: sleep.sleep,
    }).deliver(DIRECTIVE);
    // The same instruction twice, honoured once: the second gap has grown past it, and the floor
    // is the platform's to raise.
    expect(sleep.waits).toEqual([3000, 4000]);
  });

  it("still stops at an over-ceiling instruction, and draws no jitter doing it", async () => {
    const sleep = recordingSleep();
    const rng = scriptedRandom([1]);
    const s = rateLimitedSender([
      { outcome: "failed", retryAfterMs: MAX_RETRY_AFTER_MS },
      { outcome: "delivered" },
    ]);
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: JITTERED_PAGE_RETRY,
      sleep: sleep.sleep,
      random: rng.random,
    }).deliver(DIRECTIVE);
    expect(s.calls).toHaveLength(1);
    expect(sleep.waits).toEqual([]);
    // The ceiling is answered before a gap is computed, so no draw is spent on a retry that is not
    // going to happen.
    expect(rng.taken).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({
      disposition: "failed",
      attemptsMade: 1,
      retryAfterMs: MAX_RETRY_AFTER_MS,
      waitedMs: 0,
    });
  });

  it("never retries a settled disposition, and spends no randomness on one", async () => {
    const sleep = recordingSleep();
    const rng = scriptedRandom([1]);
    const opts = {
      signal: "s",
      retry: JITTERED_PAGE_RETRY,
      sleep: sleep.sleep,
      random: rng.random,
    } as const;
    const rejected = await new PageDispatcher({
      ...opts,
      senders: { pagerduty_phone: sequenceSender(["rejected", "delivered"]).sender },
    }).deliver(DIRECTIVE);
    const unroutable = await new PageDispatcher({ ...opts, senders: {} }).deliver(DIRECTIVE);
    const noAddress = await new PageDispatcher({
      ...opts,
      senders: { slack: sequenceSender(["failed"]).sender },
    }).deliver({ severity: "sev1", incidentId: INC, channels: [{ kind: "slack" }] });
    const unsupported = await new PageDispatcher({
      ...opts,
      senders: { slack: sequenceSender(["failed"], { resolvable: false }).sender },
    }).resolve({ severity: "sev1", incidentId: INC, channels: [{ kind: "slack", channel: "#o" }] });
    expect(
      [rejected, unroutable, noAddress, unsupported].map((r) => r.outcomes[0]?.disposition),
    ).toEqual(["rejected", "unroutable", "no_address", "unsupported"]);
    expect(sleep.waits).toEqual([]);
    expect(rng.taken).toEqual([]);
  });
});

describe("the policy a deployment should run", () => {
  it("is ADR-0326's three attempts and two-second floor, grown and bounded", () => {
    expect(JITTERED_PAGE_RETRY).toEqual({
      attempts: 3,
      delayMs: 2000,
      backoffFactor: DEFAULT_PAGE_BACKOFF_FACTOR,
      jitterRatio: DEFAULT_PAGE_JITTER_RATIO,
      totalBudgetMs: DEFAULT_PAGE_RETRY_BUDGET_MS,
    });
    expect(DEFAULT_PAGE_BACKOFF_FACTOR).toBe(2);
    expect(DEFAULT_PAGE_JITTER_RATIO).toBe(1);
  });

  it("waits under twelve seconds in the worst case, against a five-minute ack target", async () => {
    const sleep = recordingSleep();
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: JITTERED_PAGE_RETRY,
      sleep: sleep.sleep,
      // The top of both windows, which is the worst case this policy can produce unaided.
      random: scriptedRandom([1, 1]).random,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([4000, 8000]);
    expect(report.outcomes[0]?.waitedMs).toBe(12_000);
    expect(report.outcomes[0]?.waitedMs).toBeLessThanOrEqual(DEFAULT_PAGE_RETRY_BUDGET_MS);
  });

  it("waits six seconds at the bottom of both windows, and pages at once either way", async () => {
    const sleep = recordingSleep();
    const s = sequenceSender(["failed"]);
    await new PageDispatcher({
      senders: { pagerduty_phone: s.sender },
      signal: "s",
      retry: JITTERED_PAGE_RETRY,
      sleep: sleep.sleep,
      random: scriptedRandom([0]).random,
    }).deliver(DIRECTIVE);
    expect(sleep.waits).toEqual([2000, 4000]);
    // Three calls, two gaps: the first attempt is never delayed, jitter or not. A page goes out at
    // once, which is why the *first* attempts of several replicas stay correlated by design.
    expect(s.sends).toHaveLength(3);
  });

  it("decorrelates two replicas that fail at the same instant", async () => {
    const waitsFor = async (draws: readonly number[]): Promise<number[]> => {
      const sleep = recordingSleep();
      await new PageDispatcher({
        senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
        signal: "s",
        retry: JITTERED_PAGE_RETRY,
        sleep: sleep.sleep,
        random: scriptedRandom(draws).random,
      }).deliver(DIRECTIVE);
      return sleep.waits;
    };
    const a = await waitsFor([0.1, 0.1]);
    const b = await waitsFor([0.9, 0.9]);
    // The failure mode is every replica of this process retrying one degraded provider at the same
    // two offsets. Same policy, same failure, different offsets — which spreads the second wave
    // without shedding a single call.
    expect(a).toEqual([2200, 4400]);
    expect(b).toEqual([3800, 7600]);
  });
});

describe("reporting how long it waited", () => {
  it("reports nothing waited for a single attempt or a settled disposition", async () => {
    const delivered = await new PageDispatcher({
      senders: { pagerduty_phone: senderStub().sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    expect(delivered.outcomes[0]?.waitedMs).toBe(0);
    const unroutable = await new PageDispatcher({ senders: {}, signal: "s" }).deliver(DIRECTIVE);
    expect(unroutable.outcomes[0]?.waitedMs).toBe(0);
  });

  it("reports the wait that preceded the attempt that settled it", async () => {
    const report = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed", "failed", "delivered"]).sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    // "Retried three times" is no longer enough on its own: under a growing, jittered gap three
    // attempts is anywhere from 4s to the whole budget, and the question an incident review asks
    // is how long before anybody was told.
    expect(report.outcomes[0]).toMatchObject({ attemptsMade: 3, waitedMs: 4000 });
  });

  it("keeps each channel's wait its own", async () => {
    const report = await new PageDispatcher({
      senders: {
        pagerduty_phone: sequenceSender(["failed", "failed", "delivered"]).sender,
        pagerduty_business_hours: sequenceSender(["failed", "delivered"]).sender,
      },
      signal: "s",
      retry: { attempts: 3, delayMs: 1000, backoffFactor: 2 },
      sleep: recordingSleep().sleep,
    }).deliver({
      severity: "sev1",
      incidentId: INC,
      channels: [
        { kind: "pagerduty_phone", serviceKey: "a" },
        { kind: "pagerduty_business_hours", serviceKey: "b" },
      ],
    });
    expect(report.outcomes.map((o) => o.waitedMs)).toEqual([3000, 1000]);
  });

  it("distinguishes the three ways a retry stops, with no fourth field", async () => {
    const budget = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 9, delayMs: 2000, totalBudgetMs: 4000 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    // Short of the policy's attempts, nothing left of the budget, no instruction: exhausted.
    expect(budget.outcomes[0]).toMatchObject({
      attemptsMade: 3,
      waitedMs: 4000,
      retryAfterMs: null,
    });
    const ceiling = await new PageDispatcher({
      senders: {
        pagerduty_phone: rateLimitedSender([
          { outcome: "failed", retryAfterMs: MAX_RETRY_AFTER_MS },
        ]).sender,
      },
      signal: "s",
      retry: { attempts: 9, delayMs: 2000 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    // Short of the policy's attempts with budget to spare: the instruction stopped it.
    expect(ceiling.outcomes[0]).toMatchObject({
      attemptsMade: 1,
      waitedMs: 0,
      retryAfterMs: MAX_RETRY_AFTER_MS,
    });
  });

  it("puts the elapsed wait beside the attempt count in the 3am log line", async () => {
    const retried = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["failed"]).sender },
      signal: "s",
      retry: { attempts: 3, delayMs: 2000, backoffFactor: 2 },
      sleep: recordingSleep().sleep,
    }).deliver(DIRECTIVE);
    expect(formatPageReport(retried)).toContain("pagerduty_phone → failed ×3 over 6.0s");
    const once = await new PageDispatcher({
      senders: { pagerduty_phone: sequenceSender(["delivered"]).sender },
      signal: "s",
    }).deliver(DIRECTIVE);
    // The common line stays as short as it was.
    expect(formatPageReport(once)).not.toContain("over");
  });
});
