import { describe, expect, it } from "vitest";
import type { SloEnforcementActionRecord } from "./records.js";
import {
  SloEnforcementReplayer,
  summarizeEnforcement,
  verifyEnforcementActionShape,
  verifyEnforcementHistory,
} from "./replayer.js";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";

const NOW = Date.parse("2026-06-02T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function action(
  overrides: Partial<SloEnforcementActionRecord> & {
    decision: SloEnforcementActionRecord["decision"];
    incidentId: string;
    actionId: string;
    occurredAt: string;
  },
): SloEnforcementActionRecord {
  return {
    tenantId: null,
    sloId: "orders-availability",
    surface: "POST /v1/orders",
    signal: "availability",
    severity: overrides.decision === "breach_opened" ? "sev2" : null,
    killSwitchId: null,
    flagId: null,
    paged: false,
    pageChannelCount: 0,
    thresholdId: null,
    ...overrides,
  };
}

describe("verifyEnforcementActionShape", () => {
  it("flags a paged action with no channels", () => {
    const issues = verifyEnforcementActionShape(
      action({
        actionId: "sloa_a0000001",
        incidentId: "INC-2026-0001",
        decision: "breach_opened",
        occurredAt: iso(0),
        paged: true,
        pageChannelCount: 0,
      }),
    );
    expect(issues.map((i) => i.kind)).toContain("paged_without_channels");
  });

  it("flags a breach_opened missing severity", () => {
    const issues = verifyEnforcementActionShape(
      action({
        actionId: "sloa_a0000002",
        incidentId: "INC-2026-0002",
        decision: "breach_opened",
        occurredAt: iso(0),
        severity: null,
      }),
    );
    expect(issues.map((i) => i.kind)).toContain("breach_opened_missing_severity");
  });

  it("flags a kill switch recorded without its flag", () => {
    const issues = verifyEnforcementActionShape(
      action({
        actionId: "sloa_a0000003",
        incidentId: "INC-2026-0003",
        decision: "breach_opened",
        occurredAt: iso(0),
        killSwitchId: "fks_auto00000001",
        flagId: null,
      }),
    );
    expect(issues.map((i) => i.kind)).toContain("kill_switch_without_flag");
  });

  it("accepts a clean action", () => {
    expect(
      verifyEnforcementActionShape(
        action({
          actionId: "sloa_a0000004",
          incidentId: "INC-2026-0004",
          decision: "recovered",
          occurredAt: iso(0),
        }),
      ),
    ).toHaveLength(0);
  });
});

describe("verifyEnforcementHistory", () => {
  it("accepts a well-ordered open -> ongoing -> recovered lifecycle", () => {
    const issues = verifyEnforcementHistory([
      action({ actionId: "sloa_b0000001", incidentId: "INC-2026-0001", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
      action({ actionId: "sloa_b0000002", incidentId: "INC-2026-0001", decision: "breach_ongoing", occurredAt: iso(1_000) }),
      action({ actionId: "sloa_b0000003", incidentId: "INC-2026-0001", decision: "recovered", occurredAt: iso(2_000) }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("flags an ongoing with no prior open", () => {
    const issues = verifyEnforcementHistory([
      action({ actionId: "sloa_b0000004", incidentId: "INC-2026-0002", decision: "breach_ongoing", occurredAt: iso(0) }),
    ]);
    expect(issues.map((i) => i.kind)).toContain("ongoing_without_open");
  });

  it("flags a recovered with no prior open", () => {
    const issues = verifyEnforcementHistory([
      action({ actionId: "sloa_b0000005", incidentId: "INC-2026-0003", decision: "recovered", occurredAt: iso(0) }),
    ]);
    expect(issues.map((i) => i.kind)).toContain("recovered_without_open");
  });

  it("flags a duplicate open for the same incident", () => {
    const issues = verifyEnforcementHistory([
      action({ actionId: "sloa_b0000006", incidentId: "INC-2026-0004", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
      action({ actionId: "sloa_b0000007", incidentId: "INC-2026-0004", decision: "breach_opened", occurredAt: iso(1_000), paged: true, pageChannelCount: 1 }),
    ]);
    expect(issues.map((i) => i.kind)).toContain("duplicate_open");
  });

  it("allows reopening an incident after it recovered", () => {
    const issues = verifyEnforcementHistory([
      action({ actionId: "sloa_b0000008", incidentId: "INC-2026-0005", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
      action({ actionId: "sloa_b0000009", incidentId: "INC-2026-0005", decision: "recovered", occurredAt: iso(1_000) }),
      action({ actionId: "sloa_b0000010", incidentId: "INC-2026-0005", decision: "breach_opened", occurredAt: iso(2_000), paged: true, pageChannelCount: 1 }),
    ]);
    expect(issues).toHaveLength(0);
  });
});

describe("summarizeEnforcement", () => {
  it("counts decisions and the paged ratio", () => {
    const summary = summarizeEnforcement([
      action({ actionId: "sloa_c0000001", incidentId: "INC-2026-0001", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 2 }),
      action({ actionId: "sloa_c0000002", incidentId: "INC-2026-0001", decision: "breach_ongoing", occurredAt: iso(1_000) }),
      action({ actionId: "sloa_c0000003", incidentId: "INC-2026-0001", decision: "recovered", occurredAt: iso(2_000) }),
    ]);
    expect(summary).toMatchObject({ total: 3, opened: 1, ongoing: 1, recovered: 1, paged: 1 });
    expect(summary.pagedRatio).toBeCloseTo(1 / 3);
  });

  it("is empty-safe", () => {
    expect(summarizeEnforcement([]).pagedRatio).toBe(0);
  });
});

describe("SloEnforcementReplayer", () => {
  it("verifies an incident's actions via the store", async () => {
    const rows = [
      action({ actionId: "sloa_d0000001", incidentId: "INC-2026-0001", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
      action({ actionId: "sloa_d0000002", incidentId: "INC-2026-0001", decision: "recovered", occurredAt: iso(1_000) }),
    ];
    const store = {
      listForIncident: async () => rows,
      listRecent: async () => rows,
    } as unknown as PostgresSloEnforcementActionStore;
    const replayer = new SloEnforcementReplayer(store);
    expect(await replayer.verifyIncident("INC-2026-0001")).toHaveLength(0);
    expect((await replayer.summarizeRecent()).opened).toBe(1);
  });
});
