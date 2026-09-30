import { describe, expect, it } from "vitest";

import {
  IncidentRevisionConflictError,
  PostgresIncidentStore,
} from "./incident-store.js";
import { INCIDENT_COLUMN_NAMES } from "./records.js";
import {
  EMPTY,
  T0,
  declaredIncident,
  incidentRow,
  mockConnection,
  respondTo,
  type Captured,
} from "./test-fakes.js";

describe("allocateIncidentId", () => {
  it("takes the lock, reads the year's max sequence and formats the next id", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["MAX(sequence_number)", { rows: [{ next: "7" }], rowCount: 1 }]]),
    );
    const id = await new PostgresIncidentStore(conn).allocateIncidentId(2026);
    expect(id).toBe("INC-2026-0007");
    expect(capture[0]?.sql).toContain("COALESCE(MAX(sequence_number), 0) + 1");
    expect(capture[0]?.params).toEqual([2026]);
  });

  it("scopes the max to the requested year", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(
      capture,
      respondTo([["MAX(sequence_number)", { rows: [{ next: "1" }], rowCount: 1 }]]),
    );
    await new PostgresIncidentStore(conn).allocateIncidentId(2027);
    expect(capture[0]?.sql).toContain("WHERE year = $1");
  });

  it("starts at 0001 for a year with no incidents", async () => {
    const conn = mockConnection(undefined, respondTo([["MAX(sequence_number)", EMPTY]]));
    expect(await new PostgresIncidentStore(conn).allocateIncidentId(2026)).toBe("INC-2026-0001");
  });

  it("serializes allocation under an advisory lock", async () => {
    const conn = mockConnection(
      undefined,
      respondTo([["MAX(sequence_number)", { rows: [{ next: "1" }], rowCount: 1 }]]),
    );
    await new PostgresIncidentStore(conn).allocateIncidentId(2026);
    expect(conn.withAdvisoryLock).toHaveBeenCalledTimes(1);
  });
});

describe("insert", () => {
  it("writes every column once at revision 1", async () => {
    const capture: Captured[] = [];
    const store = new PostgresIncidentStore(mockConnection(capture));
    const record = declaredIncident();
    const stored = await store.insert(record, T0);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.sql).toContain("INSERT INTO meta.incidents");
    expect(capture[0]?.params).toHaveLength(INCIDENT_COLUMN_NAMES.length);
    expect(stored.revision).toBe(1);
    expect(stored.record).toEqual(record);
  });

  it("binds the revision column as 1", async () => {
    const capture: Captured[] = [];
    await new PostgresIncidentStore(mockConnection(capture)).insert(declaredIncident(), T0);
    const idx = INCIDENT_COLUMN_NAMES.indexOf("revision");
    expect(capture[0]?.params?.[idx]).toBe(1);
  });

  it("does not swallow a duplicate — no ON CONFLICT DO NOTHING", async () => {
    // An incident id collision means two responses believe they are the same incident; silently
    // keeping the first would lose the second entirely.
    const capture: Captured[] = [];
    await new PostgresIncidentStore(mockConnection(capture)).insert(declaredIncident(), T0);
    expect(capture[0]?.sql).not.toContain("ON CONFLICT");
  });
});

describe("update", () => {
  it("guards on the revision read and advances it", async () => {
    const capture: Captured[] = [];
    const store = new PostgresIncidentStore(mockConnection(capture));
    const stored = await store.update(declaredIncident(), 3, T0);
    expect(capture[0]?.sql).toContain("WHERE incident_id = $1 AND revision = $30");
    expect(capture[0]?.params?.[INCIDENT_COLUMN_NAMES.length]).toBe(3);
    expect(capture[0]?.params?.[INCIDENT_COLUMN_NAMES.indexOf("revision")]).toBe(4);
    expect(stored.revision).toBe(4);
  });

  it("throws IncidentRevisionConflictError when nothing matched", async () => {
    const conn = mockConnection(undefined, () => ({ rows: [], rowCount: 0 }));
    await expect(
      new PostgresIncidentStore(conn).update(declaredIncident(), 1, T0),
    ).rejects.toThrow(IncidentRevisionConflictError);
  });

  it("names the incident and the revision it expected", async () => {
    const conn = mockConnection(undefined, () => ({ rows: [], rowCount: 0 }));
    try {
      await new PostgresIncidentStore(conn).update(declaredIncident(), 5, T0);
      expect.unreachable("should have thrown");
    } catch (err) {
      const conflict = err as IncidentRevisionConflictError;
      expect(conflict.incidentId).toBe("INC-2026-0007");
      expect(conflict.expectedRevision).toBe(5);
    }
  });

  it("never reassigns incident_id in the SET clause", async () => {
    const capture: Captured[] = [];
    await new PostgresIncidentStore(mockConnection(capture)).update(declaredIncident(), 1, T0);
    const sql = capture[0]?.sql ?? "";
    const setClause = sql.slice(sql.indexOf("SET "), sql.indexOf("WHERE "));
    expect(setClause).not.toContain("incident_id");
    expect(sql).toContain("WHERE incident_id = $1");
  });
});

describe("load", () => {
  it("selects by incident id and parses the row", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    const conn = mockConnection(
      capture,
      respondTo([["WHERE incident_id = $1", { rows: [incidentRow(record, 2)], rowCount: 1 }]]),
    );
    const stored = await new PostgresIncidentStore(conn).load("INC-2026-0007");
    expect(capture[0]?.params).toEqual(["INC-2026-0007"]);
    expect(stored?.record).toEqual(record);
    expect(stored?.revision).toBe(2);
  });

  it("returns null when there is no such incident", async () => {
    const conn = mockConnection(undefined, () => EMPTY);
    expect(await new PostgresIncidentStore(conn).load("INC-2026-9999")).toBeNull();
  });
});

describe("listOpen", () => {
  it("excludes the terminal statuses and orders oldest first", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, () => EMPTY);
    await new PostgresIncidentStore(conn).listOpen(25);
    expect(capture[0]?.sql).toContain("status NOT IN ('closed', 'cancelled')");
    expect(capture[0]?.sql).toContain("ORDER BY declared_at ASC");
    expect(capture[0]?.params).toEqual([25]);
  });

  it("defaults to 100", async () => {
    const capture: Captured[] = [];
    await new PostgresIncidentStore(mockConnection(capture, () => EMPTY)).listOpen();
    expect(capture[0]?.params).toEqual([100]);
  });

  it("rejects a non-positive limit", async () => {
    const conn = mockConnection(undefined, () => EMPTY);
    await expect(new PostgresIncidentStore(conn).listOpen(0)).rejects.toThrow(/limit/);
  });

  it("parses every returned row", async () => {
    const record = declaredIncident();
    const conn = mockConnection(undefined, () => ({
      rows: [incidentRow(record), incidentRow(record, 2)],
      rowCount: 2,
    }));
    expect(await new PostgresIncidentStore(conn).listOpen()).toHaveLength(2);
  });
});

describe("listForTenant", () => {
  it("matches the tenant inside the JSONB array", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, () => EMPTY);
    await new PostgresIncidentStore(conn).listForTenant("t1", 10);
    expect(capture[0]?.sql).toContain("affected_tenant_ids @> to_jsonb($1::text)");
    expect(capture[0]?.params).toEqual(["t1", 10]);
  });

  it("orders newest first", async () => {
    const capture: Captured[] = [];
    await new PostgresIncidentStore(mockConnection(capture, () => EMPTY)).listForTenant("t1");
    expect(capture[0]?.sql).toContain("ORDER BY declared_at DESC");
  });

  it("rejects a non-positive limit", async () => {
    const conn = mockConnection(undefined, () => EMPTY);
    await expect(new PostgresIncidentStore(conn).listForTenant("t1", -1)).rejects.toThrow(/limit/);
  });
});

describe("listRecent", () => {
  it("orders newest first with a bound limit", async () => {
    const capture: Captured[] = [];
    await new PostgresIncidentStore(mockConnection(capture, () => EMPTY)).listRecent(5);
    expect(capture[0]?.sql).toContain("ORDER BY declared_at DESC");
    expect(capture[0]?.params).toEqual([5]);
  });

  it("rejects a non-positive limit", async () => {
    const conn = mockConnection(undefined, () => EMPTY);
    await expect(new PostgresIncidentStore(conn).listRecent(0)).rejects.toThrow(/limit/);
  });
});

describe("countSince", () => {
  it("counts by declared_at with an ISO bound", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, () => ({ rows: [{ count: "4" }], rowCount: 1 }));
    expect(await new PostgresIncidentStore(conn).countSince(new Date(T0))).toBe(4);
    expect(capture[0]?.sql).toContain("COUNT(*)::TEXT");
    expect(capture[0]?.params).toEqual([T0]);
  });

  it("returns 0 when the count comes back empty", async () => {
    const conn = mockConnection(undefined, () => EMPTY);
    expect(await new PostgresIncidentStore(conn).countSince(new Date(T0))).toBe(0);
  });
});
