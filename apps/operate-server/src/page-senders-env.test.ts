import { describe, expect, it } from "vitest";

import {
  PAGE_SLACK_TOKEN_VAR,
  PAGE_WEBHOOK_SECRET_VAR,
  buildPageDispatcher,
  buildPageSendersFromEnv,
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
