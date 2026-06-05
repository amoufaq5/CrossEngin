import type { PageDirective } from "@crossengin/observability-runtime";
import { describe, expect, it } from "vitest";

import {
  LoggingPageDeliverer,
  deliverPages,
  formatPageLine,
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
