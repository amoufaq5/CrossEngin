import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_RETRY,
  PAGE_RETRY_ATTEMPTS_VAR,
  PAGE_RETRY_DELAY_MS_VAR,
  PAGE_SLACK_TOKEN_VAR,
  PAGE_WEBHOOK_SECRET_VAR,
  buildPageDispatcher,
  buildPageSendersFromEnv,
  pageRetryFromEnv,
} from "./page-senders-env.js";

describe("buildPageSendersFromEnv", () => {
  it("wires PagerDuty with no environment at all", () => {
    const built = buildPageSendersFromEnv({});
    // The Events API authenticates on the routing key the alert policy already carries, so the
    // configuration most likely to be right when it matters needs nothing.
    expect(built.report.kinds).toContain("pagerduty_phone");
    expect(built.report.kinds).toContain("pagerduty_business_hours");
    expect(built.report.skipped).toEqual([]);
  });

  it("wires the webhook unsigned by default and signed when a secret is given", () => {
    expect(buildPageSendersFromEnv({}).report.kinds).toContain("webhook");
    const signed = buildPageSendersFromEnv({ [PAGE_WEBHOOK_SECRET_VAR]: "y".repeat(32) });
    expect(signed.report.kinds).toContain("webhook");
    expect(signed.report.skipped).toEqual([]);
  });

  it("leaves the webhook unwired rather than silently unsigned when the secret is too short", () => {
    const built = buildPageSendersFromEnv({ [PAGE_WEBHOOK_SECRET_VAR]: "short" });
    // A receiver expecting a signature would reject every page anyway, and dropping to unsigned is
    // a downgrade nobody asked for.
    expect(built.report.kinds).not.toContain("webhook");
    expect(built.report.skipped[0]).toContain("webhook");
  });

  it("wires Slack only with a bot token", () => {
    expect(buildPageSendersFromEnv({}).report.kinds).not.toContain("slack");
    expect(
      buildPageSendersFromEnv({ [PAGE_SLACK_TOKEN_VAR]: "xoxb-1" }).report.kinds,
    ).toContain("slack");
  });

  it("ignores a variable set to whitespace", () => {
    expect(buildPageSendersFromEnv({ [PAGE_SLACK_TOKEN_VAR]: "   " }).report.kinds).not.toContain(
      "slack",
    );
  });
});

describe("buildPageDispatcher", () => {
  it("labels the page with the signal and reports what happened", async () => {
    const reports: boolean[] = [];
    const dispatcher = buildPageDispatcher("audit-integrity", buildPageSendersFromEnv({}), (r) =>
      reports.push(r.undelivered),
    );
    const report = await dispatcher.deliver({
      severity: "sev1",
      incidentId: "INC-2026-0001",
      // Named in the policy, no sender wired for it: unroutable, and the directive is undelivered.
      channels: [{ kind: "slack", channel: "#ops" }],
    });
    expect(report.outcomes[0]?.disposition).toBe("unroutable");
    expect(reports).toEqual([true]);
  });
});

describe("SMS paging credentials", () => {
  const FULL = {
    PAGE_SMS_ACCOUNT_SID: "AC123",
    PAGE_SMS_AUTH_TOKEN: "tok",
    PAGE_SMS_FROM_NUMBER: "+15551234567",
  };

  it("is unwired until asked for, and never borrows the notification stack's Twilio vars", () => {
    expect(buildPageSendersFromEnv({}).report.kinds).not.toContain("sms");
    // A deployment should be able to page from a different number than its tenants' notifications
    // come from; silently reusing TWILIO_* would be the coupling ADR-0325 refused at the transport.
    expect(
      buildPageSendersFromEnv({
        TWILIO_ACCOUNT_SID: "AC999",
        TWILIO_AUTH_TOKEN: "t",
        TWILIO_FROM_NUMBER: "+15550000000",
      }).report.kinds,
    ).not.toContain("sms");
  });

  it("wires a complete set", () => {
    const built = buildPageSendersFromEnv(FULL);
    expect(built.report.kinds).toContain("sms");
    expect(built.report.skipped).toEqual([]);
  });

  it("reports a half-configured set rather than guessing or silently skipping", () => {
    // Started configuring and stopped: the sender refuses at construction and the reason surfaces
    // here, not at 3am.
    const noIdentity = buildPageSendersFromEnv({
      PAGE_SMS_ACCOUNT_SID: "AC123",
      PAGE_SMS_AUTH_TOKEN: "tok",
    });
    expect(noIdentity.report.kinds).not.toContain("sms");
    expect(noIdentity.report.skipped.join(" ")).toContain("sms");

    const noCredential = buildPageSendersFromEnv({
      PAGE_SMS_ACCOUNT_SID: "AC123",
      PAGE_SMS_FROM_NUMBER: "+15551234567",
    });
    expect(noCredential.report.skipped.join(" ")).toContain("sms");
  });

  it("refuses both sender identities at once", () => {
    const both = buildPageSendersFromEnv({
      ...FULL,
      PAGE_SMS_MESSAGING_SERVICE_SID: "MG123",
    });
    expect(both.report.skipped.join(" ")).toContain("sms");
  });
});

/**
 * Retry is on by default (ADR-0326).
 *
 * ADR-0325 left "nothing retries a failed page" open. It is not equally survivable across the three
 * escalators: two re-derive their finding every tick, while the integrity escalator's compromise
 * finding is one-shot — so for that one a transport blip is the whole alarm.
 */
describe("pageRetryFromEnv", () => {
  it("retries three times, two seconds apart, with nothing configured", () => {
    expect(pageRetryFromEnv({})).toEqual({ attempts: 3, delayMs: 2_000 });
    expect(pageRetryFromEnv({})).toEqual(DEFAULT_PAGE_RETRY);
  });

  it("takes an override from the environment", () => {
    expect(pageRetryFromEnv({ PAGE_RETRY_ATTEMPTS: "5", PAGE_RETRY_DELAY_MS: "500" })).toEqual({
      attempts: 5,
      delayMs: 500,
    });
  });

  it("allows 1 attempt, which is no retry at all", () => {
    expect(pageRetryFromEnv({ PAGE_RETRY_ATTEMPTS: "1" }).attempts).toBe(1);
  });

  it("allows a zero delay, for a deployment that wants the attempts back to back", () => {
    expect(pageRetryFromEnv({ PAGE_RETRY_DELAY_MS: "0" }).delayMs).toBe(0);
  });

  it("falls back to the default rather than refusing an unparseable value", () => {
    // Strictness here would mean a process that will not boot and therefore cannot page at all.
    for (const raw of ["", "   ", "soon", "NaN", "3.5e"]) {
      expect(pageRetryFromEnv({ PAGE_RETRY_ATTEMPTS: raw }).attempts).toBe(3);
    }
  });

  it("falls back rather than clamping an out-of-range value", () => {
    // Clamping would silently honour half of an instruction that was clearly a mistake.
    for (const raw of ["0", "-1", "11", "1000"]) {
      expect(pageRetryFromEnv({ PAGE_RETRY_ATTEMPTS: raw }).attempts).toBe(3);
    }
    for (const raw of ["-1", "60001"]) {
      expect(pageRetryFromEnv({ PAGE_RETRY_DELAY_MS: raw }).delayMs).toBe(2_000);
    }
  });

  it("truncates a fractional count rather than rejecting it", () => {
    expect(pageRetryFromEnv({ PAGE_RETRY_ATTEMPTS: "4.7" }).attempts).toBe(4);
  });

  it("names the two variables, so a deployment can find them", () => {
    expect(PAGE_RETRY_ATTEMPTS_VAR).toBe("PAGE_RETRY_ATTEMPTS");
    expect(PAGE_RETRY_DELAY_MS_VAR).toBe("PAGE_RETRY_DELAY_MS");
  });
});

describe("buildPageDispatcher retry", () => {
  it("retries a transport that failed, rather than dropping the page", async () => {
    let calls = 0;
    const sender = {
      kind: "pagerduty_phone",
      provider: "pagerduty",
      send: async (): Promise<{ outcome: string; httpStatus: number | null }> => {
        calls += 1;
        return { outcome: calls < 3 ? "failed" : "delivered", httpStatus: calls < 3 ? 502 : 202 };
      },
    };
    const dispatcher = buildPageDispatcher(
      "test",
      { senders: { pagerduty_phone: sender }, report: { kinds: ["pagerduty_phone"], skipped: [] } } as never,
      () => undefined,
      // No real waiting: the budget is what is under test, not the wall clock.
      { sleep: async () => undefined },
    );
    const report = await dispatcher.deliver({
      incidentId: "INC-2026-0001",
      severity: "sev1",
      channels: [{ kind: "pagerduty_phone", serviceKey: "svc" }],
    } as never);
    expect(report.delivered).toBe(1);
    // Three calls, which is the default budget — and the reason the one-shot integrity finding
    // survives a single transient 502.
    expect(calls).toBe(3);
    expect(report.outcomes[0]?.attemptsMade).toBe(3);
  });

  it("does not retry a page the provider refused", async () => {
    let calls = 0;
    const sender = {
      kind: "pagerduty_phone",
      provider: "pagerduty",
      send: async (): Promise<{ outcome: string; httpStatus: number | null }> => {
        calls += 1;
        return { outcome: "rejected", httpStatus: 400 };
      },
    };
    const dispatcher = buildPageDispatcher(
      "test",
      { senders: { pagerduty_phone: sender }, report: { kinds: ["pagerduty_phone"], skipped: [] } } as never,
      () => undefined,
      { sleep: async () => undefined },
    );
    await dispatcher.deliver({
      incidentId: "INC-2026-0001",
      severity: "sev1",
      channels: [{ kind: "pagerduty_phone", serviceKey: "svc" }],
    } as never);
    // A refusal is a decision: retrying collects the same refusal again, at the one moment the
    // platform most needs the attempts it has.
    expect(calls).toBe(1);
  });
});
