import type { AlertPolicy } from "@crossengin/observability";
import { describe, expect, it } from "vitest";

import type { AuditAnchorReport, AuditAnchorResult } from "./audit-anchor.js";
import type { ChainVerificationReport } from "./chain-verify.js";
import {
  INTEGRITY_ESCALATIONS,
  INTEGRITY_INCIDENT_OPERATION,
  INTEGRITY_RECOVERY_OPERATION,
  IntegrityEscalationConfigSchema,
  IntegrityEscalator,
  formatIntegrityEscalation,
  planIntegrityEscalation,
} from "./integrity-escalation.js";
import type { ChainTruncationCheck, IntegrityProofReport } from "./integrity-proof.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const AT = "2026-09-30T00:00:00.000Z";

const POLICY: AlertPolicy = {
  id: "ap_audit",
  routes: [
    { severity: "P0", channels: [{ kind: "pagerduty_phone", serviceKey: "svc" }] },
    { severity: "P2", channels: [{ kind: "slack", channel: "#audit" }] },
  ],
} as AlertPolicy;

const config = (over: Record<string, unknown> = {}) =>
  IntegrityEscalationConfigSchema.parse({ alertPolicy: POLICY, ...over });

const tamperedResult: AuditAnchorResult = {
  auditId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  verdict: "hash_mismatch",
  sequenceNumber: 2,
};

function report(over: Partial<IntegrityProofReport> = {}): IntegrityProofReport {
  const chain: ChainVerificationReport = {
    tenantId: TENANT_A,
    ok: true,
    mode: "full",
    checkpointSequence: null,
    integrity: { valid: true, brokenAt: null },
    signatures: { valid: true, checked: 3, entries: [] },
  } as ChainVerificationReport;
  const anchors: AuditAnchorReport = {
    tenantId: TENANT_A,
    ok: false,
    checked: 2,
    verified: 1,
    unanchored: 0,
    tampered: [tamperedResult],
    results: [],
  };
  const truncation: ChainTruncationCheck = {
    checkpointSequence: 3,
    tailSequence: 9,
    truncated: false,
  };
  return {
    scope: TENANT_A,
    verdict: "compromised",
    verifiedAt: AT,
    chain,
    anchors,
    truncation,
    ...over,
  };
}

/** Records what the emitter was asked to write, without a database. */
function fakeAudit() {
  const emitted: { operation: string; tenantId: string; after: unknown }[] = [];
  return {
    emitted,
    audit: {
      emit: async (entry: {
        operation: string;
        tenantId: string;
        after: unknown;
      }): Promise<void> => {
        emitted.push({ operation: entry.operation, tenantId: entry.tenantId, after: entry.after });
      },
    } as never,
  };
}

describe("IntegrityEscalationConfigSchema", () => {
  it("defaults to sev1 / security, because compromised cannot fire on benign state", () => {
    expect(config()).toMatchObject({
      severity: "sev1",
      category: "security",
      declaredBy: "operate-server",
    });
  });

  it("requires an alert policy — escalation with nowhere to page is not escalation", () => {
    expect(() => IntegrityEscalationConfigSchema.parse({})).toThrow();
  });

  it("allows the severity and category to be overridden", () => {
    expect(config({ severity: "sev3", category: "data_integrity" })).toMatchObject({
      severity: "sev3",
      category: "data_integrity",
    });
  });

  it("rejects an unknown key rather than ignoring a typo", () => {
    expect(() =>
      IntegrityEscalationConfigSchema.parse({ alertPolicy: POLICY, sevrity: "sev1" }),
    ).toThrow();
  });
});

describe("planIntegrityEscalation", () => {
  const plan = () =>
    planIntegrityEscalation(report(), {
      incidentId: "INC-2026-0001",
      severity: "sev1",
      category: "security",
      declaredBy: "operate-server",
      alertPolicy: POLICY,
    });

  it("declares a valid incident record", () => {
    const { incident } = plan();
    expect(incident.id).toBe("INC-2026-0001");
    expect(incident.status).toBe("declared");
    expect(incident.severity).toBe("sev1");
    expect(incident.category).toBe("security");
    expect(incident.declaredAt).toBe(AT);
  });

  it("names the scope in the title and surface", () => {
    const { incident } = plan();
    expect(incident.title).toContain(TENANT_A);
    expect(incident.timeline[0]?.metadata).toMatchObject({ surface: `audit-integrity/${TENANT_A}` });
  });

  it("carries the full report as the declaring timeline entry, tampered ids included", () => {
    const { incident } = plan();
    expect(incident.timeline[0]?.message).toContain("COMPROMISED");
    expect(incident.timeline[0]?.message).toContain(tamperedResult.auditId);
  });

  it("marks the incident auto-declared", () => {
    expect(plan().incident.timeline[0]?.metadata).toMatchObject({ autoDeclared: true });
  });

  it("attributes the tenant as affected", () => {
    expect(plan().incident.affectedTenantIds).toEqual([TENANT_A]);
  });

  it("names no affected tenant for the platform chain, which is not one", () => {
    const { incident } = planIntegrityEscalation(report({ scope: null, anchors: null }), {
      incidentId: "INC-2026-0002",
      severity: "sev1",
      category: "security",
      declaredBy: "operate-server",
      alertPolicy: POLICY,
    });
    expect(incident.affectedTenantIds).toEqual([]);
    expect(incident.title).toContain("platform");
  });

  it("routes the page by mapped severity", () => {
    expect(plan().page).toMatchObject({
      severity: "sev1",
      alertSeverity: "P0",
      incidentId: "INC-2026-0001",
    });
  });

  it("yields no page when the policy has no route for the severity", () => {
    const { page } = planIntegrityEscalation(report(), {
      incidentId: "INC-2026-0003",
      severity: "sev4",
      category: "security",
      declaredBy: "operate-server",
      alertPolicy: POLICY,
    });
    expect(page).toBeNull();
  });
});

describe("IntegrityEscalator — declaring once, not every pass", () => {
  it("declares, pages and audits the first compromised verdict", async () => {
    const { audit, emitted } = fakeAudit();
    const paged: string[] = [];
    const e = new IntegrityEscalator({
      config: config(),
      audit,
      page: (_p, incident) => {
        paged.push(incident.id);
      },
      now: () => new Date(AT),
    });
    const out = await e.observe(report());
    expect(out.kind).toBe("opened");
    expect(out.incidentId).toBe("INC-2026-0001");
    expect(out.audited).toBe(true);
    expect(paged).toEqual(["INC-2026-0001"]);
    expect(emitted[0]).toMatchObject({
      operation: INTEGRITY_INCIDENT_OPERATION,
      tenantId: TENANT_A,
    });
  });

  it("does NOT re-declare on the next pass — one tamper is one incident, not one an hour", async () => {
    const { audit, emitted } = fakeAudit();
    const paged: string[] = [];
    const e = new IntegrityEscalator({
      config: config(),
      audit,
      page: (_p, i) => {
        paged.push(i.id);
      },
      now: () => new Date(AT),
    });
    await e.observe(report());
    const second = await e.observe(report());
    const third = await e.observe(report());
    expect([second.kind, third.kind]).toEqual(["ongoing", "ongoing"]);
    expect(second.incidentId).toBe("INC-2026-0001");
    // Exactly one page and one audit row for the whole episode.
    expect(paged).toEqual(["INC-2026-0001"]);
    expect(emitted).toHaveLength(1);
  });

  it("closes out when the scope recovers, and audits the recovery", async () => {
    const { audit, emitted } = fakeAudit();
    const e = new IntegrityEscalator({ config: config(), audit, now: () => new Date(AT) });
    await e.observe(report());
    const rec = await e.observe(report({ verdict: "verified" }));
    expect(rec.kind).toBe("recovered");
    expect(rec.incidentId).toBe("INC-2026-0001");
    expect(emitted[1]?.operation).toBe(INTEGRITY_RECOVERY_OPERATION);
    expect(e.openIncidentFor(TENANT_A)).toBeNull();
  });

  it("can declare again after a recovery, with a fresh incident id", async () => {
    const e = new IntegrityEscalator({ config: config(), now: () => new Date(AT) });
    await e.observe(report());
    await e.observe(report({ verdict: "verified" }));
    const again = await e.observe(report());
    expect(again.kind).toBe("opened");
    expect(again.incidentId).toBe("INC-2026-0002");
  });

  it("reports no escalation for a healthy scope that never opened one", async () => {
    const { audit, emitted } = fakeAudit();
    const e = new IntegrityEscalator({ config: config(), audit });
    const out = await e.observe(report({ verdict: "verified" }));
    expect(out).toMatchObject({ kind: "none", incidentId: null, audited: false });
    expect(emitted).toEqual([]);
  });

  it("does not escalate `unproven` — absence of evidence is not a finding", async () => {
    const { audit, emitted } = fakeAudit();
    const paged: string[] = [];
    const e = new IntegrityEscalator({
      config: config(),
      audit,
      page: () => paged.push("x"),
    });
    expect((await e.observe(report({ verdict: "unproven" }))).kind).toBe("none");
    expect(paged).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("tracks scopes independently", async () => {
    const e = new IntegrityEscalator({ config: config(), now: () => new Date(AT) });
    const a = await e.observe(report({ scope: TENANT_A }));
    const b = await e.observe(report({ scope: TENANT_B }));
    expect([a.kind, b.kind]).toEqual(["opened", "opened"]);
    expect(a.incidentId).not.toBe(b.incidentId);
    expect(e.openIncidentFor(TENANT_A)).toBe("INC-2026-0001");
    expect(e.openIncidentFor(TENANT_B)).toBe("INC-2026-0002");
  });

  it("keeps the platform scope distinct from a tenant", async () => {
    const e = new IntegrityEscalator({ config: config(), now: () => new Date(AT) });
    await e.observe(report({ scope: null, anchors: null }));
    expect(e.openIncidentFor(null)).toBe("INC-2026-0001");
    expect(e.openIncidentFor(TENANT_A)).toBeNull();
  });
});

describe("IntegrityEscalator — failure handling", () => {
  it("pages even when the audit log cannot be written", async () => {
    // This is the whole point: the audit log being unwritable is a condition we escalate *for*,
    // so it must not swallow the page.
    const errors: unknown[] = [];
    const paged: string[] = [];
    const e = new IntegrityEscalator({
      config: config(),
      audit: {
        emit: async () => {
          throw new Error("audit_log unavailable");
        },
      } as never,
      page: (_p, i) => paged.push(i.id),
      onError: (err) => errors.push(err),
      now: () => new Date(AT),
    });
    const out = await e.observe(report());
    expect(out.kind).toBe("opened");
    expect(out.audited).toBe(false);
    expect(paged).toEqual(["INC-2026-0001"]);
    expect(errors).toHaveLength(1);
  });

  it("stays open when the pager fails, so the next pass does not re-declare", async () => {
    const errors: unknown[] = [];
    const e = new IntegrityEscalator({
      config: config(),
      page: () => {
        throw new Error("pager down");
      },
      onError: (err) => errors.push(err),
      now: () => new Date(AT),
    });
    expect((await e.observe(report())).kind).toBe("opened");
    expect(errors).toHaveLength(1);
    expect((await e.observe(report())).kind).toBe("ongoing");
  });

  it("never rejects, so one scope cannot fail the whole pass", async () => {
    const e = new IntegrityEscalator({
      config: config(),
      audit: {
        emit: async () => {
          throw new Error("boom");
        },
      } as never,
      page: () => {
        throw new Error("boom");
      },
    });
    await expect(e.observe(report())).resolves.toMatchObject({ kind: "opened" });
  });

  it("cannot audit a platform-scope escalation, and says so rather than dropping it", async () => {
    // `audit_log.tenant_id` is NOT NULL, so the platform chain has no tenant-scoped row to write.
    const { audit, emitted } = fakeAudit();
    const paged: string[] = [];
    const e = new IntegrityEscalator({
      config: config(),
      audit,
      page: () => paged.push("x"),
      now: () => new Date(AT),
    });
    const out = await e.observe(report({ scope: null, anchors: null }));
    expect(out.kind).toBe("opened");
    expect(out.audited).toBe(false);
    expect(emitted).toEqual([]);
    expect(paged).toEqual(["x"]);
  });
});

describe("formatIntegrityEscalation", () => {
  const e = () => new IntegrityEscalator({ config: config(), now: () => new Date(AT) });

  it("names the incident, severity and where it paged", async () => {
    const text = formatIntegrityEscalation(await e().observe(report()));
    expect(text).toContain("DECLARED INC-2026-0001");
    expect(text).toContain("severity=sev1");
    expect(text).toContain("pagerduty_phone");
  });

  it("says so when there is no route to page", async () => {
    const esc = new IntegrityEscalator({
      config: config({ severity: "sev4" }),
      now: () => new Date(AT),
    });
    expect(formatIntegrityEscalation(await esc.observe(report()))).toContain("no route");
  });

  it("reports an ongoing episode without repeating the declaration", async () => {
    const esc = e();
    await esc.observe(report());
    const text = formatIntegrityEscalation(await esc.observe(report()));
    expect(text).toContain("still compromised under INC-2026-0001");
  });

  it("reports a recovery", async () => {
    const esc = e();
    await esc.observe(report());
    const text = formatIntegrityEscalation(await esc.observe(report({ verdict: "verified" })));
    expect(text).toContain("recovered, closing INC-2026-0001");
  });

  it("reports no escalation plainly", async () => {
    expect(formatIntegrityEscalation(await e().observe(report({ verdict: "verified" })))).toContain(
      "no escalation",
    );
  });
});

describe("INTEGRITY_ESCALATIONS", () => {
  it("enumerates exactly the four outcomes", () => {
    expect([...INTEGRITY_ESCALATIONS]).toEqual(["opened", "ongoing", "recovered", "none"]);
  });
});
