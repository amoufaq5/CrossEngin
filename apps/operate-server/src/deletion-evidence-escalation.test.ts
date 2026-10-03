import { describe, expect, it } from "vitest";
import type { IncidentRecord } from "@crossengin/incident-response";
import type {
  IncidentCloseOut,
  IncidentDeclarationRequest,
  IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import type { AlertPolicy } from "@crossengin/observability";

import { DeletionEscalationConfigSchema } from "./deletion-escalation-config.js";
import {
  DELETION_EVIDENCE_SIGNAL,
  DeletionEvidenceEscalator,
  ESCALATING_VERDICTS,
  RESOLVING_VERDICTS,
  deletionEvidenceKey,
  type EscalatableFinding,
  type EscalatableVerdict,
} from "./deletion-evidence-escalation.js";

const REQ = "dreq_abcdefgh1234";
const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const TOMB = "tomb_aaaabbbbccccdddd";
const AT = "2026-10-03T15:00:00.000Z";
const INC = "INC-2026-0007";

const ALERT_POLICY: AlertPolicy = {
  id: "ap_deletion",
  routes: [
    // The route's severity is the ALERT vocabulary (P0..P3); `planPageDirective` maps the incident
    // severity (`sev1`) onto it. Two vocabularies, one bridge.
    { severity: "P0", channels: [{ kind: "pagerduty_phone", serviceKey: "deletion-oncall" }] },
  ],
};

function configOf(over: Record<string, unknown> = {}) {
  return DeletionEscalationConfigSchema.parse({ alertPolicy: ALERT_POLICY, ...over });
}

function incidentOf(id = INC): IncidentRecord {
  return { id, severity: "sev1", status: "declared" } as unknown as IncidentRecord;
}

function verdictOf(over: Partial<EscalatableVerdict> = {}): EscalatableVerdict {
  return {
    requestId: REQ,
    tenantId: TENANT,
    verdict: "evidence_unverified",
    tombstoneId: TOMB,
    tombstoneIds: [TOMB],
    detail: "tombstone does not verify: scope_tampered",
    ...over,
  };
}

function findingOf(over: Partial<EscalatableFinding> = {}): EscalatableFinding {
  return {
    requestId: REQ,
    tenantId: TENANT,
    tombstoneId: TOMB,
    present: true,
    detail: "tombstone does not verify: scope_tampered",
    ...over,
  };
}

interface Harness {
  readonly escalator: DeletionEvidenceEscalator;
  readonly declared: IncidentDeclarationRequest[];
  readonly findOpenKeys: string[];
  readonly closedOut: Array<{ id: string; reason: string }>;
  readonly pages: string[];
}

function harness(
  behaviour: {
    readonly open?: IncidentRecord | null;
    readonly declareThrows?: boolean;
    readonly findOpenThrows?: boolean;
    readonly closeOutThrows?: boolean;
    readonly closeOut?: IncidentCloseOut;
  } = {},
  config = configOf(),
): Harness {
  const declared: IncidentDeclarationRequest[] = [];
  const findOpenKeys: string[] = [];
  const closedOut: Array<{ id: string; reason: string }> = [];
  const pages: string[] = [];
  const declarer: IncidentDeclarer = {
    declare: async (request): Promise<IncidentRecord> => {
      declared.push(request);
      if (behaviour.declareThrows === true) throw new Error("incident store unreachable");
      return incidentOf();
    },
    findOpen: async (key): Promise<IncidentRecord | null> => {
      findOpenKeys.push(key);
      if (behaviour.findOpenThrows === true) throw new Error("lookup failed");
      return behaviour.open ?? null;
    },
    closeOut: async (id, input): Promise<IncidentCloseOut> => {
      closedOut.push({ id, reason: input.reason });
      if (behaviour.closeOutThrows === true) throw new Error("close-out failed");
      return behaviour.closeOut ?? "cancelled";
    },
  };
  const escalator = new DeletionEvidenceEscalator({
    declarer,
    config,
    page: (page, incident) => {
      pages.push(`${incident.id}:${page.channels.length.toString()}`);
    },
    clock: () => new Date(AT),
  });
  return { escalator, declared, findOpenKeys, closedOut, pages };
}

describe("the config", () => {
  it("defaults to a sev1 security incident and requires somewhere to page", () => {
    const config = configOf();
    expect(config.severity).toBe("sev1");
    // The thing subverted is a tamper-evidence control, and the compliance consequence depends on
    // an investigation this declaration starts.
    expect(config.category).toBe("security");
    expect(config.declaredBy).toBe("operate-server");
    // Escalation with nowhere to page is not escalation (ADR-0288's rule).
    expect(() => DeletionEscalationConfigSchema.parse({})).toThrow();
  });
});

describe("which verdicts escalate", () => {
  it("escalates only the two findings the chain cannot raise", () => {
    expect(ESCALATING_VERDICTS).toEqual(["evidence_unverified", "ambiguous_evidence"]);
  });

  it("treats a vanished tombstone as worse, not resolved", () => {
    // `never_committed` is deliberately absent: a request that escalated had a tombstone, so reading
    // `never_committed` later means it has since vanished. The incident stays open.
    expect(RESOLVING_VERDICTS).not.toContain("never_committed");
    expect(RESOLVING_VERDICTS).toEqual(["completed_by_evidence", "not_stranded"]);
  });

  it("keys an episode on the request", () => {
    expect(deletionEvidenceKey(REQ)).toBe(`${DELETION_EVIDENCE_SIGNAL}:${REQ}`);
  });
});

describe("onVerdict", () => {
  it("declares a sev1 and pages for an unverified proof", async () => {
    const h = harness();
    const outcome = await h.escalator.onVerdict(verdictOf());
    expect(outcome.action).toBe("declared");
    expect(outcome.incidentId).toBe(INC);
    expect(h.declared[0]?.severity).toBe("sev1");
    expect(h.declared[0]?.autoDeclaredFor).toBe(deletionEvidenceKey(REQ));
    expect(h.declared[0]?.securityIncident).toBe(true);
    expect(h.declared[0]?.affectedTenantIds).toEqual([TENANT]);
    expect(h.pages).toEqual([`${INC}:1`]);
  });

  it("names the tombstone and the defects in the detail", async () => {
    const h = harness();
    await h.escalator.onVerdict(verdictOf());
    expect(h.declared[0]?.detail).toContain(TOMB);
    expect(h.declared[0]?.detail).toContain("scope_tampered");
  });

  it("lists both tombstones when the evidence is ambiguous", async () => {
    const h = harness();
    await h.escalator.onVerdict(
      verdictOf({
        verdict: "ambiguous_evidence",
        tombstoneId: null,
        tombstoneIds: [TOMB, "tomb_bbbbccccddddeeee"],
        detail: "2 tombstones name this request",
      }),
    );
    expect(h.declared[0]?.detail).toContain(TOMB);
    expect(h.declared[0]?.detail).toContain("tomb_bbbbccccddddeeee");
  });

  it("adopts an episode that already has one open rather than declaring again", async () => {
    const h = harness({ open: incidentOf() });
    const outcome = await h.escalator.onVerdict(verdictOf());
    // A scheduler re-examines a stranded request every tick; one tampered row is one episode.
    expect(outcome.action).toBe("adopted");
    expect(outcome.incidentId).toBe(INC);
    expect(h.declared).toEqual([]);
    expect(h.pages).toEqual([]);
  });

  it("asks nothing of the declarer for a verdict that neither escalates nor resolves", async () => {
    for (const verdict of ["never_committed", "too_recent"]) {
      const h = harness();
      const outcome = await h.escalator.onVerdict(verdictOf({ verdict }));
      expect(outcome.action).toBe("none");
      // The common case on every tick: no query at all.
      expect(h.findOpenKeys).toEqual([]);
    }
  });

  it("closes out the open incident when the evidence verifies again", async () => {
    const h = harness({ open: incidentOf() });
    const outcome = await h.escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.action).toBe("closed_out");
    expect(outcome.closeOut).toBe("cancelled");
    expect(h.closedOut[0]?.id).toBe(INC);
    expect(h.closedOut[0]?.reason).toContain("completed_by_evidence");
  });

  it("leaves a triaged incident alone, because that is the declarer's rule", async () => {
    const h = harness({ open: incidentOf(), closeOut: "human_owned" });
    const outcome = await h.escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.closeOut).toBe("human_owned");
  });

  it("does nothing on a resolving verdict with nothing open", async () => {
    const h = harness({ open: null });
    const outcome = await h.escalator.onVerdict(verdictOf({ verdict: "not_stranded" }));
    expect(outcome.action).toBe("none");
    expect(h.closedOut).toEqual([]);
  });

  it("reports a declarer failure without throwing, so the next pass retries", async () => {
    const errors: string[] = [];
    const h = harness({ declareThrows: true });
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => {
          throw new Error("incident store unreachable");
        },
        findOpen: async () => null,
        closeOut: async () => "cancelled",
      },
      config: configOf(),
      onError: (_e, id) => errors.push(id),
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onVerdict(verdictOf());
    // No fallback declarer, unlike the integrity escalator (ADR-0304): this finding is re-derived
    // from the same two rows next pass, so it is retried rather than lost.
    expect(outcome.action).toBe("failed");
    expect(outcome.incidentId).toBeNull();
    expect(errors).toEqual([REQ]);
    expect(h.pages).toEqual([]);
  });

  it("reports a failed close-out rather than claiming the incident closed", async () => {
    const h = harness({ open: incidentOf(), closeOutThrows: true });
    const outcome = await h.escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.action).toBe("failed");
    expect(outcome.closeOut).toBeNull();
  });
});

describe("onAuditFinding", () => {
  it("declares for a completed request whose proof no longer verifies", async () => {
    const h = harness();
    const outcome = await h.escalator.onAuditFinding(findingOf());
    expect(outcome.action).toBe("declared");
    expect(h.declared[0]?.title).toContain("no longer verifies");
    expect(h.declared[0]?.detail).toContain(TOMB);
  });

  it("says so differently when the tombstone is simply gone", async () => {
    const h = harness();
    await h.escalator.onAuditFinding(
      findingOf({ present: false, detail: "the tombstone no longer exists" }),
    );
    expect(h.declared[0]?.title).toContain("missing");
  });

  it("shares the episode with the stranded path, so one row is one incident", async () => {
    const h = harness({ open: incidentOf() });
    const outcome = await h.escalator.onAuditFinding(findingOf());
    expect(outcome.action).toBe("adopted");
    expect(h.findOpenKeys).toEqual([deletionEvidenceKey(REQ)]);
    expect(h.declared).toEqual([]);
  });
});
