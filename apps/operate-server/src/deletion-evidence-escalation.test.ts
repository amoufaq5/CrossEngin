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
  ESCALATION_SUBJECT_KINDS,
  RESOLVING_VERDICTS,
  SWEEP_EPISODE_PREFIX,
  TOMBSTONE_EPISODE_PREFIX,
  TOMBSTONE_SWEEP_SURFACE,
  deletionEvidenceKey,
  deletionEvidenceSweepKey,
  deletionEvidenceTombstoneKey,
  episodeKeyFor,
  escalationAuditEntity,
  severityForDefects,
  tombstoneFindingSubject,
  type EscalatableFinding,
  type EscalatableSweepStall,
  type EscalatableTombstoneFinding,
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
    {
      severity: "P0",
      channels: [{ kind: "pagerduty_phone", serviceKey: "deletion-oncall" }],
    },
    // A second route so a downgraded grade has somewhere else to land — the page must follow the
    // grade that was declared, not the configured default.
    {
      severity: "P2",
      channels: [{ kind: "slack", channel: "#deletion-evidence" }],
    },
    // Where a `sev2` lands, which is the whole point of grading a stalled sweep below `sev1`: the
    // grade *is* the route, so this is a different rotation from the tamper one above.
    {
      severity: "P1",
      channels: [{ kind: "webhook", url: "https://example.test/sweep" }],
    },
  ],
};

function configOf(over: Record<string, unknown> = {}) {
  return DeletionEscalationConfigSchema.parse({
    alertPolicy: ALERT_POLICY,
    ...over,
  });
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

function tombstoneFindingOf(
  over: Partial<EscalatableTombstoneFinding> = {},
): EscalatableTombstoneFinding {
  return {
    tombstoneId: TOMB,
    tenantId: TENANT,
    // The majority case this direction exists for: a proof the synchronous deletion route wrote,
    // which both request-shaped audits walk straight past.
    reference: "unreferenced",
    relatedDeletionRequestId: null,
    defects: ["scope_tampered"],
    detail: "does not verify: scope_tampered",
    ...over,
  };
}

interface EmittedEntry {
  readonly operation: string;
  readonly tenantId: string | null;
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
      tenantId: string | null;
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
  return {
    escalator,
    declared,
    findOpenKeys,
    closedOut,
    pages,
    directives,
    emitted,
    errors,
  };
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
    const config = configOf({
      severityByDefect: { unwitnessed: "sev3", proof_mismatch: "sev2" },
    });
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

  it("keys an evidence record no request names on the tombstone, namespaced", () => {
    expect(deletionEvidenceTombstoneKey(TOMB)).toBe(
      `${DELETION_EVIDENCE_SIGNAL}:${TOMBSTONE_EPISODE_PREFIX}${TOMB}`,
    );
    expect(TOMBSTONE_EPISODE_PREFIX).toBe("tombstone:");
  });

  it("derives both keys from the subject, so nothing picks one by hand", () => {
    expect(episodeKeyFor({ kind: "request", id: REQ })).toBe(deletionEvidenceKey(REQ));
    expect(episodeKeyFor({ kind: "tombstone", id: TOMB })).toBe(deletionEvidenceTombstoneKey(TOMB));
  });

  it("cannot confuse the two spaces, which is what the prefix is for", () => {
    // Both ids are opaque strings from different tables and nothing stops one from looking like the
    // other. An unprefixed tombstone key would adopt an incident declared about a different record
    // — the exact failure this module exists to prevent, in its own index.
    expect(deletionEvidenceTombstoneKey(TOMB)).not.toBe(deletionEvidenceKey(TOMB));
    expect(deletionEvidenceKey(`${TOMBSTONE_EPISODE_PREFIX}${TOMB}`)).toBe(
      deletionEvidenceTombstoneKey(TOMB),
    );
  });
});

describe("which handle a sweep finding keys on", () => {
  it("keys an unreferenced finding on the tombstone, because there is nothing else", () => {
    expect(tombstoneFindingSubject(tombstoneFindingOf())).toEqual({
      kind: "tombstone",
      id: TOMB,
    });
  });

  it("keys a referenced finding on its request, because they are one fact", () => {
    expect(
      tombstoneFindingSubject(
        tombstoneFindingOf({
          reference: "referenced",
          relatedDeletionRequestId: REQ,
        }),
      ),
    ).toEqual({ kind: "request", id: REQ });
  });

  it("keys a dangling finding on the tombstone, not on the request that is gone", () => {
    // Nothing can adopt an episode for a row that no longer exists — the request paths cannot reach
    // it — and the finding is about the proof, which is the thing still present and still wrong.
    expect(
      tombstoneFindingSubject(
        tombstoneFindingOf({
          reference: "dangling",
          relatedDeletionRequestId: REQ,
        }),
      ),
    ).toEqual({ kind: "tombstone", id: TOMB });
  });

  it("keys on the tombstone when the two fields disagree", () => {
    // What makes `requestId` on the outcome structurally unable to name a request that is not there:
    // the id is only used when the finding also says the request is reachable.
    expect(
      tombstoneFindingSubject(
        tombstoneFindingOf({
          reference: "referenced",
          relatedDeletionRequestId: null,
        }),
      ),
    ).toEqual({ kind: "tombstone", id: TOMB });
    expect(
      tombstoneFindingSubject(
        tombstoneFindingOf({
          reference: "unreferenced",
          relatedDeletionRequestId: REQ,
        }),
      ),
    ).toEqual({ kind: "tombstone", id: TOMB });
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

describe("onTombstoneFinding (ADR-0328)", () => {
  it("declares under the tombstone's key for a proof no request names", async () => {
    const h = harness();
    const outcome = await h.escalator.onTombstoneFinding(tombstoneFindingOf());
    expect(outcome.action).toBe("declared");
    expect(h.findOpenKeys).toEqual([deletionEvidenceTombstoneKey(TOMB)]);
    expect(h.declared[0]?.autoDeclaredFor).toBe(deletionEvidenceTombstoneKey(TOMB));
    expect(h.declared[0]?.severity).toBe("sev1");
    expect(h.declared[0]?.securityIncident).toBe(true);
    expect(h.declared[0]?.affectedTenantIds).toEqual([TENANT]);
    expect(h.pages).toEqual([`${INC}:1`]);
  });

  it("reports no request id for a tombstone episode rather than inventing one", async () => {
    const h = harness();
    const outcome = await h.escalator.onTombstoneFinding(tombstoneFindingOf());
    // The field is widened, not reused: a tombstone id in `requestId` would make the outcome claim
    // a request that does not exist, which is the class of false record this module catches.
    expect(outcome.requestId).toBeNull();
    expect(outcome.subject).toEqual({ kind: "tombstone", id: TOMB });
    expect(outcome.episodeKey).toBe(deletionEvidenceTombstoneKey(TOMB));
  });

  it("declares under the request's key when a live request names the tombstone", async () => {
    const h = harness();
    const outcome = await h.escalator.onTombstoneFinding(
      tombstoneFindingOf({
        reference: "referenced",
        relatedDeletionRequestId: REQ,
      }),
    );
    expect(outcome.action).toBe("declared");
    expect(outcome.requestId).toBe(REQ);
    expect(outcome.subject).toEqual({ kind: "request", id: REQ });
    expect(h.declared[0]?.autoDeclaredFor).toBe(deletionEvidenceKey(REQ));
  });

  it("adopts the incident its request already has open rather than declaring a second", async () => {
    // The test the whole design turns on. A tombstone and the request that names it are the same
    // fact, reached by three paths — `reconcileStranded`, `auditCompleted` and this sweep. Keying
    // every sweep finding on the tombstone would declare a second incident for one tampered row,
    // once per direction that noticed it.
    const asked: string[] = [];
    const declared: IncidentDeclarationRequest[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (request): Promise<IncidentRecord> => {
          declared.push(request);
          return incidentOf();
        },
        // Open for the REQUEST's key only. So an adoption here proves the sweep asked under that
        // key — not merely that the double is returned whatever is asked.
        findOpen: async (key): Promise<IncidentRecord | null> => {
          asked.push(key);
          return key === deletionEvidenceKey(REQ) ? incidentOf() : null;
        },
        closeOut: async (): Promise<IncidentCloseOut> => "cancelled",
      },
      config: configOf(),
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onTombstoneFinding(
      tombstoneFindingOf({
        reference: "referenced",
        relatedDeletionRequestId: REQ,
      }),
    );
    expect(asked).toEqual([deletionEvidenceKey(REQ)]);
    expect(outcome.action).toBe("adopted");
    expect(outcome.incidentId).toBe(INC);
    expect(declared).toEqual([]);
    // And the mirror: the same row reached by the other two directions still adopts, because all
    // three ask the same question.
    const viaAudit = await escalator.onAuditFinding(findingOf());
    const viaVerdict = await escalator.onVerdict(verdictOf());
    expect([viaAudit.action, viaVerdict.action]).toEqual(["adopted", "adopted"]);
    expect(declared).toEqual([]);
  });

  it("declares its own episode for a dangling proof, since nothing can adopt a vanished request", async () => {
    const h = harness();
    const outcome = await h.escalator.onTombstoneFinding(
      tombstoneFindingOf({
        reference: "dangling",
        relatedDeletionRequestId: REQ,
      }),
    );
    expect(outcome.action).toBe("declared");
    expect(outcome.requestId).toBeNull();
    expect(h.findOpenKeys).toEqual([deletionEvidenceTombstoneKey(TOMB)]);
  });

  it("names the tombstone and says plainly that the proof does not verify", async () => {
    const h = harness();
    await h.escalator.onTombstoneFinding(tombstoneFindingOf());
    expect(h.declared[0]?.title).toBe(
      `Deletion proof does not verify for unreferenced tombstone ${TOMB}`,
    );
    expect(h.declared[0]?.detail).toContain(TOMB);
    expect(h.declared[0]?.detail).toContain(TENANT);
    expect(h.declared[0]?.detail).toContain("scope_tampered");
  });

  it("does not claim a verification failure for an intact proof whose request is gone", async () => {
    const h = harness();
    await h.escalator.onTombstoneFinding(
      tombstoneFindingOf({
        reference: "dangling",
        relatedDeletionRequestId: REQ,
        defects: [],
        detail: `names deletion request ${REQ}, which does not exist`,
      }),
    );
    // A dangling finding is reported even when it verifies, so the usual sentence would be false.
    // A title that overstates the finding costs the credibility a sev1 depends on.
    expect(h.declared[0]?.title).toBe(
      `Deletion proof ${TOMB} names a deletion request that does not exist`,
    );
    expect(h.declared[0]?.title).not.toContain("does not verify");
  });

  it("carries nothing in the title or detail the other paths do not already carry", async () => {
    const h = harness();
    await h.escalator.onTombstoneFinding(tombstoneFindingOf());
    // Tenant id, tombstone id, reference state and defect names — the same vocabulary the verdict
    // and audit paths put in their own details. Nothing from inside the scope.
    const text = `${h.declared[0]?.title ?? ""} ${h.declared[0]?.detail ?? ""}`;
    expect(text).toContain("unreferenced");
    for (const leak of ["invoice", "rowsDeleted", "contentManifest", "proofSha256"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("grades per defect by the same rule as every other path", async () => {
    const graded = configOf({ severityByDefect: { unwitnessed: "sev3" } });
    const h = harness({}, graded);
    const outcome = await h.escalator.onTombstoneFinding(
      tombstoneFindingOf({ defects: ["unwitnessed"] }),
    );
    expect(outcome.severity).toBe("sev3");
    expect(h.declared[0]?.severity).toBe("sev3");
  });

  it("pages at the graded severity, over the route that grade chose", async () => {
    const graded = configOf({ severityByDefect: { unwitnessed: "sev3" } });
    const h = harness({}, graded);
    await h.escalator.onTombstoneFinding(tombstoneFindingOf({ defects: ["unwitnessed"] }));
    expect(h.directives[0]?.severity).toBe(h.declared[0]?.severity);
    expect(h.directives[0]?.alertSeverity).toBe("P2");
    expect(h.directives[0]?.channels[0]?.kind).toBe("slack");
  });

  it("falls back to the configured grade for a finding that reports no defects", async () => {
    const h = harness({}, configOf({ severityByDefect: { unwitnessed: "sev3" } }));
    const outcome = await h.escalator.onTombstoneFinding(
      tombstoneFindingOf({
        reference: "dangling",
        relatedDeletionRequestId: REQ,
        defects: [],
      }),
    );
    expect(outcome.severity).toBe("sev1");
    expect(h.directives[0]?.alertSeverity).toBe("P0");
  });

  it("files the anchored row against the tombstone, which is the record at fault", async () => {
    const h = harness();
    const outcome = await h.escalator.onTombstoneFinding(tombstoneFindingOf());
    expect(outcome.audited).toBe(true);
    const row = h.emitted[0];
    expect(row?.operation).toBe(DELETION_EVIDENCE_ESCALATED_OPERATION);
    expect(row?.tenantId).toBe(TENANT);
    // Filing it as a `GdprDeletionRequest` with a tombstone id would be a row whose entity and id
    // disagree — and an unreferenced tombstone has no request to file it under at all.
    expect(row?.entity).toBe("TenantTombstone");
    expect(row?.entityId).toBe(TOMB);
    expect(row?.after).toMatchObject({
      incidentId: INC,
      severity: "sev1",
      defects: ["scope_tampered"],
      tombstoneId: TOMB,
      reference: "unreferenced",
      verdict: null,
    });
  });

  it("still names the tombstone in a row filed under the request", async () => {
    const h = harness();
    await h.escalator.onTombstoneFinding(
      tombstoneFindingOf({
        reference: "referenced",
        relatedDeletionRequestId: REQ,
      }),
    );
    const row = h.emitted[0];
    expect(row?.entity).toBe("GdprDeletionRequest");
    expect(row?.entityId).toBe(REQ);
    // Without this the row would not name the proof that is wrong.
    expect(row?.after).toMatchObject({
      tombstoneId: TOMB,
      reference: "referenced",
    });
  });

  it("writes nothing when the episode is adopted", async () => {
    const h = harness({ open: incidentOf() });
    const outcome = await h.escalator.onTombstoneFinding(tombstoneFindingOf());
    expect(outcome.action).toBe("adopted");
    expect(outcome.audited).toBe(false);
    expect(h.emitted).toEqual([]);
  });

  it("reports a declarer failure, so the next lap re-derives it and retries", async () => {
    const errors: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (): Promise<IncidentRecord> => {
          throw new Error("incident store unreachable");
        },
        findOpen: async (): Promise<IncidentRecord | null> => null,
        closeOut: async (): Promise<IncidentCloseOut> => "cancelled",
      },
      config: configOf(),
      onError: (_e, id) => errors.push(id),
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onTombstoneFinding(tombstoneFindingOf());
    expect(outcome.action).toBe("failed");
    expect(outcome.incidentId).toBeNull();
    expect(outcome.subject).toEqual({ kind: "tombstone", id: TOMB });
    // The id names the row to go and look at, which for this episode is the tombstone.
    expect(errors).toEqual([TOMB]);
  });
});

describe("onTombstoneResolved (ADR-0328)", () => {
  it("closes out the tombstone's own episode and resolves its alert", async () => {
    const resolved: PageDirective[] = [];
    const asked: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (): Promise<IncidentRecord> => incidentOf(),
        findOpen: async (key): Promise<IncidentRecord | null> => {
          asked.push(key);
          return incidentOf(INC, "sev3");
        },
        closeOut: async (): Promise<IncidentCloseOut> => "cancelled",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page);
      },
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onTombstoneResolved(TOMB, TENANT);
    expect(asked).toEqual([deletionEvidenceTombstoneKey(TOMB)]);
    expect(outcome.action).toBe("closed_out");
    expect(outcome.closeOut).toBe("cancelled");
    expect(outcome.requestId).toBeNull();
    // Routed at the incident's own grade, so the resolve reaches exactly where the trigger did.
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.severity).toBe("sev3");
    expect(resolved[0]?.channels.map((c) => c.kind)).toEqual(["slack"]);
  });

  it("answers none for a tombstone whose episode belongs to its request", async () => {
    // A referenced finding escalated under the request's key, and the request path owns its
    // recovery — `onVerdict`'s resolving verdicts, which can actually see the request's status.
    // This asking and finding nothing open is correct, not a miss.
    const h = harness({ open: null });
    const outcome = await h.escalator.onTombstoneResolved(TOMB, TENANT);
    expect(outcome.action).toBe("none");
    expect(h.closedOut).toEqual([]);
    expect(h.findOpenKeys).toEqual([deletionEvidenceTombstoneKey(TOMB)]);
  });

  it("does not resolve the alert of an incident a human has triaged", async () => {
    const resolved: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (): Promise<IncidentRecord> => incidentOf(),
        findOpen: async (): Promise<IncidentRecord | null> => incidentOf(),
        closeOut: async (): Promise<IncidentCloseOut> => "human_owned",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page.incidentId);
      },
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onTombstoneResolved(TOMB, TENANT);
    expect(outcome.closeOut).toBe("human_owned");
    expect(resolved).toEqual([]);
  });

  it("records the resolution against the tombstone at its declared grade", async () => {
    const h = harness({ open: incidentOf(INC, "sev2") });
    const outcome = await h.escalator.onTombstoneResolved(TOMB, TENANT);
    expect(outcome.audited).toBe(true);
    const row = h.emitted[0];
    expect(row?.operation).toBe(DELETION_EVIDENCE_RESOLVED_OPERATION);
    expect(row?.entity).toBe("TenantTombstone");
    expect(row?.entityId).toBe(TOMB);
    expect(row?.after).toMatchObject({
      severity: "sev2",
      tombstoneId: TOMB,
      defects: [],
    });
  });

  it("reports a failed close-out rather than claiming the proof's episode closed", async () => {
    const h = harness({ open: incidentOf(), closeOutThrows: true });
    const outcome = await h.escalator.onTombstoneResolved(TOMB, TENANT);
    expect(outcome.action).toBe("failed");
    expect(outcome.closeOut).toBeNull();
    expect(outcome.subject).toEqual({ kind: "tombstone", id: TOMB });
  });
});

describe("a stalled sweep's episode key (ADR-0329)", () => {
  it("adds the sweep as a third subject kind", () => {
    // The first subject that is not a record. Every other finding here says "this proof is wrong";
    // this one says "no proof is being read", which is the one thing a findings surface cannot.
    expect(ESCALATION_SUBJECT_KINDS).toEqual(["request", "tombstone", "sweep"]);
  });

  it("keys per surface, under its own namespace", () => {
    expect(SWEEP_EPISODE_PREFIX).toBe("sweep:");
    expect(TOMBSTONE_SWEEP_SURFACE).toBe("tombstones");
    expect(deletionEvidenceSweepKey(TOMBSTONE_SWEEP_SURFACE)).toBe(
      `${DELETION_EVIDENCE_SIGNAL}:sweep:tombstones`,
    );
    expect(episodeKeyFor({ kind: "sweep", id: TOMBSTONE_SWEEP_SURFACE })).toBe(
      deletionEvidenceSweepKey(TOMBSTONE_SWEEP_SURFACE),
    );
  });

  it("cannot collide with a request or a tombstone episode", () => {
    // The request namespace is bare ids, so an unprefixed `sweep` key would be the episode of a
    // deletion request whose id is the string `sweep`. This module validates none of the three kinds
    // of id it is handed, which is exactly why the tombstone namespace is prefixed too.
    expect(deletionEvidenceSweepKey("x")).not.toBe(deletionEvidenceTombstoneKey("x"));
    expect(deletionEvidenceSweepKey("x")).not.toBe(deletionEvidenceKey("x"));
    const keys = new Set([
      deletionEvidenceKey("x"),
      deletionEvidenceTombstoneKey("x"),
      deletionEvidenceSweepKey("x"),
    ]);
    expect(keys.size).toBe(3);
    // The limit of the scheme, inherited rather than introduced: a prefix separates the spaces for
    // *bare* ids only. A request id literally spelled `sweep:tombstones` still collides, exactly as
    // one spelled `tombstone:<id>` has collided with the tombstone namespace since ADR-0328.
    expect(deletionEvidenceSweepKey("tombstones")).toBe(deletionEvidenceKey("sweep:tombstones"));
  });

  it("names each subject as its own table names it", () => {
    expect(escalationAuditEntity("request")).toBe("GdprDeletionRequest");
    expect(escalationAuditEntity("tombstone")).toBe("TenantTombstone");
    // A process rather than a row, and so not a table name — but total, so the mapping cannot be
    // asked a kind it has no answer for.
    expect(escalationAuditEntity("sweep")).toBe("TombstoneSweep");
    expect(new Set(ESCALATION_SUBJECT_KINDS.map(escalationAuditEntity)).size).toBe(3);
  });
});

describe("the grade a stalled sweep is declared at (ADR-0329)", () => {
  it("defaults to sev2, below the tamper grade", () => {
    const config = configOf();
    expect(config.sweepStallSeverity).toBe("sev2");
    // Deliberately not the same value: `severity` is for a detected falsified proof, a fact in hand.
    expect(config.severity).toBe("sev1");
  });

  it("takes an explicit grade", () => {
    expect(configOf({ sweepStallSeverity: "sev3" }).sweepStallSeverity).toBe("sev3");
  });

  it("refuses a grade it cannot parse rather than falling back to the default", () => {
    // There is one value rather than a map here, so an ignored typo would route *every* stall to the
    // configured `severity` — the tamper rotation — which is the outcome the field exists to avoid.
    expect(() => configOf({ sweepStallSeverity: "sev9" })).toThrow();
    expect(() => configOf({ sweepStallSeverity: "SEV2" })).toThrow();
    expect(() => configOf({ sweepStallSeverity: 2 })).toThrow();
    expect(() => configOf({ sweepStallSeverity: null })).toThrow();
  });

  it("is not reachable through severityForDefects, which would answer the tamper grade", () => {
    // A stall has no defects, so the defect grader falls through to `config.severity`. That is the
    // reason the stall path carries its own grade instead of sharing the grader.
    expect(severityForDefects([], configOf())).toBe("sev1");
  });
});

describe("onSweepStall (ADR-0329)", () => {
  const STALL: EscalatableSweepStall = {
    kind: "pinned_cursor",
    attemptsWithoutAdvance: 3,
    pagesWithoutAdvance: 3,
    lastAdvanceAt: "2026-10-04T00:00:00.000Z",
    cursor: TOMB,
    detail: "3 pages came back over 3 attempts without moving past tomb_aaaabbbbccccdddd",
  };

  it("declares at the stall grade and pages the route that grade chooses", async () => {
    const h = harness();
    const outcome = await h.escalator.onSweepStall(STALL);
    expect(h.findOpenKeys).toEqual([deletionEvidenceSweepKey(TOMBSTONE_SWEEP_SURFACE)]);
    expect(outcome.action).toBe("declared");
    expect(outcome.severity).toBe("sev2");
    expect(h.declared[0]?.severity).toBe("sev2");
    // The grade is the route (ADR-0326), so grading this below a tamper is what keeps it off the
    // rotation a falsified Article 17 proof pages. A sev1 finding reaches `pagerduty_phone`.
    expect(outcome.page?.alertSeverity).toBe("P1");
    expect(outcome.page?.channels.map((c) => c.kind)).toEqual(["webhook"]);
  });

  it("declares at a configured grade instead", async () => {
    const h = harness({}, configOf({ sweepStallSeverity: "sev3" }));
    const outcome = await h.escalator.onSweepStall(STALL);
    expect(outcome.severity).toBe("sev3");
    expect(outcome.page?.channels.map((c) => c.kind)).toEqual(["slack"]);
  });

  it("does not declare a security incident", async () => {
    const h = harness();
    await h.escalator.onSweepStall(STALL);
    // `securityIncident` gates `breachDataClasses` and marks the record for the compliance surfaces
    // that read it. A detected tamper is one; having stopped looking says nothing about whether
    // anything happened, and declaring it one would start a breach assessment over a monitoring gap.
    expect(h.declared[0]?.securityIncident).toBe(false);
    expect(h.declared[0]?.affectedTenantIds ?? []).toEqual([]);
  });

  it("carries the kind in what a responder reads and never in the key", async () => {
    const h = harness();
    const outcome = await h.escalator.onSweepStall(STALL);
    const declared = h.declared[0];
    expect(declared?.autoDeclaredFor).toBe(deletionEvidenceSweepKey(TOMBSTONE_SWEEP_SURFACE));
    // A title is written once and never again, so one naming `pinned_cursor` would still say so
    // after the condition had become `no_pages`. The kind goes in the detail, read as the moment.
    expect(declared?.title).not.toContain("pinned_cursor");
    expect(declared?.title).toContain("tombstones");
    expect(declared?.detail).toContain("pinned_cursor");
    expect(outcome.detail).toContain(STALL.detail);
  });

  it("is one episode across a database that flips between the two kinds", async () => {
    let open: IncidentRecord | null = null;
    const asked: string[] = [];
    const declared: IncidentDeclarationRequest[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (request): Promise<IncidentRecord> => {
          declared.push(request);
          open = incidentOf(INC, "sev2");
          return open;
        },
        findOpen: async (key): Promise<IncidentRecord | null> => {
          asked.push(key);
          return open;
        },
        closeOut: async (): Promise<IncidentCloseOut> => "cancelled",
      },
      config: configOf(),
      clock: () => new Date(AT),
    });
    const first = await escalator.onSweepStall(STALL);
    const second = await escalator.onSweepStall({ ...STALL, kind: "no_pages", cursor: null });
    const third = await escalator.onSweepStall({ ...STALL, kind: "pinned_cursor" });
    // A half-up database flips between the two kinds from one audit tick to the next, and that is
    // one episode with one cause. A kind in the key would declare a second incident and page a
    // second time for a flap — ADR-0328's mistake, in a new place.
    expect([first.action, second.action, third.action]).toEqual([
      "declared",
      "adopted",
      "adopted",
    ]);
    expect(declared).toHaveLength(1);
    expect(new Set(asked).size).toBe(1);
  });

  it("takes a named surface, so a second sweep is a second episode", async () => {
    const h = harness();
    const outcome = await h.escalator.onSweepStall({ ...STALL, surface: "audit-chain" });
    expect(outcome.subject).toEqual({ kind: "sweep", id: "audit-chain" });
    expect(outcome.episodeKey).toBe(deletionEvidenceSweepKey("audit-chain"));
    expect(outcome.episodeKey).not.toBe(deletionEvidenceSweepKey(TOMBSTONE_SWEEP_SURFACE));
  });

  it("names no request, because it is not about one", async () => {
    const h = harness();
    const outcome = await h.escalator.onSweepStall(STALL);
    expect(outcome.requestId).toBeNull();
    expect(outcome.subject.kind).toBe("sweep");
  });

  it("leaves a PLATFORM-scope audit row, carrying the stall figures (ADR-0331)", async () => {
    const h = harness();
    const outcome = await h.escalator.onSweepStall(STALL);
    // A sweep walks every tenant's proofs, so a stall is about the walk and not about a row. It is
    // filed as `tenant_id IS NULL` — not under a borrowed tenant (ADR-0327's rejected Option B)
    // and no longer dropped. The figures were already composed here for this day.
    expect(outcome.audited).toBe(true);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.tenantId).toBeNull();
    expect(h.emitted[0]?.after).toMatchObject({
      stallKind: STALL.kind,
      attemptsWithoutAdvance: STALL.attemptsWithoutAdvance,
      cursor: STALL.cursor,
    });
    expect(outcome.incidentId).toBe(INC);
    expect(h.pages).toHaveLength(1);
  });

  it("still reports audited=false when no emitter is wired", async () => {
    const h = harness({ audit: "off" });
    expect((await h.escalator.onSweepStall(STALL)).audited).toBe(false);
  });

  it("reports audited=false when the platform row cannot be written, without failing the escalation", async () => {
    const h = harness({ audit: "throws" });
    const outcome = await h.escalator.onSweepStall(STALL);
    expect(outcome.action).toBe("declared");
    expect(outcome.audited).toBe(false);
  });

  it("reports a failed declaration rather than throwing, so the next tick retries", async () => {
    const subjects: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (): Promise<IncidentRecord> => {
          throw new Error("incident store unreachable");
        },
        findOpen: async (): Promise<IncidentRecord | null> => null,
        closeOut: async (): Promise<IncidentCloseOut> => "cancelled",
      },
      config: configOf(),
      onError: (_err, subjectId) => subjects.push(subjectId),
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onSweepStall(STALL);
    expect(outcome.action).toBe("failed");
    expect(outcome.incidentId).toBeNull();
    expect(outcome.page).toBeNull();
    // The subject's id, not a request id: an error line reading `tomb_…` or a request id for a
    // stall would name the wrong thing to go and look at.
    expect(subjects).toEqual([TOMBSTONE_SWEEP_SURFACE]);
  });

  it("does not page when the policy has no route for the stall grade", async () => {
    const h = harness(
      {},
      DeletionEscalationConfigSchema.parse({
        alertPolicy: {
          id: "ap_tamper_only",
          routes: [{ severity: "P0", channels: [{ kind: "pagerduty_phone", serviceKey: "k" }] }],
        },
      }),
    );
    const outcome = await h.escalator.onSweepStall(STALL);
    // A deployment that routes only the tamper grade gets the incident and no page, which is the
    // honest outcome of "the grade is the route" — it is not quietly promoted to a route that exists.
    expect(outcome.action).toBe("declared");
    expect(outcome.page).toBeNull();
    expect(h.pages).toEqual([]);
  });
});

describe("onSweepRecovered (ADR-0329)", () => {
  it("closes out the sweep's episode and resolves its alert at the declared grade", async () => {
    const resolved: PageDirective[] = [];
    const asked: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (): Promise<IncidentRecord> => incidentOf(),
        findOpen: async (key): Promise<IncidentRecord | null> => {
          asked.push(key);
          return incidentOf(INC, "sev2");
        },
        closeOut: async (): Promise<IncidentCloseOut> => "cancelled",
      },
      config: configOf(),
      resolvePage: (page) => {
        resolved.push(page);
      },
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onSweepRecovered();
    expect(asked).toEqual([deletionEvidenceSweepKey(TOMBSTONE_SWEEP_SURFACE)]);
    expect(outcome.action).toBe("closed_out");
    expect(outcome.closeOut).toBe("cancelled");
    expect(outcome.severity).toBe("sev2");
    // A resolve reaches exactly where its trigger did, or it closes nothing (ADR-0326).
    expect(resolved.map((p) => p.alertSeverity)).toEqual(["P1"]);
    expect(outcome.detail).toContain("advanced the cursor");
  });

  it("answers none when nothing is open, so a caller may retry it", async () => {
    const h = harness({ open: null });
    const outcome = await h.escalator.onSweepRecovered();
    expect(outcome.action).toBe("none");
    expect(h.closedOut).toEqual([]);
    expect(outcome.subject).toEqual({ kind: "sweep", id: TOMBSTONE_SWEEP_SURFACE });
  });

  it("resolves the surface it is given and not the default", async () => {
    const h = harness({ open: incidentOf(INC, "sev2") });
    const outcome = await h.escalator.onSweepRecovered("audit-chain");
    expect(h.findOpenKeys).toEqual([deletionEvidenceSweepKey("audit-chain")]);
    expect(outcome.subject.id).toBe("audit-chain");
  });

  it("does not resolve the alert of an incident a human has triaged", async () => {
    const h = harness({ open: incidentOf(INC, "sev2"), closeOut: "human_owned" });
    const outcome = await h.escalator.onSweepRecovered();
    expect(outcome.closeOut).toBe("human_owned");
    expect(outcome.action).toBe("closed_out");
  });

  it("leaves a platform-scope audit row for the recovery too", async () => {
    const h = harness({ open: incidentOf(INC, "sev2") });
    const outcome = await h.escalator.onSweepRecovered();
    expect(outcome.audited).toBe(true);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.tenantId).toBeNull();
    // The grade is read off the record rather than re-derived, which is unchanged by the scope.
    expect(h.emitted[0]?.after).toMatchObject({ severity: "sev2" });
  });

  it("reports a failed close-out rather than claiming the episode closed", async () => {
    const subjects: string[] = [];
    const escalator = new DeletionEvidenceEscalator({
      declarer: {
        declare: async (): Promise<IncidentRecord> => incidentOf(),
        findOpen: async (): Promise<IncidentRecord | null> => incidentOf(INC, "sev2"),
        closeOut: async (): Promise<IncidentCloseOut> => {
          throw new Error("close-out failed");
        },
      },
      config: configOf(),
      onError: (_err, subjectId) => subjects.push(subjectId),
      clock: () => new Date(AT),
    });
    const outcome = await escalator.onSweepRecovered();
    expect(outcome.action).toBe("failed");
    expect(outcome.closeOut).toBeNull();
    expect(subjects).toEqual([TOMBSTONE_SWEEP_SURFACE]);
  });
});
