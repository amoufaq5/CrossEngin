import type { UnreadableRow } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";
import type { SloEnforcementActionRecord } from "./records.js";
import {
  SLO_DRIFT_ISSUE_KINDS,
  SloEnforcementReplayer,
  summarizeEnforcement,
  unreadableRowIssues,
  verifyEnforcementActionShape,
  verifyEnforcementHistory,
} from "./replayer.js";
import {
  PostgresSloEnforcementActionStore,
  type SloEnforcementActionRead,
} from "./enforcement-action-store.js";

const NOW = Date.parse("2026-06-02T12:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

/** A clean read: every row represented, nothing withheld. */
function read(
  records: readonly SloEnforcementActionRecord[],
  unreadable: readonly UnreadableRow[] = [],
): SloEnforcementActionRead {
  return { records, unreadable };
}

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
    // A recovery always carries one; every other decision carries none.
    closeOut: overrides.decision === "recovered" ? "cancelled" : null,
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

  it("flags a recovery whose close-out failed", () => {
    const issues = verifyEnforcementActionShape(
      action({
        actionId: "sloa_a0000005",
        incidentId: "INC-2026-0005",
        decision: "recovered",
        occurredAt: iso(0),
        closeOut: "failed",
      }),
    );
    expect(issues.map((i) => i.kind)).toContain("recovered_close_out_failed");
    expect(issues[0]?.incidentId).toBe("INC-2026-0005");
  });

  it("does not flag a cancelled close-out", () => {
    expect(
      verifyEnforcementActionShape(
        action({
          actionId: "sloa_a0000006",
          incidentId: "INC-2026-0006",
          decision: "recovered",
          occurredAt: iso(0),
          closeOut: "cancelled",
        }),
      ),
    ).toHaveLength(0);
  });

  it("does not flag a human_owned or unpersisted close-out", () => {
    // Neither leaves an unattended open row: one has responders, the other was never stored.
    for (const closeOut of ["human_owned", "unpersisted"] as const) {
      expect(
        verifyEnforcementActionShape(
          action({
            actionId: "sloa_a0000007",
            incidentId: "INC-2026-0007",
            decision: "recovered",
            occurredAt: iso(0),
            closeOut,
          }),
        ),
      ).toHaveLength(0);
    }
  });

  it("names the drift kind in the exported catalog", () => {
    expect([...SLO_DRIFT_ISSUE_KINDS]).toContain("recovered_close_out_failed");
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

  it("surfaces a failed close-out inside a well-ordered lifecycle", () => {
    // The whole point of the column: without it this history is indistinguishable from a clean one.
    const issues = verifyEnforcementHistory([
      action({ actionId: "sloa_b0000011", incidentId: "INC-2026-0006", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
      action({ actionId: "sloa_b0000012", incidentId: "INC-2026-0006", decision: "recovered", occurredAt: iso(1_000), closeOut: "failed" }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("recovered_close_out_failed");
    expect(issues[0]?.actionId).toBe("sloa_b0000012");
  });

  it("reports both a failed close-out and a missing open", () => {
    const issues = verifyEnforcementHistory([
      action({ actionId: "sloa_b0000013", incidentId: "INC-2026-0007", decision: "recovered", occurredAt: iso(0), closeOut: "failed" }),
    ]);
    expect(issues.map((i) => i.kind).sort()).toEqual([
      "recovered_close_out_failed",
      "recovered_without_open",
    ]);
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

/**
 * The window that `listRecent`'s `LIMIT` cuts, and which half of the check survives it.
 *
 * An episode that began before the page starts mid-flight in the page, so every `breach_ongoing`
 * and `recovered` in it has "no prior open" — a statement about the page and not about the table,
 * fired on the healthiest thing a deployment can have: a long breach the loop re-asserts each tick.
 */
describe("verifyEnforcementHistory over a window", () => {
  const MID_EPISODE = [
    action({ actionId: "sloa_e0000001", incidentId: "INC-2026-0010", decision: "breach_ongoing", occurredAt: iso(0) }),
    action({ actionId: "sloa_e0000002", incidentId: "INC-2026-0010", decision: "breach_ongoing", occurredAt: iso(1_000) }),
    action({ actionId: "sloa_e0000003", incidentId: "INC-2026-0010", decision: "recovered", occurredAt: iso(2_000) }),
  ];

  it("reports a missing open when the set is the whole history", () => {
    const kinds = verifyEnforcementHistory(MID_EPISODE, { historyIsComplete: true }).map((i) => i.kind);
    expect(kinds).toContain("ongoing_without_open");
    expect(kinds).toContain("recovered_without_open");
  });

  it("reports nothing when the same set is declared a window", () => {
    expect(verifyEnforcementHistory(MID_EPISODE, { historyIsComplete: false })).toEqual([]);
  });

  it("defaults to complete, which is what a direct caller handing a full history means", () => {
    expect(verifyEnforcementHistory(MID_EPISODE).map((i) => i.kind)).toContain(
      "ongoing_without_open",
    );
  });

  it("still reports a duplicate open inside a window, because presence is conclusive", () => {
    // ADR-0322's asymmetry: seeing both opens is the whole evidence, so no `LIMIT` can explain it
    // away — while an absence is only ever an inference.
    const issues = verifyEnforcementHistory(
      [
        action({ actionId: "sloa_e0000004", incidentId: "INC-2026-0011", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
        action({ actionId: "sloa_e0000005", incidentId: "INC-2026-0011", decision: "breach_opened", occurredAt: iso(1_000), paged: true, pageChannelCount: 1 }),
      ],
      { historyIsComplete: false },
    );
    expect(issues.map((i) => i.kind)).toEqual(["duplicate_open"]);
  });

  it("still reports every per-row finding inside a window", () => {
    // The intra-row checks never depended on the set, so a window must not weaken them.
    const issues = verifyEnforcementHistory(
      [
        action({ actionId: "sloa_e0000006", incidentId: "INC-2026-0012", decision: "recovered", occurredAt: iso(0), closeOut: "failed" }),
      ],
      { historyIsComplete: false },
    );
    expect(issues.map((i) => i.kind)).toEqual(["recovered_close_out_failed"]);
  });

  it("still reports a missing open that the window cannot excuse", () => {
    // `recovered` *after* its own `recovered` in the same page: the open is accounted for inside the
    // window, so the second absence is real and survives the gate... which it does not, by design.
    // Recorded as the cost: inside a window the two kinds are off, not merely relaxed.
    const issues = verifyEnforcementHistory(
      [
        action({ actionId: "sloa_e0000007", incidentId: "INC-2026-0013", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
        action({ actionId: "sloa_e0000008", incidentId: "INC-2026-0013", decision: "recovered", occurredAt: iso(1_000) }),
        action({ actionId: "sloa_e0000009", incidentId: "INC-2026-0013", decision: "recovered", occurredAt: iso(2_000) }),
      ],
      { historyIsComplete: false },
    );
    expect(issues).toEqual([]);
    expect(
      verifyEnforcementHistory(
        [
          action({ actionId: "sloa_e0000007", incidentId: "INC-2026-0013", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
          action({ actionId: "sloa_e0000008", incidentId: "INC-2026-0013", decision: "recovered", occurredAt: iso(1_000) }),
          action({ actionId: "sloa_e0000009", incidentId: "INC-2026-0013", decision: "recovered", occurredAt: iso(2_000) }),
        ],
        { historyIsComplete: true },
      ).map((i) => i.kind),
    ).toEqual(["recovered_without_open"]);
  });
});

describe("SloEnforcementReplayer declares which of its reads is a window", () => {
  const MID_EPISODE = [
    action({ actionId: "sloa_f0000001", incidentId: "INC-2026-0014", decision: "breach_ongoing", occurredAt: iso(0) }),
  ];

  function store(): PostgresSloEnforcementActionStore {
    return {
      listForIncident: async () => read(MID_EPISODE),
      listRecent: async () => read(MID_EPISODE),
    } as unknown as PostgresSloEnforcementActionStore;
  }

  it("verifyRecent does not report an open that fell off its own page", async () => {
    expect(await new SloEnforcementReplayer(store()).verifyRecent()).toEqual([]);
  });

  it("verifyIncident does, because listForIncident is unbounded within its scope", async () => {
    const issues = await new SloEnforcementReplayer(store()).verifyIncident("INC-2026-0014");
    expect(issues.map((i) => i.kind)).toEqual(["ongoing_without_open"]);
  });
});

describe("summarizeEnforcement", () => {
  it("counts decisions and the paged ratio", () => {
    const summary = summarizeEnforcement([
      action({ actionId: "sloa_c0000001", incidentId: "INC-2026-0001", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 2 }),
      action({ actionId: "sloa_c0000002", incidentId: "INC-2026-0001", decision: "breach_ongoing", occurredAt: iso(1_000) }),
      action({ actionId: "sloa_c0000003", incidentId: "INC-2026-0001", decision: "recovered", occurredAt: iso(2_000) }),
    ], 0);
    expect(summary).toMatchObject({
      total: 3,
      opened: 1,
      ongoing: 1,
      recovered: 1,
      paged: 1,
      unreadable: 0,
    });
    expect(summary.pagedRatio).toBeCloseTo(1 / 3);
  });

  it("is empty-safe", () => {
    expect(summarizeEnforcement([], 0).pagedRatio).toBe(0);
  });

  it("carries the withheld count beside the ratio it is not in", () => {
    // `pagedRatio` is a ratio over the rows that could be read, which is a different quantity from
    // a ratio over the rows on disk. Reporting the second as the first is how a page that paged
    // comes back as 0 — so the figure is published next to the count that qualifies it.
    const summary = summarizeEnforcement(
      [action({ actionId: "sloa_c0000004", incidentId: "INC-2026-0001", decision: "breach_ongoing", occurredAt: iso(0) })],
      2,
    );
    expect(summary).toMatchObject({ total: 1, unreadable: 2 });
    expect(summary.pagedRatio).toBe(0);
  });
});

describe("SloEnforcementReplayer", () => {
  it("verifies an incident's actions via the store", async () => {
    const rows = [
      action({ actionId: "sloa_d0000001", incidentId: "INC-2026-0001", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
      action({ actionId: "sloa_d0000002", incidentId: "INC-2026-0001", decision: "recovered", occurredAt: iso(1_000) }),
    ];
    const store = {
      listForIncident: async () => read(rows),
      listRecent: async () => read(rows),
    } as unknown as PostgresSloEnforcementActionStore;
    const replayer = new SloEnforcementReplayer(store);
    expect(await replayer.verifyIncident("INC-2026-0001")).toHaveLength(0);
    expect((await replayer.summarizeRecent()).opened).toBe(1);
  });

  it("reports a failed close-out through verifyRecent", async () => {
    const rows = [
      action({ actionId: "sloa_d0000003", incidentId: "INC-2026-0002", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
      action({ actionId: "sloa_d0000004", incidentId: "INC-2026-0002", decision: "recovered", occurredAt: iso(1_000), closeOut: "failed" }),
    ];
    const store = {
      listForIncident: async () => read(rows),
      listRecent: async () => read(rows),
    } as unknown as PostgresSloEnforcementActionStore;
    const replayer = new SloEnforcementReplayer(store);
    const issues = await replayer.verifyRecent();
    expect(issues.map((i) => i.kind)).toEqual(["recovered_close_out_failed"]);
  });
});

describe("SloEnforcementReplayer reports an unreadable row rather than losing the pass", () => {
  const WITHHELD: UnreadableRow = {
    identity: "sloa_g0000001",
    detail: "closeOut: custom",
  };

  function store(
    records: readonly SloEnforcementActionRecord[],
    unreadable: readonly UnreadableRow[],
  ): PostgresSloEnforcementActionStore {
    return {
      listForIncident: async () => read(records, unreadable),
      listRecent: async () => read(records, unreadable),
    } as unknown as PostgresSloEnforcementActionStore;
  }

  const HEALTHY = [
    action({ actionId: "sloa_g0000002", incidentId: "INC-2026-0020", decision: "recovered", occurredAt: iso(1_000), closeOut: "failed" }),
  ];

  it("keeps every other row's findings, which a thrown read took with it", async () => {
    const issues = await new SloEnforcementReplayer(store(HEALTHY, [WITHHELD])).verifyRecent();
    expect(issues.map((i) => i.kind)).toEqual([
      "unreadable_action_row",
      "recovered_close_out_failed",
    ]);
  });

  it("names the refused row by its business key", async () => {
    const issues = await new SloEnforcementReplayer(store([], [WITHHELD])).verifyRecent();
    expect(issues[0]?.actionId).toBe("sloa_g0000001");
  });

  it("admits it cannot name the row when the identifying column is what is wrong", async () => {
    const issues = await new SloEnforcementReplayer(
      store([], [{ identity: null, detail: "actionId: invalid_string" }]),
    ).verifyRecent();
    expect(issues[0]?.actionId).toBe("<unknown>");
  });

  it("discloses no value from the refused row", async () => {
    // The whole finding, rendered. `detail` names the field and the issue code and nothing the row
    // held: an operator scoping a manual fix by a value that may be the reason the row was refused
    // is the hazard, and `incident_id` is withheld for that reason even though a reader would want
    // it. Asserted over the *rendered* finding so a field added later cannot smuggle one in.
    const issues = await new SloEnforcementReplayer(
      store([], [{ identity: "sloa_g0000003", detail: "severity: invalid_enum_value" }]),
    ).verifyRecent();
    const rendered = JSON.stringify(issues);
    expect(rendered).not.toContain("sev9");
    expect(rendered).not.toContain("INC-2026-0099");
    expect(issues[0]?.incidentId).toBe("<unknown>");
  });

  it("verifyIncident names the incident the caller asked about, not one read off the row", async () => {
    const issues = await new SloEnforcementReplayer(store([], [WITHHELD])).verifyIncident(
      "INC-2026-0020",
    );
    expect(issues[0]?.incidentId).toBe("INC-2026-0020");
  });

  it("stops verifyIncident claiming a complete history once a row is withheld", async () => {
    // `listForIncident` is unbounded, so an absence normally means something — and a refused row is
    // an absence this pass caused. The missing `breach_opened` may be precisely the row the contract
    // rejected, so `ongoing_without_open` would be a finding manufactured out of the detector's own
    // blind spot.
    const midEpisode = [
      action({ actionId: "sloa_g0000004", incidentId: "INC-2026-0021", decision: "breach_ongoing", occurredAt: iso(0) }),
    ];
    expect(
      (await new SloEnforcementReplayer(store(midEpisode, [])).verifyIncident("INC-2026-0021")).map(
        (i) => i.kind,
      ),
    ).toEqual(["ongoing_without_open"]);
    expect(
      (
        await new SloEnforcementReplayer(store(midEpisode, [WITHHELD])).verifyIncident(
          "INC-2026-0021",
        )
      ).map((i) => i.kind),
    ).toEqual(["unreadable_action_row"]);
  });

  it("still reports a duplicate open beside a withheld row, because presence is conclusive", () => {
    // The other half of the same rule (ADR-0322): a withheld row cannot explain away two rows that
    // are both in hand, so gating this one too would have been the fail-open direction.
    const issues = unreadableRowIssues([WITHHELD]);
    expect(issues).toHaveLength(1);
    expect(
      verifyEnforcementHistory(
        [
          action({ actionId: "sloa_g0000005", incidentId: "INC-2026-0022", decision: "breach_opened", occurredAt: iso(0), paged: true, pageChannelCount: 1 }),
          action({ actionId: "sloa_g0000006", incidentId: "INC-2026-0022", decision: "breach_opened", occurredAt: iso(1_000), paged: true, pageChannelCount: 1 }),
        ],
        { historyIsComplete: false },
      ).map((i) => i.kind),
    ).toEqual(["duplicate_open"]);
  });

  it("counts the withheld rows in summarizeRecent", async () => {
    const summary = await new SloEnforcementReplayer(store(HEALTHY, [WITHHELD])).summarizeRecent();
    expect(summary).toMatchObject({ total: 1, unreadable: 1 });
  });
});

describe("SloEnforcementReplayer passes the scope down to the store", () => {
  /** A stub that remembers which scope it was asked for. */
  function recordingStore(asked: (string | null | undefined)[]): PostgresSloEnforcementActionStore {
    return {
      listForIncident: async (_id: string, tenantId?: string | null) => {
        asked.push(tenantId);
        return read([]);
      },
      listRecent: async (_limit?: number, tenantId?: string | null) => {
        asked.push(tenantId);
        return read([]);
      },
    } as unknown as PostgresSloEnforcementActionStore;
  }

  it("defaults to the platform scope rather than to whatever RLS happens to allow", async () => {
    const asked: (string | null | undefined)[] = [];
    const replayer = new SloEnforcementReplayer(recordingStore(asked));
    await replayer.verifyIncident("INC-2026-0001");
    await replayer.verifyRecent();
    await replayer.summarizeRecent();
    expect(asked).toEqual([null, null, null]);
  });

  it("forwards a named tenant, so a drift verdict is a judgement over one scope's set", async () => {
    const asked: (string | null | undefined)[] = [];
    const tenant = "00000000-0000-4000-8000-000000000001";
    const replayer = new SloEnforcementReplayer(recordingStore(asked));
    await replayer.verifyIncident("INC-2026-0001", tenant);
    await replayer.verifyRecent(50, tenant);
    await replayer.summarizeRecent(50, tenant);
    expect(asked).toEqual([tenant, tenant, tenant]);
  });
});
