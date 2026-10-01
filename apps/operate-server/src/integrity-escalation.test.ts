import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";
import type {
  IncidentCloseOut,
  IncidentCloseOutInput,
  IncidentDeclarationRequest,
  IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import type { AlertPolicy } from "@crossengin/observability";
import { describe, expect, it } from "vitest";

import type { AuditAnchorReport, AuditAnchorResult } from "./audit-anchor.js";
import type { ChainVerificationReport } from "./chain-verify.js";
import {
  INCIDENT_DISPOSITIONS,
  INTEGRITY_ESCALATIONS,
  INTEGRITY_INCIDENT_OPERATION,
  INTEGRITY_RECOVERY_OPERATION,
  IntegrityEscalationConfigSchema,
  IntegrityEscalator,
  dispositionFromCloseOut,
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

/**
 * A fake `IncidentDeclarer` — the seam the escalator now declares through. Ids are allocated from
 * what has already been "stored", which is the property that matters: it continues rather than
 * restarts.
 *
 * Written out by hand on purpose. Test files are not typechecked in this repo, so a double that
 * stops satisfying `IncidentDeclarer` fails at runtime inside a `catch` that exists by design —
 * which is why every test below asserts on a recorded *call* (`declared`, `lookups`, `closedOut`)
 * rather than on nothing having thrown.
 */
function fakeDeclarer(
  opts: {
    readonly failDeclare?: boolean;
    readonly triaged?: boolean;
    readonly failFindOpen?: boolean;
    readonly failCloseOut?: boolean;
    /** Rows a restart would still find, keyed by `autoDeclaredFor`. */
    readonly open?: ReadonlyMap<string, IncidentRecord>;
  } = {},
) {
  const declared: IncidentRecord[] = [];
  const cancelled: string[] = [];
  const lookups: string[] = [];
  const closedOut: { readonly incidentId: string; readonly reason: string }[] = [];
  /** Every `declare` the primary was *asked* for, including the ones it refused. */
  const attempts: IncidentDeclarationRequest[] = [];
  let seq = 0;
  const declarer: IncidentDeclarer = {
    findOpen: async (autoDeclaredFor: string): Promise<IncidentRecord | null> => {
      lookups.push(autoDeclaredFor);
      if (opts.failFindOpen === true) throw new Error("store unavailable");
      return opts.open?.get(autoDeclaredFor) ?? null;
    },
    declare: async (request: IncidentDeclarationRequest): Promise<IncidentRecord> => {
      attempts.push(request);
      if (opts.failDeclare === true) throw new Error("store unavailable");
      seq += 1;
      const at = request.declaredAt ?? AT;
      const record = IncidentRecordSchema.parse({
        id: `INC-2026-${String(seq).padStart(4, "0")}`,
        title: request.title,
        severity: request.severity,
        category: request.category,
        status: "declared",
        declaredAt: at,
        declaredBy: request.declaredBy,
        autoDeclaredFor: request.autoDeclaredFor ?? null,
        affectedTenantIds: [...(request.affectedTenantIds ?? [])],
        timeline: [
          {
            occurredAt: at,
            actorUserId: request.declaredBy,
            kind: "declared",
            message: request.detail,
            metadata: request.metadata ?? {},
          },
        ],
      });
      declared.push(record);
      return record;
    },
    closeOut: async (
      incidentId: string,
      input: IncidentCloseOutInput,
    ): Promise<IncidentCloseOut> => {
      closedOut.push({ incidentId, reason: input.reason });
      if (opts.failCloseOut === true) throw new Error("store unavailable");
      if (opts.triaged === true) return "human_owned";
      cancelled.push(incidentId);
      return "cancelled";
    },
  };
  return { declared, cancelled, lookups, closedOut, attempts, declarer };
}

describe("IntegrityEscalator — persisting the incident record", () => {
  it("declares through the declarer and reports it persisted", async () => {
    const { declared, declarer } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer });
    const escalation = await esc.observe(report());
    expect(escalation.kind).toBe("opened");
    expect(escalation.disposition).toBe("declared");
    expect(declared).toHaveLength(1);
    expect(declared[0]?.id).toBe("INC-2026-0001");
  });

  it("takes the incident id from the declarer, not the in-process counter", async () => {
    // The store has already issued ids; a restart must continue the sequence rather than reuse
    // INC-2026-0001, which the counter would have produced.
    const { declarer, declared } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    await esc.observe(report({ scope: TENANT_B, verdict: "compromised" }));
    expect(declared.map((d) => d.id)).toEqual(["INC-2026-0001", "INC-2026-0002"]);
    expect(esc.openIncidentFor(TENANT_B)).toBe("INC-2026-0002");
  });

  it("declares at the proof's verification time", async () => {
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report());
    expect(declared[0]?.declaredAt).toBe(AT);
  });

  it("declares with the configured severity and category", async () => {
    // The request carries both now, rather than the fake hardcoding them: a mis-wired category
    // would otherwise be invisible.
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({
      config: config({ severity: "sev2", category: "data_integrity" }),
      declarer,
    }).observe(report());
    expect(declared[0]).toMatchObject({ severity: "sev2", category: "data_integrity" });
  });

  it("names the tenant scope as an affected tenant", async () => {
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report());
    expect(declared[0]?.affectedTenantIds).toEqual([TENANT_A]);
  });

  it("names no affected tenant for the platform chain", async () => {
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report({ scope: null }));
    expect(declared[0]?.affectedTenantIds).toEqual([]);
    expect(declared[0]?.title).toContain("platform");
  });

  it("records the surface in the declaration entry's metadata", async () => {
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report());
    expect(declared[0]?.timeline[0]?.metadata).toMatchObject({
      surface: `audit-integrity/${TENANT_A}`,
      autoDeclared: true,
    });
  });

  it("carries the full report as the declaring timeline entry", async () => {
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report());
    expect(declared[0]?.timeline[0]?.message).toContain("COMPROMISED");
    expect(declared[0]?.timeline[0]?.message).toContain(tamperedResult.auditId);
  });

  it("still pages with the declarer's id", async () => {
    const { declarer } = fakeDeclarer();
    const escalation = await new IntegrityEscalator({ config: config(), declarer }).observe(
      report(),
    );
    expect(escalation.page?.incidentId).toBe("INC-2026-0001");
  });

  it("declares only once across repeated compromised passes", async () => {
    const { declared, declarer } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    await esc.observe(report());
    await esc.observe(report());
    expect(declared).toHaveLength(1);
  });

  it("reports an ongoing episode as still declared", async () => {
    const { declarer } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    expect((await esc.observe(report())).disposition).toBe("declared");
  });

  it("cancels the incident when the trail recovers before anyone took it", async () => {
    const { cancelled, closedOut, declarer } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    const recovered = await esc.observe(report({ verdict: "verified" }));
    expect(recovered.kind).toBe("recovered");
    expect(recovered.disposition).toBe("cancelled");
    expect(cancelled).toEqual(["INC-2026-0001"]);
    // The close-out really went through the seam, with the escalation's own reason.
    expect(closedOut).toEqual([
      {
        incidentId: "INC-2026-0001",
        reason: "audit-integrity proof no longer finds the trail altered",
      },
    ]);
  });

  it("leaves a triaged incident to its responders", async () => {
    // Cancelling an incident a human has taken would erase their ownership of it.
    const { cancelled, closedOut, declarer } = fakeDeclarer({ triaged: true });
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    const recovered = await esc.observe(report({ verdict: "verified" }));
    expect(recovered.disposition).toBe("human_owned");
    expect(cancelled).toEqual([]);
    expect(closedOut).toHaveLength(1);
  });

  it("reports a refused close-out as still declared, because the row is still open", async () => {
    // `IncidentCloseOut.failed` has no disposition of its own: the recovery did not land, so the
    // incident remains declared and a human will find it in `listOpen`.
    const errors: unknown[] = [];
    const { closedOut, declarer } = fakeDeclarer({ failCloseOut: true });
    const esc = new IntegrityEscalator({
      config: config(),
      declarer,
      onError: (err) => errors.push(err),
    });
    await esc.observe(report());
    const recovered = await esc.observe(report({ verdict: "verified" }));
    expect(recovered.kind).toBe("recovered");
    expect(recovered.disposition).toBe("declared");
    expect(closedOut).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("pages anyway when the declarer cannot be reached", async () => {
    // Losing the alert is the worse failure, exactly as for an unwritable audit log.
    const errors: unknown[] = [];
    const { declarer } = fakeDeclarer({ failDeclare: true });
    const escalation = await new IntegrityEscalator({
      config: config(),
      declarer,
      onError: (err) => errors.push(err),
      now: () => new Date(AT),
    }).observe(report());
    expect(escalation.kind).toBe("opened");
    expect(escalation.disposition).toBe("unpersisted");
    expect(escalation.page?.channels).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("falls back to an unpersisted record when the declarer fails", async () => {
    const { declared, declarer } = fakeDeclarer({ failDeclare: true });
    const escalation = await new IntegrityEscalator({
      config: config(),
      declarer,
      onError: () => undefined,
      now: () => new Date(AT),
    }).observe(report());
    expect(escalation.incidentId).toBe("INC-2026-0001");
    // Nothing reached the store, which is what `unpersisted` claims.
    expect(declared).toHaveLength(0);
    expect(escalation.incident?.autoDeclaredFor).toBe(`audit-integrity:${TENANT_A}`);
  });

  it("declares under a namespaced audit-integrity key", async () => {
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report());
    expect(declared[0]?.autoDeclaredFor).toBe(`audit-integrity:${TENANT_A}`);
  });

  it("keys the platform chain by scope, not by an empty string", async () => {
    const { declared, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report({ scope: null }));
    expect(declared[0]?.autoDeclaredFor).toBe("audit-integrity:platform");
  });

  it("asks the declarer what is open before declaring", async () => {
    const { lookups, declarer } = fakeDeclarer();
    await new IntegrityEscalator({ config: config(), declarer }).observe(report());
    expect(lookups).toEqual([`audit-integrity:${TENANT_A}`]);
  });

  it("adopts the open incident after a restart instead of declaring a second", async () => {
    // A tamper stays tampered, and the escalator's open map does not survive the process. Without
    // adoption, every restart turns one episode into another incident.
    const first = fakeDeclarer();
    const beforeRestart = new IntegrityEscalator({ config: config(), declarer: first.declarer });
    const opened = await beforeRestart.observe(report());
    const existing = first.declared[0];
    if (existing === undefined) throw new Error("expected a declared incident");

    const after = fakeDeclarer({
      open: new Map([[`audit-integrity:${TENANT_A}`, existing]]),
    });
    const restarted = new IntegrityEscalator({ config: config(), declarer: after.declarer });
    const escalation = await restarted.observe(report());
    expect(escalation.kind).toBe("ongoing");
    expect(escalation.incidentId).toBe(opened.incidentId);
    expect(after.lookups).toEqual([`audit-integrity:${TENANT_A}`]);
    expect(after.declared).toHaveLength(0);
    expect(restarted.openIncidentFor(TENANT_A)).toBe(opened.incidentId);
  });

  it("does not page again for an adopted incident", async () => {
    // The page went out when it was declared; paging on every restart would train people to ignore
    // it, which is the same reason an ongoing episode is silent.
    const existing = IncidentRecordSchema.parse({
      id: "INC-2026-0007",
      title: `Audit integrity compromised for ${TENANT_A}`,
      severity: "sev1",
      category: "security",
      status: "declared",
      declaredAt: AT,
      declaredBy: "operate-server",
      autoDeclaredFor: `audit-integrity:${TENANT_A}`,
      timeline: [{ occurredAt: AT, actorUserId: "operate-server", kind: "declared", message: "x" }],
    });
    const paged: string[] = [];
    const { declared, lookups, declarer } = fakeDeclarer({
      open: new Map([[`audit-integrity:${TENANT_A}`, existing]]),
    });
    const escalation = await new IntegrityEscalator({
      config: config(),
      declarer,
      page: (p) => paged.push(p.incidentId),
    }).observe(report());
    expect(escalation.kind).toBe("ongoing");
    expect(escalation.incidentId).toBe("INC-2026-0007");
    expect(lookups).toHaveLength(1);
    expect(paged).toEqual([]);
    expect(declared).toHaveLength(0);
  });

  it("recovers an adopted incident, so the restart can still close it out", async () => {
    const existing = IncidentRecordSchema.parse({
      id: "INC-2026-0007",
      title: `Audit integrity compromised for ${TENANT_A}`,
      severity: "sev1",
      category: "security",
      status: "declared",
      declaredAt: AT,
      declaredBy: "operate-server",
      autoDeclaredFor: `audit-integrity:${TENANT_A}`,
      timeline: [{ occurredAt: AT, actorUserId: "operate-server", kind: "declared", message: "x" }],
    });
    const { cancelled, declarer } = fakeDeclarer({
      open: new Map([[`audit-integrity:${TENANT_A}`, existing]]),
    });
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    const recovered = await esc.observe(report({ verdict: "verified" }));
    expect(recovered.kind).toBe("recovered");
    expect(recovered.incidentId).toBe("INC-2026-0007");
    expect(cancelled).toEqual(["INC-2026-0007"]);
  });

  it("looks up only once per episode, not on every ongoing pass", async () => {
    const { lookups, declarer } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    await esc.observe(report());
    await esc.observe(report());
    expect(lookups).toHaveLength(1);
  });

  it("declares anyway when the lookup fails, rather than leaving the tamper unescalated", async () => {
    const errors: unknown[] = [];
    const { declared, lookups, declarer } = fakeDeclarer({ failFindOpen: true });
    const escalation = await new IntegrityEscalator({
      config: config(),
      declarer,
      onError: (err) => errors.push(err),
    }).observe(report());
    expect(escalation.kind).toBe("opened");
    expect(lookups).toHaveLength(1);
    expect(declared).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("keeps separate scopes separate when adopting", async () => {
    const existing = IncidentRecordSchema.parse({
      id: "INC-2026-0007",
      title: "Audit integrity compromised for another tenant",
      severity: "sev1",
      category: "security",
      status: "declared",
      declaredAt: AT,
      declaredBy: "operate-server",
      autoDeclaredFor: `audit-integrity:${TENANT_B}`,
      timeline: [{ occurredAt: AT, actorUserId: "operate-server", kind: "declared", message: "x" }],
    });
    const { declared, declarer } = fakeDeclarer({
      open: new Map([[`audit-integrity:${TENANT_B}`, existing]]),
    });
    const escalation = await new IntegrityEscalator({ config: config(), declarer }).observe(
      report(),
    );
    expect(escalation.kind).toBe("opened");
    expect(declared).toHaveLength(1);
  });

  it("reports unpersisted when no declarer is wired", async () => {
    const escalation = await new IntegrityEscalator({
      config: config(),
      now: () => new Date(AT),
    }).observe(report());
    expect(escalation.disposition).toBe("unpersisted");
  });

  it("reports unpersisted on recovery when no declarer is wired", async () => {
    // `CountingIncidentDeclarer.closeOut` answers `unpersisted`, which is the honest outcome:
    // nothing stored the record, so there is nothing to cancel.
    const esc = new IntegrityEscalator({ config: config(), now: () => new Date(AT) });
    await esc.observe(report());
    const recovered = await esc.observe(report({ verdict: "verified" }));
    expect(recovered.kind).toBe("recovered");
    expect(recovered.disposition).toBe("unpersisted");
  });

  it("still writes the audit row alongside the incident", async () => {
    const { audit, emitted } = fakeAudit();
    const { declarer } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer, audit });
    await esc.observe(report());
    expect(emitted.map((e) => e.operation)).toEqual([INTEGRITY_INCIDENT_OPERATION]);
    await esc.observe(report({ verdict: "verified" }));
    expect(emitted.map((e) => e.operation)).toEqual([
      INTEGRITY_INCIDENT_OPERATION,
      INTEGRITY_RECOVERY_OPERATION,
    ]);
  });
});

describe("IntegrityEscalator — the wrapping declarer", () => {
  it("tries the wired declarer before the fallback, not instead of it", async () => {
    // The fallback is a last resort. If the primary were skipped the record would never be stored
    // and nothing would say so, so this asserts the store was actually asked.
    const { attempts, declarer } = fakeDeclarer({ failDeclare: true });
    await new IntegrityEscalator({
      config: config(),
      declarer,
      onError: () => undefined,
      now: () => new Date(AT),
    }).observe(report());
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.autoDeclaredFor).toBe(`audit-integrity:${TENANT_A}`);
  });

  it("does not ask the store to close an id the store never issued", async () => {
    // The inline fallback did: a refused declaration left the escalator holding a counter-minted
    // id, and the recovery sent that id to the store — which, since the counter restarts at 0001,
    // could cancel a different incident entirely. The wrapper routes it back to the fallback.
    const { closedOut, cancelled, declarer } = fakeDeclarer({ failDeclare: true });
    const esc = new IntegrityEscalator({
      config: config(),
      declarer,
      onError: () => undefined,
      now: () => new Date(AT),
    });
    const opened = await esc.observe(report());
    expect(opened.incidentId).toBe("INC-2026-0001");
    const recovered = await esc.observe(report({ verdict: "verified" }));
    expect(recovered.kind).toBe("recovered");
    expect(recovered.disposition).toBe("unpersisted");
    expect(closedOut).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it("keeps reporting an unpersisted episode as unpersisted on every ongoing pass", async () => {
    // The old code reported `declared` here because a declarer was wired, regardless of whether it
    // had served — which read as "the row is open" for a record no row exists for.
    const { declarer } = fakeDeclarer({ failDeclare: true });
    const esc = new IntegrityEscalator({
      config: config(),
      declarer,
      onError: () => undefined,
      now: () => new Date(AT),
    });
    expect((await esc.observe(report())).disposition).toBe("unpersisted");
    expect((await esc.observe(report())).disposition).toBe("unpersisted");
  });

  it("reports the store's error exactly once per failed declaration", async () => {
    const errors: unknown[] = [];
    const { declarer } = fakeDeclarer({ failDeclare: true });
    const esc = new IntegrityEscalator({
      config: config(),
      declarer,
      onError: (err) => errors.push(err),
      now: () => new Date(AT),
    });
    await esc.observe(report());
    await esc.observe(report());
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("store unavailable");
  });

  it("declares a second scope through the store after the first fell back", async () => {
    // One refused declaration must not latch the escalator onto the fallback for everything after.
    let failing = true;
    const inner = fakeDeclarer();
    const declarer: IncidentDeclarer = {
      declare: async (request) => {
        if (failing) throw new Error("store unavailable");
        return await inner.declarer.declare(request);
      },
      findOpen: async (key) => await inner.declarer.findOpen(key),
      closeOut: async (id, input) => await inner.declarer.closeOut(id, input),
    };
    const esc = new IntegrityEscalator({
      config: config(),
      declarer,
      onError: () => undefined,
      now: () => new Date(AT),
    });
    const first = await esc.observe(report({ scope: TENANT_A }));
    failing = false;
    const second = await esc.observe(report({ scope: TENANT_B }));
    expect(first.disposition).toBe("unpersisted");
    expect(second.disposition).toBe("declared");
    expect(inner.declared.map((d) => d.id)).toEqual([second.incidentId]);
  });

  it("reports an adopted incident as declared, because findOpen only reads stored rows", async () => {
    const existing = IncidentRecordSchema.parse({
      id: "INC-2026-0007",
      title: `Audit integrity compromised for ${TENANT_A}`,
      severity: "sev1",
      category: "security",
      status: "declared",
      declaredAt: AT,
      declaredBy: "operate-server",
      autoDeclaredFor: `audit-integrity:${TENANT_A}`,
      timeline: [{ occurredAt: AT, actorUserId: "operate-server", kind: "declared", message: "x" }],
    });
    const { declarer } = fakeDeclarer({
      open: new Map([[`audit-integrity:${TENANT_A}`, existing]]),
    });
    const escalation = await new IntegrityEscalator({ config: config(), declarer }).observe(
      report(),
    );
    expect(escalation.kind).toBe("ongoing");
    expect(escalation.disposition).toBe("declared");
  });

  it("closes an adopted incident through the store, not the fallback", async () => {
    const existing = IncidentRecordSchema.parse({
      id: "INC-2026-0007",
      title: `Audit integrity compromised for ${TENANT_A}`,
      severity: "sev1",
      category: "security",
      status: "declared",
      declaredAt: AT,
      declaredBy: "operate-server",
      autoDeclaredFor: `audit-integrity:${TENANT_A}`,
      timeline: [{ occurredAt: AT, actorUserId: "operate-server", kind: "declared", message: "x" }],
    });
    const { closedOut, declarer } = fakeDeclarer({
      open: new Map([[`audit-integrity:${TENANT_A}`, existing]]),
    });
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    expect((await esc.observe(report({ verdict: "verified" }))).disposition).toBe("cancelled");
    expect(closedOut.map((c) => c.incidentId)).toEqual(["INC-2026-0007"]);
  });

  it("formats a fallback declaration exactly as a stored one — the strings are quoted in ADRs", async () => {
    const { declarer } = fakeDeclarer({ failDeclare: true });
    const text = formatIntegrityEscalation(
      await new IntegrityEscalator({
        config: config(),
        declarer,
        onError: () => undefined,
        now: () => new Date(AT),
      }).observe(report()),
    );
    expect(text).toBe(
      "audit integrity for " +
        TENANT_A +
        ": DECLARED INC-2026-0001 severity=sev1 paged=pagerduty_phone audited=false",
    );
  });
});

describe("INCIDENT_DISPOSITIONS", () => {
  it("enumerates what can become of the record", () => {
    expect([...INCIDENT_DISPOSITIONS]).toEqual([
      "unpersisted",
      "declared",
      "cancelled",
      "human_owned",
    ]);
  });
});

describe("dispositionFromCloseOut", () => {
  it("passes through the three values the two vocabularies share", () => {
    expect(dispositionFromCloseOut("cancelled")).toBe("cancelled");
    expect(dispositionFromCloseOut("human_owned")).toBe("human_owned");
    expect(dispositionFromCloseOut("unpersisted")).toBe("unpersisted");
  });

  it("reads a failed close-out as a still-declared incident", () => {
    // The store refused it, so the row is open — which is the one thing `declared` says and no
    // close-out value does.
    expect(dispositionFromCloseOut("failed")).toBe("declared");
  });

  it("maps every close-out to a declared disposition", () => {
    const closeOuts: readonly IncidentCloseOut[] = [
      "unpersisted",
      "cancelled",
      "human_owned",
      "failed",
    ];
    for (const c of closeOuts) {
      expect(INCIDENT_DISPOSITIONS).toContain(dispositionFromCloseOut(c));
    }
  });
});

describe("formatIntegrityEscalation — dispositions", () => {
  it("says a recovered incident was cancelled", async () => {
    const { declarer } = fakeDeclarer();
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    const text = formatIntegrityEscalation(await esc.observe(report({ verdict: "verified" })));
    expect(text).toContain("cancelled INC-2026-0001");
  });

  it("says a triaged incident was left to its responders", async () => {
    const { declarer } = fakeDeclarer({ triaged: true });
    const esc = new IntegrityEscalator({ config: config(), declarer });
    await esc.observe(report());
    const text = formatIntegrityEscalation(await esc.observe(report({ verdict: "verified" })));
    expect(text).toContain("left to its responders INC-2026-0001");
  });

  it("says `closing` when the close-out could not be recorded", async () => {
    const { declarer } = fakeDeclarer({ failCloseOut: true });
    const esc = new IntegrityEscalator({ config: config(), declarer, onError: () => undefined });
    await esc.observe(report());
    const text = formatIntegrityEscalation(await esc.observe(report({ verdict: "verified" })));
    expect(text).toContain("recovered, closing INC-2026-0001");
  });
});
