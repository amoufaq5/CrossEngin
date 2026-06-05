import type { PageDirective } from "@crossengin/observability-runtime";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEBHOOK_RETRY,
  LoggingPageDeliverer,
  WebhookPageDeliverer,
  computeWebhookBackoffMs,
  deliverPages,
  formatPageLine,
  pagePayload,
  type FetchLike,
  type PageContext,
  type PageDeliverer,
} from "./page-sink.js";

const PAGE: PageDirective = {
  severity: "sev2",
  alertSeverity: "P1",
  channels: [
    { kind: "pagerduty_phone", serviceKey: "abc" },
    { kind: "slack", channel: "#alerts" },
  ],
  incidentId: "INC-2026-0001",
} as unknown as PageDirective;

const CTX: PageContext = { incidentId: "INC-2026-0001", severity: "sev2", reason: "escalated" };

describe("formatPageLine", () => {
  it("renders the incident, severities, reason, and channel kinds", () => {
    const line = formatPageLine(PAGE, CTX);
    expect(line).toContain("PAGE (escalated)");
    expect(line).toContain("INC-2026-0001");
    expect(line).toContain("sev2/P1");
    expect(line).toContain("pagerduty_phone, slack");
  });

  it("renders a placeholder when there are no channels", () => {
    const line = formatPageLine({ ...PAGE, channels: [] }, { ...CTX, reason: "declared" });
    expect(line).toContain("(no channels)");
    expect(line).toContain("PAGE (declared)");
  });
});

describe("LoggingPageDeliverer", () => {
  it("writes one line per delivered directive to the injected sink", () => {
    const lines: string[] = [];
    const deliverer = new LoggingPageDeliverer((l) => lines.push(l));
    deliverer.deliver(PAGE, CTX);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("INC-2026-0001");
  });
});

describe("deliverPages", () => {
  it("delivers every directive in order with the shared context", async () => {
    const seen: Array<{ id: string; reason: string }> = [];
    const deliverer: PageDeliverer = {
      deliver: (d, c) => { seen.push({ id: d.incidentId, reason: c.reason }); },
    };
    await deliverPages(deliverer, [PAGE, { ...PAGE, incidentId: "INC-2026-0002" }], CTX);
    expect(seen).toEqual([
      { id: "INC-2026-0001", reason: "escalated" },
      { id: "INC-2026-0002", reason: "escalated" },
    ]);
  });

  it("is a no-op for an empty directive list", async () => {
    let calls = 0;
    await deliverPages({ deliver: () => { calls += 1; } }, [], CTX);
    expect(calls).toBe(0);
  });
});

describe("pagePayload", () => {
  it("builds the normalized webhook body", () => {
    const payload = pagePayload(PAGE, CTX, "2026-06-05T12:00:00.000Z");
    expect(payload).toMatchObject({
      incidentId: "INC-2026-0001",
      severity: "sev2",
      alertSeverity: "P1",
      reason: "escalated",
      deliveredAt: "2026-06-05T12:00:00.000Z",
    });
    expect(payload.channels).toHaveLength(2);
  });
});

describe("WebhookPageDeliverer", () => {
  function fakeFetch(status: number): { fetchImpl: FetchLike; calls: Array<{ url: string; body: string; headers: Record<string, string> }> } {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: init.body, headers: init.headers });
        return { ok: status >= 200 && status < 300, status };
      },
    };
  }

  function sequenceFetch(statuses: readonly number[]): { fetchImpl: FetchLike; calls: number } {
    let i = 0;
    const ref = { fetchImpl: undefined as unknown as FetchLike, calls: 0 };
    ref.fetchImpl = async () => {
      const s = statuses[i] ?? statuses[statuses.length - 1];
      i += 1;
      ref.calls = i;
      const status = s ?? 200;
      return { ok: status >= 200 && status < 300, status };
    };
    return ref;
  }

  const noSleep = (): Promise<void> => Promise.resolve();
  const fixedRandom = (): number => 0.5;

  it("POSTs the JSON payload to the configured url with the merged headers", async () => {
    const f = fakeFetch(200);
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      headers: { authorization: "Bearer t", "PagerDuty-Token": "pd-xyz" },
      fetchImpl: f.fetchImpl,
      now: () => new Date("2026-06-05T12:00:00.000Z"),
    });
    await deliverer.deliver(PAGE, CTX);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://hooks.example/incident");
    expect(f.calls[0]?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer t",
      "PagerDuty-Token": "pd-xyz",
    });
    const body = JSON.parse(f.calls[0]?.body ?? "{}") as { incidentId: string; reason: string; deliveredAt: string };
    expect(body.incidentId).toBe("INC-2026-0001");
    expect(body.reason).toBe("escalated");
    expect(body.deliveredAt).toBe("2026-06-05T12:00:00.000Z");
  });

  it("retries one 503 and succeeds on the second attempt", async () => {
    const seq = sequenceFetch([503, 200]);
    const sleeps: number[] = [];
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      fetchImpl: seq.fetchImpl,
      sleepMs: async (ms) => { sleeps.push(ms); },
      random: fixedRandom,
      retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 },
    });
    await deliverer.deliver(PAGE, CTX);
    expect(seq.calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it("gives up after maxAttempts of 5xx with a clear error message", async () => {
    const seq = sequenceFetch([500, 500, 500]);
    const sleeps: number[] = [];
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      fetchImpl: seq.fetchImpl,
      sleepMs: async (ms) => { sleeps.push(ms); },
      random: fixedRandom,
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    });
    await expect(deliverer.deliver(PAGE, CTX)).rejects.toThrow(/failed after 3 attempts/);
    expect(seq.calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry on a 401 (non-retryable auth)", async () => {
    const seq = sequenceFetch([401, 200]);
    const sleeps: number[] = [];
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      fetchImpl: seq.fetchImpl,
      sleepMs: async (ms) => { sleeps.push(ms); },
      random: fixedRandom,
      retry: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100 },
    });
    await expect(deliverer.deliver(PAGE, CTX)).rejects.toThrow(/HTTP 401.*non-retryable/);
    expect(seq.calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("does not retry on a 403 (non-retryable auth)", async () => {
    const seq = sequenceFetch([403]);
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      fetchImpl: seq.fetchImpl,
      sleepMs: noSleep,
      retry: { maxAttempts: 4 },
    });
    await expect(deliverer.deliver(PAGE, CTX)).rejects.toThrow(/HTTP 403.*non-retryable/);
    expect(seq.calls).toBe(1);
  });

  it("retries thrown network errors and succeeds when one resolves", async () => {
    let i = 0;
    const fetchImpl: FetchLike = async () => {
      i += 1;
      if (i < 3) throw new Error("ECONNRESET");
      return { ok: true, status: 200 };
    };
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      fetchImpl,
      sleepMs: noSleep,
      random: fixedRandom,
      retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 },
    });
    await deliverer.deliver(PAGE, CTX);
    expect(i).toBe(3);
  });

  it("maxAttempts=1 disables retry (throws on the first 500 with no sleep)", async () => {
    const seq = sequenceFetch([500]);
    const sleeps: number[] = [];
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      fetchImpl: seq.fetchImpl,
      sleepMs: async (ms) => { sleeps.push(ms); },
      retry: { maxAttempts: 1 },
    });
    await expect(deliverer.deliver(PAGE, CTX)).rejects.toThrow(/failed after 1 attempts/);
    expect(seq.calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("rejects an invalid retry config", () => {
    expect(
      () => new WebhookPageDeliverer({ url: "x", retry: { maxAttempts: 0 } }),
    ).toThrow(/maxAttempts/);
  });

  it("delivers every directive through the webhook via deliverPages", async () => {
    const f = fakeFetch(204);
    const deliverer = new WebhookPageDeliverer({ url: "https://hooks.example/incident", fetchImpl: f.fetchImpl });
    await deliverPages(deliverer, [PAGE, { ...PAGE, incidentId: "INC-2026-0002" }], CTX);
    expect(f.calls).toHaveLength(2);
  });
});

describe("computeWebhookBackoffMs", () => {
  it("doubles per attempt, capped at maxDelayMs, with jitter in [0.5,1.0]", () => {
    const config = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    const low = computeWebhookBackoffMs(1, config, () => 0);
    const high = computeWebhookBackoffMs(1, config, () => 0.9999);
    expect(low).toBe(50);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(100);
    const fourth = computeWebhookBackoffMs(4, config, () => 0.999);
    expect(fourth).toBeLessThanOrEqual(config.maxDelayMs);
  });

  it("default retry config: 4 attempts, 200ms base, 5s cap", () => {
    expect(DEFAULT_WEBHOOK_RETRY).toEqual({ maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 5000 });
  });
});
