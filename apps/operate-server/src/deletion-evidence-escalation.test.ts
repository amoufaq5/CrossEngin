import { describe, expect, it } from "vitest";
import type { IncidentRecord } from "@crossengin/incident-response";
import type {
  IncidentCloseOut,
  IncidentDeclarationRequest,
  IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import type { AlertPolicy } from "@crossengin/observability";
import type { PageDirective } from "@crossengin/observability-runtime";

import { EVIDENCE_DEFECTS } from "@crossengin/tenant-lifecycle-pg";

import { DeletionEscalationConfigSchema } from "./deletion-escalation-config.js";
import {
  DELETION_EVIDENCE_ESCALATED_OPERATION,
  DELETION_EVIDENCE_RESOLVED_OPERATION,
  DELETION_EVIDENCE_SIGNAL,
  DeletionEvidenceEscalator,
  ESCALATING_VERDICTS,
  RESOLVING_VERDICTS,
  deletionEvidenceKey,
  severityForDefects,
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
    // A second route so a downgraded grade has somewhere else to land — the page must follow the
    // grade that was declared, not the configured default.
    { severity: "P2", channels: [{ kind: "slack", channel: "#deletion-evidence" }] },
  ],
};

function configOf(over: Record<string, unknown> = {}) {
  return DeletionEscalationConfigSchema.parse({ alertPolicy: ALERT_POLICY, ...over });
}

function incidentOf(id = INC, severity = "sev1"): IncidentRecord {
  return { id, severity, status: "declared" } as unknown as IncidentRecord;
}

function verdictOf(over: Partial<EscalatableVerdict> = {}): EscalatableVerdict {
  return {
    requestId: REQ,
    tenantId: TENANT,
    verdict: "evidence_unverified",
    tombstoneId: TOMB,
    tombstoneIds: [TOMB],
    defects: ["scope_tampered"],
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
    defects: ["scope_tampered"],
    detail: "tombstone does not verify: scope_tampered",
    ...over,
  };
}

interface EmittedEntry {
  readonly operation: string;
  readonly tenantId: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly after: Record<string, unknown> | null;
}

interface Harness {
  readonly escalator: DeletionEvidenceEscalator;
  readonly declared: IncidentDeclarationRequest[];
  readonly findOpenKeys: string[];
  readonly closedOut: Array<{ id: string; reason: string }>;
  readonly pages: string[];
  readonly directives: PageDirective[];
  readonly emitted: EmittedEntry[];
  readonly errors: unknown[];
}

function harness(
  behaviour: {
    readonly open?: IncidentRecord | null;
    readonly declareThrows?: boolean;
    readonly findOpenThrows?: boolean;
    readonly closeOutThrows?: boolean;
    readonly closeOut?: IncidentCloseOut;
    /** `"off"` wires no emitter at all; `"throws"` wires one that cannot write. */
    readonly audit?: "on" | "off" | "throws";
  } = {},
  config = configOf(),
): Harness {
  const declared: IncidentDeclarationRequest[] = [];
  const findOpenKeys: string[] = [];
  const closedOut: Array<{ id: string; reason: string }> = [];
  const pages: string[] = [];
  const directives: PageDirective[] = [];
  const emitted: EmittedEntry[] = [];
  const errors: unknown[] = [];
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
  const mode = behaviour.audit ?? "on";
  const audit = {
    emit: async (entry: {
      operation: string;
      tenantId: string;
      entity: string;
      entityId: string | null;
      after: Record<string, unknown> | null;
    }): Promise<void> => {
      if (mode === "throws") throw new Error("audit_log unavailable");
      emitted.push({
        operation: entry.operation,
        tenantId: entry.tenantId,
        entity: entry.entity,
        entityId: entry.entityId,
        after: entry.after,
      });
    },
  } as never;
  const escalator = new DeletionEvidenceEscalator({
    declarer,
    config,
    ...(mode === "off" ? {} : { audit }),
    page: (page, incident) => {
      pages.push(`${incident.id}:${page.channels.length.toString()}`);
      directives.push(page);
    },
    onError: (err) => errors.push(err),
    clock: () => new Date(AT),
  });
  return { escalator, declared, findOpenKeys, closedOut, pages, directives, emitted, errors };
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

  it("leaves severityByDefect absent when nothing grades, so every finding keeps the default", () => {
    expect(configOf().severityByDefect).toBeUndefined();
  });

  it("accepts a partial map over the real defect names", () => {
    const config = configOf({ severityByDefect: { unwitnessed: "sev3" } });
    expect(config.severityByDefect).toEqual({ unwitnessed: "sev3" });
    // Every real defect name is a legal key; the config and `verifyStoredEvidence` share one
    // vocabulary rather than a copy of one.
    const all = Object.fromEntries(EVIDENCE_DEFECTS.map((d) => [d, "sev2"]));
    expect(configOf({ severityByDefect: all }).severityByDefect).toEqual(all);
  });

  it("refuses a defect name that is not one, rather than ignoring it", () => {
    // A typo'd key that parsed would be an override that silently never matches, leaving the
    // finding at the default sev1 — the quiet degradation this codebase refuses.
    expect(() => configOf({ severityByDefect: { scope_tamperd: "sev3" } })).toThrow();
    expect(() => configOf({ severityByDefect: { unwitnessed: "sev9" } })).toThrow();
  });
});

describe("severityForDefects", () => {
  it("falls back to the configured severity for an empty list", () => {
    expect(severityForDefects([], configOf())).toBe("sev1");
    expect(severityForDefects([], configOf({ severity: "sev2" }))).toBe("sev2");
  });

  it("grades a defect that has an override", () => {
    const config = configOf({ severityByDefect: { unwitnessed: "sev3" } });
    // An `unwitnessed` tombstone is plausibly a row written outside the pipeline; a rewritten
    // scope cannot be anything but a tamper. ADR-0324 graded both sev1 and said so itself.
    expect(severityForDefects(["unwitnessed"], config)).toBe("sev3");
  });

  it("takes the highest severity when a record has several defects", () => {
    const config = configOf({ severityByDefect: { unwitnessed: "sev3", proof_mismatch: "sev2" } });
    // A record with two defects is at least as bad as its worst one. An averaging or last-wins
    // scheme would let `unwitnessed` mask `proof_mismatch`.
    expect(severityForDefects(["unwitnessed", "proof_mismatch"], config)).toBe("sev2");
    expect(severityForDefects(["proof_mismatch", "unwitnessed"], config)).toBe("sev2");
  });

  it("keeps the default for an ungraded defect, so one override cannot downgrade the rest", () => {
    const config = configOf({ severityByDefect: { unwitnessed: "sev4" } });
    expect(severityForDefects(["scope_tampered"], config)).toBe("sev1");
    expect(severityForDefects(["unwitnessed", "scope_tampered"], config)).toBe("sev1");
  });

  it("grades a defect it has never heard of at the default rather than dropping it", () => {
    // The config cannot hold such a key, but the escalator's input is `readonly string[]` from a
    // caller — an unknown name must not read as "nothing wrong".
    expect(severityForDefects(["from_the_future"], configOf({ severity: "sev2" }))).toBe("sev2");
  });

  it("is a no-op when nothing is graded at all", () => {
    const config = configOf();
    for (const defect of EVIDENCE_DEFECTS) {
      expect(severityForDefects([defect], config)).toBe("sev1");
    }
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

describe("the grade reaches the declaration and the page", () => {
  const graded = configOf({ severityByDefect: { unwitnessed: "sev3" } });

  it("declares at the graded severity, not the configured default", async () => {
    const h = harness({}, graded);
    const outcome = await h.escalator.onVerdict(verdictOf({ defects: ["unwitnessed"] }));
    expect(outcome.severity).toBe("sev3");
    expect(h.declared[0]?.severity).toBe("sev3");
  });

  it("pages on the grade it declared, so the two cannot diverge", async () => {
    const h = harness({}, graded);
    await h.escalator.onVerdict(verdictOf({ defects: ["unwitnessed"] }));
    // One `severityForDefects` call feeds both the declaration and `planPageDirective`; a page
    // routed by a different grade than the incident carries would reach the wrong rotation about
    // an incident that does not say so.
    expect(h.directives[0]?.severity).toBe(h.declared[0]?.severity);
    expect(h.directives[0]?.alertSeverity).toBe("P2");
    expect(h.directives[0]?.channels[0]?.kind).toBe("slack");
  });

  it("still pages P0 for the ungraded defect, through the same policy", async () => {
    const h = harness({}, graded);
    await h.escalator.onVerdict(verdictOf({ defects: ["scope_tampered"] }));
    expect(h.declared[0]?.severity).toBe("sev1");
    expect(h.directives[0]?.alertSeverity).toBe("P0");
  });

  it("grades the audit direction by the same rule", async () => {
    const h = harness({}, graded);
    const outcome = await h.escalator.onAuditFinding(findingOf({ defects: ["unwitnessed"] }));
    expect(outcome.severity).toBe("sev3");
    expect(h.directives[0]?.severity).toBe("sev3");
  });

  it("behaves exactly as before for a caller that reports no defects", async () => {
    const h = harness({}, graded);
    const outcome = await h.escalator.onVerdict(verdictOf({ defects: undefined }));
    // The field is optional so existing call sites keep compiling; absent must mean "ungraded",
    // never "nothing wrong".
    expect(outcome.severity).toBe("sev1");
    expect(h.directives[0]?.alertSeverity).toBe("P0");
  });
});

describe("the escalation leaves an anchored audit row", () => {
  it("records the declaration against the finding's tenant and request", async () => {
    const h = harness();
    const outcome = await h.escalator.onVerdict(verdictOf());
    expect(outcome.audited).toBe(true);
    expect(h.emitted).toHaveLength(1);
    const row = h.emitted[0];
    expect(row?.operation).toBe(DELETION_EVIDENCE_ESCALATED_OPERATION);
    expect(DELETION_EVIDENCE_ESCALATED_OPERATION).toBe("platform.deletion_evidence_escalated");
    // Unlike the integrity escalator, this always has a tenant: the finding is about one request,
    // which belongs to one tenant. So there is no platform-scope row it cannot write.
    expect(row?.tenantId).toBe(TENANT);
    expect(row?.entity).toBe("GdprDeletionRequest");
    expect(row?.entityId).toBe(REQ);
  });

  it("carries the evidence of why this grade was declared", async () => {
    const h = harness({}, configOf({ severityByDefect: { unwitnessed: "sev3" } }));
    await h.escalator.onVerdict(
      verdictOf({ defects: ["unwitnessed"], verdict: "ambiguous_evidence" }),
    );
    expect(h.emitted[0]?.after).toMatchObject({
      incidentId: INC,
      severity: "sev3",
      category: "security",
      defects: ["unwitnessed"],
      verdict: "ambiguous_evidence",
    });
  });

  it("records a close-out under its own operation", async () => {
    const h = harness({ open: incidentOf() });
    const outcome = await h.escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.audited).toBe(true);
    expect(h.emitted[0]?.operation).toBe(DELETION_EVIDENCE_RESOLVED_OPERATION);
    expect(DELETION_EVIDENCE_RESOLVED_OPERATION).toBe("platform.deletion_evidence_resolved");
    expect(h.emitted[0]?.entityId).toBe(REQ);
    expect(h.emitted[0]?.after).toMatchObject({ incidentId: INC, defects: [] });
  });

  it("writes nothing when an episode is adopted, because the declaration's row already stands", async () => {
    const h = harness({ open: incidentOf() });
    const outcome = await h.escalator.onVerdict(verdictOf());
    expect(outcome.action).toBe("adopted");
    expect(outcome.audited).toBe(false);
    // One row per tick would bury the one that matters.
    expect(h.emitted).toEqual([]);
  });

  it("writes nothing for a verdict that neither escalates nor resolves", async () => {
    const h = harness();
    const outcome = await h.escalator.onVerdict(verdictOf({ verdict: "too_recent" }));
    expect(outcome.audited).toBe(false);
    expect(h.emitted).toEqual([]);
  });

  it("declares and pages with no emitter wired, reporting audited:false", async () => {
    const h = harness({ audit: "off" });
    const outcome = await h.escalator.onVerdict(verdictOf());
    expect(outcome.action).toBe("declared");
    expect(outcome.audited).toBe(false);
    expect(h.pages).toEqual([`${INC}:1`]);
  });

  it("keeps the escalation when the audit log cannot be written", async () => {
    const h = harness({ audit: "throws" });
    const outcome = await h.escalator.onVerdict(verdictOf());
    // The incident is already declared and somebody has already been paged, so an unwritable row
    // must not turn a successful escalation into a `failed` one the next tick re-declares. And the
    // audit log being unwritable is itself one of the conditions this platform escalates for.
    expect(outcome.action).toBe("declared");
    expect(outcome.incidentId).toBe(INC);
    expect(outcome.audited).toBe(false);
    expect(h.pages).toEqual([`${INC}:1`]);
    expect(h.errors).toHaveLength(1);
  });
});

describe("closing the provider's alert (ADR-0326)", () => {
  it("resolves the alert when the incident is closed out", async () => {
    const resolved: string[] = [];
    const h = harness({ open: incidentOf() });
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => incidentOf(),
        findOpen: async () => incidentOf(),
        closeOut: async () => "cancelled",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page.incidentId);
      },
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.action).toBe("closed_out");
    // Keyed on the same incident id the trigger used, which is PagerDuty's `dedup_key`.
    expect(resolved).toEqual([INC]);
    expect(h.declared).toEqual([]);
  });

  it("does not resolve when nothing was open", async () => {
    const resolved: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => incidentOf(),
        findOpen: async () => null,
        closeOut: async () => "cancelled",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page.incidentId);
      },
      clock: () => new Date(AT),
    });
    await escalator.onVerdict(verdictOf({ verdict: "not_stranded" }));
    expect(resolved).toEqual([]);
  });

  it("does not resolve on a declaration", async () => {
    const resolved: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => incidentOf(),
        findOpen: async () => null,
        closeOut: async () => "cancelled",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page.incidentId);
      },
      clock: () => new Date(AT),
    });
    await escalator.onVerdict(verdictOf());
    expect(resolved).toEqual([]);
  });

  it("routes the resolve at the incident's own grade, not the configured default", async () => {
    const resolved: PageDirective[] = [];
    // Declared `sev3` (an `unwitnessed` finding under the per-defect map), so it paged the P2 route.
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => incidentOf(INC, "sev3"),
        findOpen: async () => incidentOf(INC, "sev3"),
        closeOut: async () => "cancelled",
      },
      config: configOf({ severityByDefect: { unwitnessed: "sev3" } }),
      resolvePage: (page) => {
        resolved.push(page);
      },
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.action).toBe("closed_out");
    expect(outcome.severity).toBe("sev3");
    // The whole point: `sev3` → P2 → slack. Planning this at the configured default (`sev1`) would
    // have resolved on the P0 route — telling PagerDuty to close an alert it never had, and leaving
    // the rotation that was actually paged with an alert nobody closed.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.severity).toBe("sev3");
    expect(resolved[0]?.channels.map((c) => c.kind)).toEqual(["slack"]);
  });

  it("routes the resolve to the same channels the trigger used, for every graded severity", async () => {
    for (const [severity, channel] of [
      ["sev1", "pagerduty_phone"],
      ["sev3", "slack"],
    ] as const) {
      const triggered: PageDirective[] = [];
      const resolved: PageDirective[] = [];
      let open: IncidentRecord | null = null;
      const escalator = new DeletionEvidenceEscalator({
        declarer: {
          declare: async () => {
            open = incidentOf(INC, severity);
            return open;
          },
          findOpen: async () => open,
          closeOut: async () => "cancelled",
        },
        config: configOf({
          severityByDefect: { scope_tampered: "sev1", unwitnessed: "sev3" },
        }),
        page: (page) => {
          triggered.push(page);
        },
        resolvePage: (page) => {
          resolved.push(page);
        },
        clock: () => new Date(AT),
      });
      const defect = severity === "sev1" ? "scope_tampered" : "unwitnessed";
      await escalator.onVerdict(verdictOf({ defects: [defect] }));
      await escalator.onVerdict(verdictOf({ verdict: "not_stranded" }));
      // One assertion, two directives: a resolve is the trigger's mirror or it closes nothing.
      expect(resolved.map((p) => p.channels.map((c) => c.kind))).toEqual(
        triggered.map((p) => p.channels.map((c) => c.kind)),
      );
      expect(resolved[0]?.channels.map((c) => c.kind)).toEqual([channel]);
    }
  });

  it("does not resolve the alert of an incident a human has triaged", async () => {
    const resolved: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => incidentOf(),
        findOpen: async () => incidentOf(),
        // The declarer's rule: a triaged incident is not cancelled by a recovery.
        closeOut: async () => "human_owned",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page.incidentId);
      },
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.closeOut).toBe("human_owned");
    // The incident is open and owned. Resolving its alert would take it off the board of the person
    // holding it, which is worse than an alert left up.
    expect(resolved).toEqual([]);
  });

  it("does not resolve when the close-out could not be recorded", async () => {
    const resolved: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => incidentOf(),
        findOpen: async () => incidentOf(),
        closeOut: async () => "failed",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page.incidentId);
      },
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onVerdict(verdictOf({ verdict: "not_stranded" }));
    expect(outcome.closeOut).toBe("failed");
    // Fail closed: the row is still open and we do not know its state.
    expect(resolved).toEqual([]);
  });

  it("resolves an unpersisted episode's alert, because the page was real either way", async () => {
    const resolved: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async () => incidentOf(),
        findOpen: async () => incidentOf(),
        closeOut: async () => "unpersisted",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page.incidentId);
      },
      clock: () => new Date(AT),
    });
    await escalator.onVerdict(verdictOf({ verdict: "not_stranded" }));
    expect(resolved).toEqual([INC]);
  });

  it("records the resolution at the incident's declared grade", async () => {
    const h = harness({ open: incidentOf(INC, "sev3") });
    const outcome = await h.escalator.onVerdict(verdictOf({ verdict: "completed_by_evidence" }));
    expect(outcome.audited).toBe(true);
    const entry = h.emitted.find((e) => e.operation === DELETION_EVIDENCE_RESOLVED_OPERATION);
    // A `sev1` here would be a false record of which grade was resolved — the same class of defect
    // the module exists to catch, in the module's own row.
    expect(entry?.after).toMatchObject({ severity: "sev3" });
  });
});
