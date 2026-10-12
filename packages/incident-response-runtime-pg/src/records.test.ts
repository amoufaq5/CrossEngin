import { describe, expect, it } from "vitest";
import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";

import {
  INCIDENT_COLUMNS,
  INCIDENT_COLUMN_NAMES,
  INCIDENT_JSONB_COLUMNS,
  IncidentTimelineRewriteError,
  assertAppendOnly,
  incidentPlaceholders,
  incidentRowValues,
  incidentUpdateAssignments,
  rowToIncident,
} from "./records.js";
import { T0, declaredIncident, incidentRow } from "./test-fakes.js";

describe("INCIDENT_COLUMN_NAMES", () => {
  it("has no duplicates", () => {
    expect(new Set(INCIDENT_COLUMN_NAMES).size).toBe(INCIDENT_COLUMN_NAMES.length);
  });

  it("starts with incident_id, the key an UPDATE matches on", () => {
    expect(INCIDENT_COLUMN_NAMES[0]).toBe("incident_id");
  });

  it("joins into the column list", () => {
    expect(INCIDENT_COLUMNS).toBe(INCIDENT_COLUMN_NAMES.join(", "));
  });

  it("names every JSONB column it claims", () => {
    for (const col of INCIDENT_JSONB_COLUMNS) {
      expect(INCIDENT_COLUMN_NAMES).toContain(col);
    }
  });
});

describe("incidentRowValues", () => {
  it("supplies exactly one value per column", () => {
    expect(incidentRowValues(declaredIncident(), 1, T0)).toHaveLength(
      INCIDENT_COLUMN_NAMES.length,
    );
  });

  it("derives year and sequence_number from the incident id", () => {
    const values = incidentRowValues(declaredIncident(), 1, T0);
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("year")]).toBe(2026);
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("sequence_number")]).toBe(7);
  });

  it("serializes the JSONB columns as strings", () => {
    const values = incidentRowValues(declaredIncident(), 1, T0);
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("timeline")]).toBeTypeOf("string");
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("affected_tenant_ids")]).toBe("[]");
  });

  it("writes the revision it is given", () => {
    const values = incidentRowValues(declaredIncident(), 4, T0);
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("revision")]).toBe(4);
  });

  it("nulls the optional text fields when absent", () => {
    const values = incidentRowValues(declaredIncident(), 1, T0);
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("root_cause")]).toBeNull();
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("cancelled_reason")]).toBeNull();
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("customer_impact_summary")]).toBeNull();
  });

  it("keeps declaredBy as the string the contract holds", () => {
    const values = incidentRowValues(declaredIncident(), 1, T0);
    expect(values[INCIDENT_COLUMN_NAMES.indexOf("declared_by")]).toBe("operate-server");
  });

  it("rejects a record the contract would not accept", () => {
    const bad = { ...declaredIncident(), id: "nope" };
    expect(() => incidentRowValues(bad as never, 1, T0)).toThrow();
  });
});

describe("incidentPlaceholders", () => {
  it("numbers every column from $1", () => {
    const parts = incidentPlaceholders().split(", ");
    expect(parts).toHaveLength(INCIDENT_COLUMN_NAMES.length);
    expect(parts[0]).toBe("$1");
  });

  it("casts exactly the JSONB columns", () => {
    const parts = incidentPlaceholders().split(", ");
    INCIDENT_COLUMN_NAMES.forEach((col, i) => {
      expect(parts[i]?.endsWith("::jsonb")).toBe(INCIDENT_JSONB_COLUMNS.has(col));
    });
  });
});

describe("incidentUpdateAssignments", () => {
  it("skips the key column and starts at $2", () => {
    const parts = incidentUpdateAssignments().split(", ");
    expect(parts).toHaveLength(INCIDENT_COLUMN_NAMES.length - 1);
    expect(parts[0]).toBe("year = $2");
  });

  it("never assigns incident_id", () => {
    expect(incidentUpdateAssignments()).not.toContain("incident_id =");
  });

  it("keeps each column on the placeholder its value is bound to", () => {
    const parts = incidentUpdateAssignments().split(", ");
    INCIDENT_COLUMN_NAMES.slice(1).forEach((col, i) => {
      expect(parts[i]).toContain(`${col} = $${i + 2}`);
    });
  });
});

describe("rowToIncident", () => {
  it("round-trips a declared incident", () => {
    const record = declaredIncident();
    expect(rowToIncident(incidentRow(record)).record).toEqual(record);
  });

  it("carries the revision and updatedAt back", () => {
    const stored = rowToIncident(incidentRow(declaredIncident(), 3, T0));
    expect(stored.revision).toBe(3);
    expect(stored.updatedAt).toBe(T0);
  });

  it("round-trips a closed incident with every optional field set", () => {
    const record = IncidentRecordSchema.parse({
      ...declaredIncident(),
      roleAssignments: [
        { role: "incident_commander", userId: "a", assignedAt: T0 },
        { role: "scribe", userId: "b", assignedAt: T0 },
        { role: "comms_lead", userId: "c", assignedAt: T0 },
      ],
      status: "closed",
      ackedAt: "2026-09-30T10:01:00.000Z",
      mitigatedAt: "2026-09-30T10:02:00.000Z",
      resolvedAt: "2026-09-30T10:03:00.000Z",
      closedAt: "2026-09-30T10:04:00.000Z",
      rootCause: "bad deploy",
      customerImpactSummary: "4 minutes of 502s",
      runbookExecutionIds: ["rb-1"],
      relatedDeploymentIds: ["dep-1"],
      affectedTenantIds: ["t1"],
      affectedRegions: ["eu"],
      postmortemId: "PM-2026-0001",
    });
    expect(rowToIncident(incidentRow(record)).record).toEqual(record);
  });

  it("returns an absent key, not null, for an unset optional text field", () => {
    // The contract uses `.optional()` for these three, so null and absent are different values
    // and a round-trip that turned absent into null would not equal the original.
    const record = rowToIncident(incidentRow(declaredIncident())).record;
    expect("rootCause" in record).toBe(false);
    expect("cancelledReason" in record).toBe(false);
    expect("customerImpactSummary" in record).toBe(false);
  });

  it("accepts Date objects where the driver returns them", () => {
    const row = incidentRow(declaredIncident());
    row["declared_at"] = new Date(T0);
    row["updated_at"] = new Date(T0);
    expect(rowToIncident(row).record.declaredAt).toBe(T0);
  });

  it("accepts already-parsed JSONB values", () => {
    const record = declaredIncident({ affectedTenantIds: ["t1"] });
    const row = incidentRow(record);
    row["affected_tenant_ids"] = ["t1"];
    row["timeline"] = record.timeline;
    row["role_assignments"] = [];
    row["runbook_execution_ids"] = [];
    row["related_deployment_ids"] = [];
    row["breach_data_classes"] = [];
    expect(rowToIncident(row).record.affectedTenantIds).toEqual(["t1"]);
  });

  it("defaults a missing revision to 1", () => {
    const row = incidentRow(declaredIncident());
    delete row["revision"];
    expect(rowToIncident(row).revision).toBe(1);
  });

  it("rejects a row whose status and timestamps contradict the contract", () => {
    // The kind of damage a hand-written UPDATE does and no CHECK constraint can catch.
    const row = incidentRow(declaredIncident());
    row["status"] = "closed";
    expect(() => rowToIncident(row)).toThrow();
  });

  it("rejects a row whose severity was edited past its role requirements", () => {
    const triaged = IncidentRecordSchema.parse({
      ...declaredIncident(),
      roleAssignments: [
        { role: "incident_commander", userId: "a", assignedAt: T0 },
        { role: "scribe", userId: "b", assignedAt: T0 },
        { role: "comms_lead", userId: "c", assignedAt: T0 },
      ],
      status: "triaged",
      ackedAt: T0,
    });
    const row = incidentRow(triaged);
    row["severity"] = "sev1";
    expect(() => rowToIncident(row)).toThrow();
  });

  it("rejects a row with an empty timeline", () => {
    const row = incidentRow(declaredIncident());
    row["timeline"] = "[]";
    expect(() => rowToIncident(row)).toThrow();
  });
});

/**
 * The append-only guard, which moved here to gain a second caller (ADR-0328).
 *
 * It started as a private function in `persisting-engine.ts`, so every write through
 * `PersistentIncidentEngine.apply` passed it and `appendPagedNote` — added by ADR-0327, writing a
 * timeline entry directly — did not. The engine imports the store, so the store could not import
 * the guard from the engine; it lives in this module, which both already depend on.
 */
describe("assertAppendOnly (ADR-0328)", () => {
  const base = declaredIncident();

  function withTimeline(entries: IncidentRecord["timeline"]): IncidentRecord {
    return { ...base, timeline: entries };
  }

  it("accepts a timeline that is the stored one plus an entry", () => {
    const next = withTimeline([
      ...base.timeline,
      { ...base.timeline[0], kind: "paged", message: "paged 1/1 over slack" },
    ] as IncidentRecord["timeline"]);
    expect(() => assertAppendOnly(base, next)).not.toThrow();
  });

  it("accepts an unchanged timeline, since a write may touch other fields only", () => {
    expect(() => assertAppendOnly(base, { ...base, severity: "sev2" })).not.toThrow();
  });

  it("refuses a shorter timeline", () => {
    expect(() => assertAppendOnly(base, withTimeline([]))).toThrow(IncidentTimelineRewriteError);
  });

  it("refuses an *edited* entry at the same length, which is the defect it exists for", () => {
    // A CHECK constraint cannot express this and the column is JSONB, so before the row is written
    // is the only place it can be caught. Length alone would let it through.
    const edited = withTimeline([
      { ...base.timeline[0], message: "rewritten" },
    ] as IncidentRecord["timeline"]);
    expect(() => assertAppendOnly(base, edited)).toThrow(IncidentTimelineRewriteError);
  });

  it("refuses an edit buried behind a legitimate append", () => {
    const sneaky = withTimeline([
      { ...base.timeline[0], message: "rewritten" },
      { ...base.timeline[0], kind: "paged", message: "paged 1/1 over slack" },
    ] as IncidentRecord["timeline"]);
    expect(() => assertAppendOnly(base, sneaky)).toThrow(IncidentTimelineRewriteError);
  });

  it("names the incident in the error, so a log line identifies the row", () => {
    expect(() => assertAppendOnly(base, withTimeline([]))).toThrow(new RegExp(base.id));
  });

  it("compares serialised entries, so both sides must come from one load", () => {
    // `JSON.stringify` is key-order sensitive, so this guard is too. That is safe only because the
    // candidate is always built by spreading the record `rowToIncident` just returned — one source,
    // one key order. A caller that constructed an entry from scratch with the same fields in a
    // different order would be refused, which is why `appendPagedNote` goes through the executor.
    const first = base.timeline[0];
    if (first === undefined) throw new Error("fixture has no timeline entry");
    expect(() => assertAppendOnly(base, withTimeline([{ ...first }]))).not.toThrow();
  });
});
