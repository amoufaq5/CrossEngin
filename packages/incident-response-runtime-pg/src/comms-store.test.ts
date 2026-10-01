import { describe, expect, it } from "vitest";
import {
  IncidentCommunicationSchema,
  type IncidentCommunication,
} from "@crossengin/incident-response";

import {
  COMMS_COLUMN_NAMES,
  COMMS_JSONB_COLUMNS,
  CommsRevisionConflictError,
  PostgresCustomerCommsStore,
  commsPlaceholders,
  commsRowValues,
  commsUpdateAssignments,
  rowToComms,
} from "./comms-store.js";
import { EMPTY, mockConnection, respondTo, type Captured } from "./test-fakes.js";

const T0 = "2026-09-30T10:00:00.000Z";
/** 48 hours after T0 — inside the GDPR 72h window a breach notification is measured against. */
const DEADLINE = "2026-10-02T10:00:00.000Z";
const AFTER_DEADLINE = "2026-10-05T10:00:00.000Z";

function comms(over: Record<string, unknown> = {}): IncidentCommunication {
  return IncidentCommunicationSchema.parse({
    id: "comm-0001",
    incidentId: "INC-2026-0007",
    audience: "internal_eng",
    kind: "investigating",
    title: "Checkout latency",
    body: "We are investigating elevated checkout latency.",
    publishedAt: T0,
    publishedBy: "oncall-1",
    deliveryChannels: ["in_app"],
    recipientCount: 40,
    ...over,
  });
}

function breachNotification(over: Record<string, unknown> = {}): IncidentCommunication {
  return comms({
    audience: "affected_tenants",
    kind: "breach_notification",
    requiresLegalReview: true,
    legalReviewedBy: "legal-1",
    legalReviewedAt: T0,
    breachNotificationDeadlineAt: DEADLINE,
    deliveryChannels: ["email"],
    ...over,
  });
}

/** The row a stored communication comes back as, built through the store's own projection. */
function commsRow(
  record: IncidentCommunication,
  revision = 1,
  updatedAt = T0,
): Record<string, unknown> {
  const values = commsRowValues(record, revision, updatedAt);
  const row: Record<string, unknown> = {};
  COMMS_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}

describe("column projection", () => {
  it("supplies exactly one value per column, business key first", () => {
    expect(COMMS_COLUMN_NAMES[0]).toBe("communication_id");
    expect(commsRowValues(breachNotification(), 1, T0)).toHaveLength(COMMS_COLUMN_NAMES.length);
  });

  it("casts only the JSONB columns", () => {
    const placeholders = commsPlaceholders().split(", ");
    placeholders.forEach((p, i) => {
      const col = COMMS_COLUMN_NAMES[i] ?? "";
      expect(p.endsWith("::jsonb")).toBe(COMMS_JSONB_COLUMNS.has(col));
    });
  });

  it("omits the key from the UPDATE assignments and starts them at $2", () => {
    const assignments = commsUpdateAssignments();
    expect(assignments).not.toContain("communication_id =");
    expect(assignments.startsWith("incident_id = $2")).toBe(true);
  });

  it("assigns every non-key column exactly once", () => {
    expect(commsUpdateAssignments().split(", ")).toHaveLength(COMMS_COLUMN_NAMES.length - 1);
  });

  it("binds absent optional fields as NULL", () => {
    const values = commsRowValues(comms(), 1, T0);
    expect(values[COMMS_COLUMN_NAMES.indexOf("status_page_level")]).toBeNull();
    expect(values[COMMS_COLUMN_NAMES.indexOf("retracted_reason")]).toBeNull();
    expect(values[COMMS_COLUMN_NAMES.indexOf("breach_notification_deadline_at")]).toBeNull();
  });

  it("refuses to project a record the contract rejects", () => {
    const bad = { ...comms(), bouncesCount: 99 } as IncidentCommunication;
    expect(() => commsRowValues(bad, 1, T0)).toThrow(/bouncesCount cannot exceed recipientCount/);
  });
});

describe("insert", () => {
  it("writes every column with the derived placeholder list", async () => {
    const capture: Captured[] = [];
    const store = new PostgresCustomerCommsStore(mockConnection(capture));
    const record = breachNotification();
    expect(await store.insert(record, T0)).toEqual({ record, revision: 1, updatedAt: T0 });
    expect(capture[0]?.sql).toContain("INSERT INTO meta.incident_communications");
    expect(capture[0]?.sql).toContain(COMMS_COLUMN_NAMES.join(", "));
    expect(capture[0]?.params).toHaveLength(COMMS_COLUMN_NAMES.length);
  });

  it("binds the contract id into communication_id, not the surrogate uuid", async () => {
    const capture: Captured[] = [];
    await new PostgresCustomerCommsStore(mockConnection(capture)).insert(comms(), T0);
    expect(capture[0]?.params?.[0]).toBe("comm-0001");
  });

  it("refuses a breach notification published past its deadline, before any SQL runs", async () => {
    const capture: Captured[] = [];
    const store = new PostgresCustomerCommsStore(mockConnection(capture));
    const bad = {
      ...breachNotification(),
      publishedAt: AFTER_DEADLINE,
    } as IncidentCommunication;
    await expect(store.insert(bad, T0)).rejects.toThrow(/notification was late/);
    expect(capture).toHaveLength(0);
  });
});

describe("update", () => {
  it("matches on communication_id and guards on the revision it was given", async () => {
    const capture: Captured[] = [];
    await new PostgresCustomerCommsStore(mockConnection(capture)).update(comms(), 2, DEADLINE);
    expect(capture[0]?.sql).toContain("UPDATE meta.incident_communications SET");
    expect(capture[0]?.sql).toContain(
      `WHERE communication_id = $1 AND revision = $${String(COMMS_COLUMN_NAMES.length + 1)}`,
    );
  });

  it("binds every column value and then the expected revision as the last parameter", async () => {
    const capture: Captured[] = [];
    const record = comms();
    await new PostgresCustomerCommsStore(mockConnection(capture)).update(record, 2, DEADLINE);
    expect(capture[0]?.params).toEqual([...commsRowValues(record, 3, DEADLINE), 2]);
  });

  it("writes the next revision and returns it", async () => {
    const record = comms({ retractedAt: DEADLINE, retractedReason: "wrong tenant list" });
    const stored = await new PostgresCustomerCommsStore(mockConnection()).update(
      record,
      2,
      DEADLINE,
    );
    expect(stored).toEqual({ record, revision: 3, updatedAt: DEADLINE });
  });

  it("raises a conflict rather than letting a bounce update erase a retraction", async () => {
    const conn = mockConnection(undefined, respondTo([["UPDATE", EMPTY]]));
    const store = new PostgresCustomerCommsStore(conn);
    const stale = comms({ bouncesCount: 3 });
    await expect(store.update(stale, 1, DEADLINE)).rejects.toThrow(CommsRevisionConflictError);
    await expect(store.update(stale, 1, DEADLINE)).rejects.toThrow(
      /'comm-0001' was not at revision 1/,
    );
  });

  it("refuses a retraction with no reason, before any SQL runs", async () => {
    const capture: Captured[] = [];
    const store = new PostgresCustomerCommsStore(mockConnection(capture));
    const bad = { ...comms(), retractedAt: DEADLINE } as IncidentCommunication;
    await expect(store.update(bad, 1, T0)).rejects.toThrow(/retractedAt requires retractedReason/);
    expect(capture).toHaveLength(0);
  });
});

describe("load", () => {
  it("selects by communication_id and round-trips the record", async () => {
    const record = breachNotification();
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["SELECT", { rows: [commsRow(record)], rowCount: 1 }]]),
    );
    const loaded = await new PostgresCustomerCommsStore(conn).load("comm-0001");
    expect(loaded?.record).toEqual(record);
    expect(capture[0]?.params).toEqual(["comm-0001"]);
  });

  it("returns null for a missing communication", async () => {
    const conn = mockConnection(undefined, respondTo([["SELECT", EMPTY]]));
    expect(await new PostgresCustomerCommsStore(conn).load("comm-9999")).toBeNull();
  });
});

describe("listForIncident", () => {
  it("filters by incident in publication order", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresCustomerCommsStore(conn).listForIncident("INC-2026-0007", 5);
    expect(capture[0]?.sql).toContain("WHERE incident_id = $1");
    expect(capture[0]?.sql).toContain("ORDER BY published_at ASC");
    expect(capture[0]?.params).toEqual(["INC-2026-0007", 5]);
  });

  it("defaults the limit to 100", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresCustomerCommsStore(conn).listForIncident("INC-2026-0007");
    expect(capture[0]?.params?.[1]).toBe(100);
  });

  it("rejects a non-positive limit before querying", async () => {
    const capture: Captured[] = [];
    const store = new PostgresCustomerCommsStore(mockConnection(capture));
    await expect(store.listForIncident("INC-2026-0007", 0)).rejects.toThrow(/positive/);
    expect(capture).toHaveLength(0);
  });

  it("re-validates every row it returns", async () => {
    const rows = [commsRow(comms()), commsRow(breachNotification({ id: "comm-0002" }))];
    const conn = mockConnection(undefined, respondTo([["SELECT", { rows, rowCount: 2 }]]));
    const loaded = await new PostgresCustomerCommsStore(conn).listForIncident("INC-2026-0007");
    expect(loaded.map((c) => c.record.kind)).toEqual(["investigating", "breach_notification"]);
  });
});

describe("listPublishedForIncident", () => {
  it("excludes retracted rows in SQL rather than in memory", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresCustomerCommsStore(conn).listPublishedForIncident("INC-2026-0007");
    expect(capture[0]?.sql).toContain("retracted_at IS NULL");
    expect(capture[0]?.sql).toContain("ORDER BY published_at ASC");
  });
});

describe("listBreachNotifications", () => {
  it("filters to the breach_notification kind", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresCustomerCommsStore(conn).listBreachNotifications("INC-2026-0007");
    expect(capture[0]?.sql).toContain("kind = 'breach_notification'");
    expect(capture[0]?.params).toEqual(["INC-2026-0007", 100]);
  });
});

describe("rowToComms re-validation", () => {
  it("accepts a row the store itself wrote, with its revision and updatedAt", () => {
    const record = breachNotification();
    expect(rowToComms(commsRow(record, 2, DEADLINE))).toEqual({
      record,
      revision: 2,
      updatedAt: DEADLINE,
    });
  });

  it("omits absent optional fields rather than reading them back as null", () => {
    const loaded = rowToComms(commsRow(comms())).record;
    expect("statusPageLevel" in loaded).toBe(false);
    expect("retractedReason" in loaded).toBe(false);
    expect("breachNotificationDeadlineAt" in loaded).toBe(false);
  });

  it("reads TIMESTAMPTZ columns handed back as Date objects", () => {
    const row = { ...commsRow(comms()), published_at: new Date(T0) };
    expect(rowToComms(row).record.publishedAt).toBe(T0);
  });

  it("reads INTEGER counts handed back as text", () => {
    const row = { ...commsRow(comms()), recipient_count: "40", bounces_count: "2" };
    const loaded = rowToComms(row).record;
    expect(loaded.recipientCount).toBe(40);
    expect(loaded.bouncesCount).toBe(2);
  });

  it("reads JSONB columns handed back parsed or as text alike", () => {
    const row = commsRow(comms());
    const parsed = {
      ...row,
      languages: JSON.parse(String(row["languages"])) as unknown,
      delivery_channels: JSON.parse(String(row["delivery_channels"])) as unknown,
    };
    expect(rowToComms(parsed)).toEqual(rowToComms(row));
  });

  it("refuses a breach notification row whose publish date was pushed past the deadline", () => {
    const row = { ...commsRow(breachNotification()), published_at: AFTER_DEADLINE };
    expect(() => rowToComms(row)).toThrow(/notification was late/);
  });

  it("refuses a breach notification row with its deadline nulled", () => {
    const row = { ...commsRow(breachNotification()), breach_notification_deadline_at: null };
    expect(() => rowToComms(row)).toThrow(/GDPR 72h/);
  });

  it("refuses a breach notification row with legal review cleared", () => {
    const row = {
      ...commsRow(breachNotification()),
      requires_legal_review: false,
      legal_reviewed_by: null,
      legal_reviewed_at: null,
    };
    expect(() => rowToComms(row)).toThrow(/breach_notification must requiresLegalReview/);
  });

  it("refuses a row that requires legal review with no named reviewer", () => {
    const row = { ...commsRow(breachNotification()), legal_reviewed_by: null };
    expect(() => rowToComms(row)).toThrow(/requires legalReviewedBy/);
  });

  it("refuses a breach notification sent to the wrong audience", () => {
    const row = { ...commsRow(breachNotification()), audience: "all_customers" };
    expect(() => rowToComms(row)).toThrow(/audience must be 'affected_tenants' or 'regulators'/);
  });

  it("refuses a regulator notice with no legal review", () => {
    const row = {
      ...commsRow(comms()),
      audience: "regulators",
    };
    expect(() => rowToComms(row)).toThrow(/must requiresLegalReview/);
  });

  it("refuses a retracted row with its reason stripped", () => {
    const record = comms({ retractedAt: DEADLINE, retractedReason: "wrong tenant list" });
    const row = { ...commsRow(record), retracted_reason: null };
    expect(() => rowToComms(row)).toThrow(/retractedAt requires retractedReason/);
  });

  it("refuses a status page level that does not match the audience, either way round", () => {
    const onStatusPage = comms({ audience: "status_page_public", statusPageLevel: "degraded" });
    const stripped = { ...commsRow(onStatusPage), status_page_level: null };
    expect(() => rowToComms(stripped)).toThrow(/requires statusPageLevel/);
    const misplaced = { ...commsRow(comms()), status_page_level: "degraded" };
    expect(() => rowToComms(misplaced)).toThrow(/only valid for status_page_public/);
  });
});
