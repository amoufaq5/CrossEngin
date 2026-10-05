import { describe, expect, it } from "vitest";

import { PAGE_CHANNEL_KINDS } from "@crossengin/notification-providers";

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

describe("every channel kind an alert policy can name", () => {
  it("has a transport when the environment is fully configured", () => {
    // The guarantee ADR-0329 closed. ADR-0325's rule is that a channel the policy **names** and the
    // environment cannot serve is a `sev1` that will not arrive — and `email_digest` was exactly
    // that until this increment, so a deployment whose only configured channel was email had its
    // page reported `unroutable` and nobody woken. Asserted over `PAGE_CHANNEL_KINDS` itself rather
    // than a hand-written list, so a kind added to the policy vocabulary tomorrow fails here
    // instead of silently becoming the next hole.
    const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const built = buildPageSendersFromEnv({
      PAGE_SLACK_BOT_TOKEN: "xoxb-1",
      PAGE_WEBHOOK_SECRET: SECRET,
      PAGE_SMS_ACCOUNT_SID: "AC123",
      PAGE_SMS_AUTH_TOKEN: "tok",
      PAGE_SMS_FROM_NUMBER: "+15551234567",
      PAGE_EMAIL_REGION: "eu-west-1",
      PAGE_EMAIL_FROM_ADDRESS: "pages@crossengin.example",
      PAGE_EMAIL_ACCESS_KEY_ID: "AKIAEXAMPLE",
      PAGE_EMAIL_SECRET_ACCESS_KEY: SECRET,
    });
    expect(built.report.skipped).toEqual([]);
    for (const kind of PAGE_CHANNEL_KINDS) {
      expect(built.report.kinds, kind).toContain(kind);
    }
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

describe("email paging credentials", () => {
  const SECRET = "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  const FULL = {
    PAGE_EMAIL_REGION: "eu-west-1",
    PAGE_EMAIL_FROM_ADDRESS: "pages@crossengin.example",
    PAGE_EMAIL_ACCESS_KEY_ID: "AKIAEXAMPLE",
    PAGE_EMAIL_SECRET_ACCESS_KEY: SECRET,
  };

  it("is unwired until asked for, and never borrows the notification stack's sender identity", () => {
    expect(buildPageSendersFromEnv({}).report.kinds).not.toContain("email_digest");
    // The identity never falls back, for the reason `TWILIO_VOICE_FROM_NUMBER` does not: a
    // deployment should page from a different sender than its tenants' notifications come from.
    expect(
      buildPageSendersFromEnv({
        SES_REGION: "us-east-1",
        SES_FROM_ADDRESS: "noreply@crossengin.example",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: SECRET,
      }).report.kinds,
    ).not.toContain("email_digest");
  });

  it("wires a complete set, closing the one channel kind that had no transport", () => {
    const built = buildPageSendersFromEnv(FULL);
    expect(built.report.kinds).toContain("email_digest");
    expect(built.report.skipped).toEqual([]);
  });

  it("borrows the AWS access key, because that is an account credential and not an identity", () => {
    // The asymmetry is deliberate: an access key is for the whole account and a deployment that
    // wants one set should not write it twice, while a sender identity is the thing that must not
    // be guessed.
    const built = buildPageSendersFromEnv({
      PAGE_EMAIL_REGION: "eu-west-1",
      PAGE_EMAIL_FROM_ADDRESS: "pages@crossengin.example",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: SECRET,
    });
    expect(built.report.kinds).toContain("email_digest");
    expect(built.report.skipped).toEqual([]);
  });

  it("reports a half-configured set rather than guessing or silently skipping", () => {
    const noRegion = buildPageSendersFromEnv({
      PAGE_EMAIL_FROM_ADDRESS: "pages@crossengin.example",
    });
    expect(noRegion.report.kinds).not.toContain("email_digest");
    expect(noRegion.report.skipped.join(" ")).toContain("PAGE_EMAIL_REGION");

    const noFrom = buildPageSendersFromEnv({ PAGE_EMAIL_REGION: "eu-west-1" });
    expect(noFrom.report.skipped.join(" ")).toContain("PAGE_EMAIL_FROM_ADDRESS");

    const noKey = buildPageSendersFromEnv({
      PAGE_EMAIL_REGION: "eu-west-1",
      PAGE_EMAIL_FROM_ADDRESS: "pages@crossengin.example",
    });
    expect(noKey.report.skipped.join(" ")).toContain("PAGE_EMAIL_ACCESS_KEY_ID");
  });

  it("reports the sender's own refusal rather than wiring something that fails at 3am", () => {
    const shortSecret = buildPageSendersFromEnv({ ...FULL, PAGE_EMAIL_SECRET_ACCESS_KEY: "short" });
    expect(shortSecret.report.kinds).not.toContain("email_digest");
    expect(shortSecret.report.skipped.join(" ")).toContain("at least 16 characters");

    const badFrom = buildPageSendersFromEnv({ ...FULL, PAGE_EMAIL_FROM_ADDRESS: "+15550000000" });
    expect(badFrom.report.kinds).not.toContain("email_digest");
    expect(badFrom.report.skipped.join(" ")).toContain("fromAddress");
  });

  it("treats a whitespace-only value as unset rather than as half-configured", () => {
    expect(buildPageSendersFromEnv({ PAGE_EMAIL_REGION: "   " }).report.kinds).not.toContain(
      "email_digest",
    );
    expect(buildPageSendersFromEnv({ PAGE_EMAIL_REGION: "   " }).report.skipped).toEqual([]);
  });

  it("accepts an endpoint override, for a VPC endpoint or a staging stand-in", () => {
    const built = buildPageSendersFromEnv({
      ...FULL,
      PAGE_EMAIL_ENDPOINT: "http://127.0.0.1:9099/ses",
    });
    expect(built.report.kinds).toContain("email_digest");
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
  it("retries three times from a two-second gap, growing and jittered, with nothing configured", () => {
    // The gap grows and jitters because the provider a page retries against is degraded for
    // everyone, so a flat delay had every replica arriving at the same two offsets (ADR-0328).
    expect(pageRetryFromEnv({})).toEqual({
      attempts: 3,
      delayMs: 2_000,
      backoffFactor: 2,
      jitterRatio: 1,
      totalBudgetMs: 30_000,
    });
  });

  it("keeps the dispatcher's own default policy as its starting point", () => {
    const fromEnv = pageRetryFromEnv({});
    expect(fromEnv.attempts).toBe(DEFAULT_PAGE_RETRY.attempts);
    expect(fromEnv.delayMs).toBe(DEFAULT_PAGE_RETRY.delayMs);
    expect(fromEnv.backoffFactor).toBe(DEFAULT_PAGE_RETRY.backoffFactor);
  });

  it("takes an override from the environment", () => {
    expect(
      pageRetryFromEnv({ PAGE_RETRY_ATTEMPTS: "5", PAGE_RETRY_DELAY_MS: "500" }),
    ).toMatchObject({ attempts: 5, delayMs: 500 });
  });

  it("bounds the total wait, which is what makes the two knobs above safe", () => {
    // Both of these are inside the ranges this function already accepted, and together they would
    // have held a sev1 for nine minutes — past the ack target the retry is sized against.
    const reckless = pageRetryFromEnv({
      PAGE_RETRY_ATTEMPTS: "10",
      PAGE_RETRY_DELAY_MS: "60000",
    });
    expect(reckless.totalBudgetMs).toBe(30_000);
  });

  it("takes a budget override, clamped to a ceiling the override cannot cross", () => {
    expect(pageRetryFromEnv({ PAGE_RETRY_BUDGET_MS: "10000" }).totalBudgetMs).toBe(10_000);
    // Out of range falls back to the default, as every other knob here does, rather than clamping —
    // clamping honours half of an instruction that was clearly a mistake.
    expect(pageRetryFromEnv({ PAGE_RETRY_BUDGET_MS: "600000" }).totalBudgetMs).toBe(30_000);
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
