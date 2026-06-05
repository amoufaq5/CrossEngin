import type { PageDirective } from "@crossengin/observability-runtime";
import { describe, expect, it } from "vitest";

import {
  LoggingPageDeliverer,
  WebhookPageDeliverer,
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

  it("POSTs the JSON payload to the configured url with the merged headers", async () => {
    const f = fakeFetch(200);
    const deliverer = new WebhookPageDeliverer({
      url: "https://hooks.example/incident",
      headers: { authorization: "Bearer t" },
      fetchImpl: f.fetchImpl,
      now: () => new Date("2026-06-05T12:00:00.000Z"),
    });
    await deliverer.deliver(PAGE, CTX);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://hooks.example/incident");
    expect(f.calls[0]?.headers).toMatchObject({ "content-type": "application/json", authorization: "Bearer t" });
    const body = JSON.parse(f.calls[0]?.body ?? "{}") as { incidentId: string; reason: string; deliveredAt: string };
    expect(body.incidentId).toBe("INC-2026-0001");
    expect(body.reason).toBe("escalated");
    expect(body.deliveredAt).toBe("2026-06-05T12:00:00.000Z");
  });

  it("throws on a non-2xx response so the caller's onError routes it", async () => {
    const f = fakeFetch(500);
    const deliverer = new WebhookPageDeliverer({ url: "https://hooks.example/incident", fetchImpl: f.fetchImpl });
    await expect(deliverer.deliver(PAGE, CTX)).rejects.toThrow(/HTTP 500/);
  });

  it("delivers every directive through the webhook via deliverPages", async () => {
    const f = fakeFetch(204);
    const deliverer = new WebhookPageDeliverer({ url: "https://hooks.example/incident", fetchImpl: f.fetchImpl });
    await deliverPages(deliverer, [PAGE, { ...PAGE, incidentId: "INC-2026-0002" }], CTX);
    expect(f.calls).toHaveLength(2);
  });
});
