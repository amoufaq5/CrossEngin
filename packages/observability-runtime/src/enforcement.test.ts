import { describe, expect, it } from "vitest";
import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";
import {
  CountingIncidentDeclarer,
  FixedClock,
  IncidentExecutor,
  type IncidentCloseOut,
  type IncidentCloseOutInput,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
} from "@crossengin/incident-response-runtime";
import { KillSwitchSchema } from "@crossengin/feature-flags";
import type { AlertPolicy } from "@crossengin/observability";
import {
  FlagRollbackSchema,
  SEVERITY_TO_ALERT_SEVERITY,
  alertSeverityFor,
  closeOutEnforcementIncident,
  declareEnforcementIncident,
  enforcementDeclarationRequest,
  findAdoptedKillSwitch,
  findOpenEnforcementIncident,
  formatIncidentId,
  formatKillSwitchId,
  killSwitchIdForIncident,
  planIncidentDeclaration,
  planKillSwitchActivation,
  planPageDirective,
  type DeclarationFailure,
} from "./enforcement.js";

const NOW = "2026-06-02T12:00:00.000Z";
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";

const policy: AlertPolicy = {
  id: "default",
  routes: [
    { severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "svc-oncall" }] },
    {
      severity: "P2",
      channels: [{ kind: "slack", channel: "#alerts" }],
    },
  ],
};

describe("severity mapping", () => {
  it("maps every incident severity to an alert severity", () => {
    expect(Object.keys(SEVERITY_TO_ALERT_SEVERITY)).toHaveLength(5);
    expect(alertSeverityFor("sev1")).toBe("P0");
    expect(alertSeverityFor("sev2")).toBe("P1");
    expect(alertSeverityFor("sev5")).toBe("P3");
  });
});

describe("id formatting", () => {
  it("formats incident ids matching INC-YYYY-NNNN", () => {
    expect(formatIncidentId(2026, 42)).toBe("INC-2026-0042");
    expect(formatIncidentId(2026, 42)).toMatch(/^INC-\d{4}-\d{4,8}$/);
  });
  it("formats kill switch ids matching the feature-flag pattern", () => {
    expect(formatKillSwitchId(7)).toBe("fks_auto00000007");
    expect(formatKillSwitchId(7)).toMatch(/^fks_[a-z0-9]{8,40}$/);
  });
  it("rejects invalid sequences", () => {
    expect(() => formatIncidentId(2026, -1)).toThrow();
    expect(() => formatKillSwitchId(-1)).toThrow();
  });
});

describe("FlagRollbackSchema", () => {
  it("accepts a valid rollback", () => {
    expect(
      FlagRollbackSchema.safeParse({ flagId: "ff_checkout01", safeValueJson: "false" }).success,
    ).toBe(true);
  });
  it("rejects invalid JSON", () => {
    expect(
      FlagRollbackSchema.safeParse({ flagId: "ff_checkout01", safeValueJson: "{bad" }).success,
    ).toBe(false);
  });
  it("rejects a malformed flag id", () => {
    expect(
      FlagRollbackSchema.safeParse({ flagId: "checkout", safeValueJson: "false" }).success,
    ).toBe(false);
  });
});

describe("planIncidentDeclaration", () => {
  it("builds a schema-valid declared incident", () => {
    const incident = planIncidentDeclaration({
      incidentId: "INC-2026-0001",
      title: "SLO burn alert",
      severity: "sev2",
      surface: "POST /v1/orders",
      nowIso: NOW,
      declaredBy: "system-slo-enforcer",
      detail: "auto-declared after burst",
    });
    expect(IncidentRecordSchema.safeParse(incident).success).toBe(true);
    expect(incident.status).toBe("declared");
    expect(incident.category).toBe("availability");
    expect(incident.timeline).toHaveLength(1);
    expect(incident.timeline[0]?.metadata).toMatchObject({ surface: "POST /v1/orders" });
  });

  it("honours an explicit category and affected tenants", () => {
    const incident = planIncidentDeclaration({
      incidentId: "INC-2026-0002",
      title: "t",
      severity: "sev1",
      category: "performance",
      surface: "s",
      nowIso: NOW,
      declaredBy: "system",
      affectedTenantIds: ["11111111-1111-1111-1111-111111111111"],
      detail: "d",
    });
    expect(incident.category).toBe("performance");
    expect(incident.affectedTenantIds).toHaveLength(1);
  });
});

describe("planPageDirective", () => {
  it("resolves channels for a mapped severity", () => {
    const page = planPageDirective(policy, "sev2", "INC-2026-0001");
    expect(page).not.toBeNull();
    expect(page?.alertSeverity).toBe("P1");
    expect(page?.channels[0]?.kind).toBe("pagerduty_phone");
  });

  it("returns null when no route exists for the severity", () => {
    expect(planPageDirective(policy, "sev1", "INC-2026-0001")).toBeNull();
  });
});

describe("planKillSwitchActivation", () => {
  it("builds a schema-valid triggered kill switch", () => {
    const ks = planKillSwitchActivation({
      killSwitchId: "fks_auto00000001",
      flagId: "ff_checkout01",
      safeValueJson: "false",
      tenantId: null,
      systemActorUserId: SYSTEM_ACTOR,
      incidentId: "INC-2026-0001",
      nowIso: NOW,
      justification: "SLO enforcement rolled back the checkout flag after a burn.",
    });
    expect(KillSwitchSchema.safeParse(ks).success).toBe(true);
    expect(ks.status).toBe("triggered_active");
    expect(ks.triggerKind).toBe("automated_metric_breach");
    expect(ks.relatedIncidentId).toBe("INC-2026-0001");
    expect(ks.triggeredByUserId).toBe(SYSTEM_ACTOR);
  });

  it("does not require four-eyes for automated breaches", () => {
    const ks = planKillSwitchActivation({
      killSwitchId: "fks_auto00000002",
      flagId: "ff_checkout01",
      safeValueJson: "0",
      tenantId: null,
      systemActorUserId: SYSTEM_ACTOR,
      incidentId: "INC-2026-0003",
      nowIso: NOW,
      justification: "Automated rollback with no human co-signer required here.",
    });
    expect(ks.coTriggeredByUserId).toBeNull();
  });
});

const DECLARATION = {
  title: "SLO burn alert: orders-availability on POST /v1/orders",
  severity: "sev2",
  category: "availability",
  surface: "POST /v1/orders",
  nowIso: NOW,
  declaredBy: "system-slo-enforcer",
  detail: "Auto-declared by SLO enforcement (page): burn 20.0x over 1h / 20.0x over 5m.",
} as const;

class RefusingDeclarer implements IncidentDeclarer {
  constructor(private readonly error = new Error("store unreachable")) {}
  async declare(): Promise<IncidentRecord> {
    throw this.error;
  }
  async findOpen(): Promise<IncidentRecord | null> {
    throw this.error;
  }
  async closeOut(): Promise<IncidentCloseOut> {
    throw this.error;
  }
}

class RecordingDeclarer implements IncidentDeclarer {
  readonly closeOuts: { id: string; input: IncidentCloseOutInput }[] = [];
  readonly declared: IncidentDeclarationRequest[] = [];
  readonly lookups: string[] = [];
  constructor(
    private readonly outcome: IncidentCloseOut = "cancelled",
    private readonly open: IncidentRecord | null = null,
  ) {}
  async findOpen(key: string): Promise<IncidentRecord | null> {
    this.lookups.push(key);
    return this.open;
  }
  async declare(request: IncidentDeclarationRequest): Promise<IncidentRecord> {
    this.declared.push(request);
    return new IncidentExecutor({ clock: new FixedClock(new Date(NOW)) }).declare({
      ...request,
      id: "INC-2026-0042",
    });
  }
  async closeOut(id: string, input: IncidentCloseOutInput): Promise<IncidentCloseOut> {
    this.closeOuts.push({ id, input });
    return this.outcome;
  }
}

const FAILURE: Omit<DeclarationFailure, "phase"> = {
  surface: "POST /v1/orders",
  sloId: "orders-availability",
};

describe("enforcementDeclarationRequest", () => {
  it("builds the record planIncidentDeclaration builds, for the same inputs", async () => {
    // Pins the equivalence the declarer seam depends on: an auto-declared incident must not look
    // different depending on whether its id came from a counter or from the rows that exist.
    const planned = planIncidentDeclaration({ ...DECLARATION, incidentId: "INC-2026-0042" });
    const viaDeclarer = await new RecordingDeclarer().declare(
      enforcementDeclarationRequest(DECLARATION),
    );
    expect(viaDeclarer).toEqual(planned);
  });

  it("defaults the category to availability, as the planner does", () => {
    const { category: _omitted, ...withoutCategory } = DECLARATION;
    expect(enforcementDeclarationRequest(withoutCategory).category).toBe("availability");
  });

  it("carries the surface into the declaration entry's metadata", () => {
    expect(enforcementDeclarationRequest(DECLARATION).metadata).toEqual({
      surface: "POST /v1/orders",
      autoDeclared: true,
    });
  });

  it("declares at the evaluation time, not at some later now", () => {
    expect(enforcementDeclarationRequest(DECLARATION).declaredAt).toBe(NOW);
  });

  it("passes affected tenants through, empty by default", () => {
    expect(enforcementDeclarationRequest(DECLARATION).affectedTenantIds).toEqual([]);
    expect(
      enforcementDeclarationRequest({ ...DECLARATION, affectedTenantIds: ["t1"] })
        .affectedTenantIds,
    ).toEqual(["t1"]);
  });
});

describe("declareEnforcementIncident", () => {
  it("returns the record the declarer chose an id for", async () => {
    const record = await declareEnforcementIncident(
      new CountingIncidentDeclarer({ clock: new FixedClock(new Date(NOW)) }),
      DECLARATION,
      FAILURE,
    );
    expect(record?.id).toBe("INC-2026-0001");
  });

  it("reports a refusal instead of throwing, so the pass survives it", async () => {
    const seen: DeclarationFailure[] = [];
    const record = await declareEnforcementIncident(
      new RefusingDeclarer(),
      DECLARATION,
      FAILURE,
      (_err, failure) => seen.push(failure),
    );
    expect(record).toBeNull();
    expect(seen).toEqual([{ ...FAILURE, phase: "declare" }]);
  });

  it("hands the error itself to the sink", async () => {
    const boom = new Error("store unreachable");
    const errors: unknown[] = [];
    await declareEnforcementIncident(
      new RefusingDeclarer(boom),
      DECLARATION,
      FAILURE,
      (err) => errors.push(err),
    );
    expect(errors).toEqual([boom]);
  });

  it("swallows a refusal silently when no sink is wired", async () => {
    await expect(
      declareEnforcementIncident(new RefusingDeclarer(), DECLARATION, FAILURE),
    ).resolves.toBeNull();
  });
});

describe("closeOutEnforcementIncident", () => {
  it("passes the incident id, reason and time to the declarer", async () => {
    const declarer = new RecordingDeclarer();
    const outcome = await closeOutEnforcementIncident(
      declarer,
      "INC-2026-0042",
      { reason: "burn recovered", actorUserId: "system-slo-enforcer", at: NOW },
      FAILURE,
    );
    expect(outcome).toBe("cancelled");
    expect(declarer.closeOuts).toEqual([
      {
        id: "INC-2026-0042",
        input: { reason: "burn recovered", actorUserId: "system-slo-enforcer", at: NOW },
      },
    ]);
  });

  it("reports what the declarer reports, including a human-owned incident", async () => {
    expect(
      await closeOutEnforcementIncident(
        new RecordingDeclarer("human_owned"),
        "INC-2026-0042",
        { reason: "r", actorUserId: "a", at: NOW },
        FAILURE,
      ),
    ).toBe("human_owned");
  });

  it("reports failed rather than throwing, leaving the row open for a human", async () => {
    const seen: DeclarationFailure[] = [];
    const outcome = await closeOutEnforcementIncident(
      new RefusingDeclarer(),
      "INC-2026-0042",
      { reason: "r", actorUserId: "a", at: NOW },
      FAILURE,
      (_err, failure) => seen.push(failure),
    );
    expect(outcome).toBe("failed");
    expect(seen).toEqual([{ ...FAILURE, phase: "close_out" }]);
  });
});

describe("findOpenEnforcementIncident", () => {
  it("returns the incident the signal already has open", async () => {
    const existing = await new RecordingDeclarer().declare(
      enforcementDeclarationRequest(DECLARATION),
    );
    const declarer = new RecordingDeclarer("cancelled", existing);
    const found = await findOpenEnforcementIncident(declarer, "availability:x", FAILURE);
    expect(found?.id).toBe(existing.id);
    expect(declarer.lookups).toEqual(["availability:x"]);
  });

  it("reads nothing open when the signal has no incident", async () => {
    expect(
      await findOpenEnforcementIncident(new RecordingDeclarer(), "availability:x", FAILURE),
    ).toBeNull();
  });

  it("reads a failed lookup as nothing open, and reports it", async () => {
    // Risking a duplicate incident is the safe direction, and the partial unique index refuses the
    // duplicate anyway — a lookup that throws must not stop the breach being handled.
    const seen: DeclarationFailure[] = [];
    const found = await findOpenEnforcementIncident(
      new RefusingDeclarer(),
      "availability:x",
      FAILURE,
      (_err, failure) => seen.push(failure),
    );
    expect(found).toBeNull();
    expect(seen).toEqual([{ ...FAILURE, phase: "find_open" }]);
  });
});

describe("the autoDeclaredFor key on a declaration", () => {
  it("is carried into the request when supplied", () => {
    expect(
      enforcementDeclarationRequest({ ...DECLARATION, autoDeclaredFor: "availability:x" })
        .autoDeclaredFor,
    ).toBe("availability:x");
  });

  it("is absent when no signal was named, so a human declaration has no key", () => {
    expect(enforcementDeclarationRequest(DECLARATION).autoDeclaredFor).toBeUndefined();
  });

  it("reaches the record the planner builds", () => {
    expect(
      planIncidentDeclaration({
        ...DECLARATION,
        incidentId: "INC-2026-0042",
        autoDeclaredFor: "availability:x",
      }).autoDeclaredFor,
    ).toBe("availability:x");
  });

  it("is null on a planned record with no signal", () => {
    expect(
      planIncidentDeclaration({ ...DECLARATION, incidentId: "INC-2026-0042" }).autoDeclaredFor,
    ).toBeNull();
  });
});

describe("findAdoptedKillSwitch", () => {
  it("returns what the lookup holds for that incident", async () => {
    const asked: string[] = [];
    const found = await findAdoptedKillSwitch(
      {
        findForIncident: async (id) => {
          asked.push(id);
          return "fks_auto00000007";
        },
      },
      "INC-2026-0042",
      FAILURE,
    );
    expect(found).toBe("fks_auto00000007");
    expect(asked).toEqual(["INC-2026-0042"]);
  });

  it("returns null when the incident rolled nothing back", async () => {
    expect(
      await findAdoptedKillSwitch({ findForIncident: async () => null }, "INC-2026-0042", FAILURE),
    ).toBeNull();
  });

  it("returns null when no lookup is wired, without asking anything", async () => {
    expect(await findAdoptedKillSwitch(undefined, "INC-2026-0042", FAILURE)).toBeNull();
  });

  it("reports a failed lookup rather than letting it stop an adoption", async () => {
    // Refusing to adopt over an unreadable kill switch would re-declare the incident — a real
    // problem traded for a cosmetic one.
    const seen: DeclarationFailure[] = [];
    const found = await findAdoptedKillSwitch(
      {
        findForIncident: async () => {
          throw new Error("kill switch store unreachable");
        },
      },
      "INC-2026-0042",
      FAILURE,
      (_err, failure) => seen.push(failure),
    );
    expect(found).toBeNull();
    expect(seen).toEqual([{ ...FAILURE, phase: "find_kill_switch" }]);
  });

  it("swallows a failed lookup silently when no sink is wired", async () => {
    await expect(
      findAdoptedKillSwitch(
        {
          findForIncident: async () => {
            throw new Error("nope");
          },
        },
        "INC-2026-0042",
        FAILURE,
      ),
    ).resolves.toBeNull();
  });
});

describe("killSwitchIdForIncident", () => {
  it("derives the id from the incident, so it inherits the incident's uniqueness", () => {
    expect(killSwitchIdForIncident("INC-2026-0002")).toBe("fks_20260002");
  });

  it("gives two incidents two ids, which a per-process counter did not", () => {
    // Measured live: a second engine instance reissued `fks_auto00000001`, the unique constraint
    // refused the insert, and the failure landed after the incident had already been declared.
    expect(killSwitchIdForIncident("INC-2026-0002")).not.toBe(
      killSwitchIdForIncident("INC-2026-0003"),
    );
  });

  it("is stable for the same incident, so a retry does not mint a second switch", () => {
    expect(killSwitchIdForIncident("INC-2026-0002")).toBe(killSwitchIdForIncident("INC-2026-0002"));
  });

  it("satisfies the kill-switch id pattern the contract and the column both enforce", () => {
    for (const id of ["INC-2026-0001", "INC-2026-9999", "INC-2030-12345678"]) {
      expect(killSwitchIdForIncident(id)).toMatch(/^fks_[a-z0-9]{8,40}$/);
    }
  });

  it("refuses an id that is not an incident id, rather than inventing a switch id", () => {
    expect(() => killSwitchIdForIncident("not-an-incident")).toThrow();
  });
});
