import { describe, expect, it } from "vitest";
import type { IncidentRecord, TimelineEntry } from "@crossengin/incident-response";

import {
  IncidentRevisionConflictError,
  PAGED_NOTE_MAX_ATTEMPTS,
  PostgresIncidentStore,
} from "./incident-store.js";
import { INCIDENT_COLUMN_NAMES, incidentRowValues } from "./records.js";
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

describe("insertAllocated", () => {
  function allocating(next: string, capture?: Captured[]) {
    return mockConnection(
      capture,
      respondTo([["MAX(sequence_number)", { rows: [{ next }], rowCount: 1 }]]),
    );
  }

  it("builds the record with the id it allocated", async () => {
    const conn = allocating("12");
    const stored = await new PostgresIncidentStore(conn).insertAllocated(
      2026,
      (id) => declaredIncident({ id }),
      T0,
    );
    expect(stored.record.id).toBe("INC-2026-0012");
    expect(stored.revision).toBe(1);
  });

  it("inserts without releasing the lock, so two declarers cannot share a sequence", async () => {
    const capture: Captured[] = [];
    const conn = allocating("1", capture);
    await new PostgresIncidentStore(conn).insertAllocated(
      2026,
      (id) => declaredIncident({ id }),
      T0,
    );
    // One lock acquisition covering both statements — the window this closes is a second
    // allocation landing between the SELECT and the INSERT.
    expect(conn.withAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(capture[0]?.sql).toContain("MAX(sequence_number)");
    expect(capture[1]?.sql).toContain("INSERT INTO meta.incidents");
  });

  it("refuses a builder that ignored the allocated id", async () => {
    // The row's year/sequence columns are derived from the id, so storing a record under a
    // different one writes columns that contradict it.
    const conn = allocating("3");
    await expect(
      new PostgresIncidentStore(conn).insertAllocated(2026, () => declaredIncident(), T0),
    ).rejects.toThrow(/returned id 'INC-2026-0007' for allocated id 'INC-2026-0003'/);
  });

  it("writes nothing when the builder is refused", async () => {
    const capture: Captured[] = [];
    const conn = allocating("3", capture);
    await expect(
      new PostgresIncidentStore(conn).insertAllocated(2026, () => declaredIncident(), T0),
    ).rejects.toThrow();
    expect(capture.some((c) => c.sql.includes("INSERT"))).toBe(false);
  });

  it("starts a fresh year at 0001", async () => {
    const conn = mockConnection(undefined, respondTo([["MAX(sequence_number)", EMPTY]]));
    const stored = await new PostgresIncidentStore(conn).insertAllocated(
      2031,
      (id) => declaredIncident({ id }),
      T0,
    );
    expect(stored.record.id).toBe("INC-2031-0001");
  });

  it("lets the builder's own refusal through unwrapped", async () => {
    const conn = allocating("1");
    await expect(
      new PostgresIncidentStore(conn).insertAllocated(
        2026,
        () => {
          throw new Error("contract refused the declaration");
        },
        T0,
      ),
    ).rejects.toThrow(/contract refused the declaration/);
  });
});

describe("findOpenFor", () => {
  it("looks up by signal and excludes the statuses that are not open", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresIncidentStore(conn).findOpenFor("availability:product.list");
    expect(capture[0]?.sql).toContain("WHERE auto_declared_for = $1");
    expect(capture[0]?.sql).toContain("status NOT IN ('closed', 'cancelled')");
    expect(capture[0]?.params).toEqual(["availability:product.list"]);
  });

  it("returns the record a restart should adopt", async () => {
    const record = declaredIncident({ autoDeclaredFor: "availability:product.list" });
    const conn = mockConnection(
      undefined,
      respondTo([["SELECT", { rows: [incidentRow(record)], rowCount: 1 }]]),
    );
    const found = await new PostgresIncidentStore(conn).findOpenFor("availability:product.list");
    expect(found?.record.id).toBe(record.id);
    expect(found?.record.autoDeclaredFor).toBe("availability:product.list");
  });

  it("returns null when the signal has nothing open", async () => {
    const conn = mockConnection(undefined, respondTo([["SELECT", EMPTY]]));
    expect(await new PostgresIncidentStore(conn).findOpenFor("availability:x")).toBeNull();
  });

  it("asks for two rows, so a duplicate is visible rather than silently preferred", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, respondTo([["SELECT", EMPTY]]));
    await new PostgresIncidentStore(conn).findOpenFor("availability:x");
    expect(capture[0]?.sql).toContain("LIMIT 2");
  });

  it("refuses two open incidents for one signal, which the index should have prevented", async () => {
    const record = declaredIncident({ autoDeclaredFor: "availability:x" });
    const row = incidentRow(record);
    const conn = mockConnection(
      undefined,
      respondTo([["SELECT", { rows: [row, row], rowCount: 2 }]]),
    );
    await expect(
      new PostgresIncidentStore(conn).findOpenFor("availability:x"),
    ).rejects.toThrow(/more than one open incident for signal 'availability:x'/);
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
    // Derived from the column array rather than hardcoded: the guard binds after every column
    // value, so a column added anywhere moves it, and a literal here would only ever be stale.
    expect(capture[0]?.sql).toContain(
      `WHERE incident_id = $1 AND revision = $${INCIDENT_COLUMN_NAMES.length + 1}`,
    );
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

describe("appendPagedNote", () => {
  const FACTS = {
    channels: ["pagerduty_phone", "slack"],
    delivered: 2,
    attempted: 3,
  } as const;
  const T1 = "2026-09-30T10:05:00.000Z";

  /** A connection that answers the load with `record` and lets the update affect `rowCount` rows. */
  function loading(
    record: IncidentRecord,
    revision = 1,
    capture?: Captured[],
    updateRowCount = 1,
  ) {
    return mockConnection(capture, (sql) =>
      sql.includes("SELECT")
        ? { rows: [incidentRow(record, revision)], rowCount: 1 }
        : { rows: [], rowCount: updateRowCount },
    );
  }

  function appended(capture: Captured[]): TimelineEntry[] {
    const update = capture.find((c) => c.sql.includes("UPDATE"));
    const idx = INCIDENT_COLUMN_NAMES.indexOf("timeline");
    return JSON.parse(String(update?.params?.[idx])) as TimelineEntry[];
  }

  it("reads the incident, appends one paged entry and writes it back", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    const outcome = await new PostgresIncidentStore(
      loading(record, 1, capture),
    ).appendPagedNote(record.id, { facts: FACTS, actorUserId: "system-slo", at: T1 });
    expect(outcome).toEqual({ recorded: true, reason: null });
    expect(capture[0]?.sql).toContain("WHERE incident_id = $1");
    expect(capture[1]?.sql).toContain("UPDATE meta.incidents");
    const timeline = appended(capture);
    expect(timeline).toHaveLength(record.timeline.length + 1);
    expect(timeline[timeline.length - 1]?.kind).toBe("paged");
  });

  it("writes the message and metadata the contract builds", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 1, capture)).appendPagedNote(record.id, {
      facts: { ...FACTS, reference: record.id },
      actorUserId: "system-slo",
      at: T1,
    });
    const entry = appended(capture).at(-1);
    expect(entry?.message).toBe("paged 2/3 over pagerduty_phone, slack");
    expect(entry?.metadata).toEqual({
      operation: "trigger",
      channels: ["pagerduty_phone", "slack"],
      delivered: 2,
      attempted: 3,
      reference: record.id,
    });
    expect(entry?.actorUserId).toBe("system-slo");
    expect(entry?.occurredAt).toBe(T1);
  });

  it("keeps the revision predicate in the UPDATE and advances the revision", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 4, capture)).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    const update = capture.find((c) => c.sql.includes("UPDATE"));
    expect(update?.sql).toContain(
      `WHERE incident_id = $1 AND revision = $${INCIDENT_COLUMN_NAMES.length + 1}`,
    );
    expect(update?.params?.[INCIDENT_COLUMN_NAMES.length]).toBe(4);
    expect(update?.params?.[INCIDENT_COLUMN_NAMES.indexOf("revision")]).toBe(5);
  });

  it("changes nothing but the timeline and the revision", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 1, capture)).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    const update = capture.find((c) => c.sql.includes("UPDATE"));
    const unchanged = incidentRowValues(record, 1, T0);
    INCIDENT_COLUMN_NAMES.forEach((col, i) => {
      if (col === "timeline" || col === "revision" || col === "updated_at") return;
      expect(update?.params?.[i]).toEqual(unchanged[i]);
    });
  });

  it("leaves the already-recorded entries byte-identical", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 1, capture)).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    const timeline = appended(capture);
    expect(JSON.stringify(timeline[0])).toBe(JSON.stringify(record.timeline[0]));
  });

  it("reports a missing incident instead of throwing", async () => {
    // The page has already gone out; raising here would turn a successful escalation into an
    // error.
    const conn = mockConnection(undefined, () => EMPTY);
    const outcome = await new PostgresIncidentStore(conn).appendPagedNote("INC-2026-9999", {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    expect(outcome).toEqual({ recorded: false, reason: "incident_not_found" });
  });

  it("writes nothing when the incident does not exist", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, () => EMPTY);
    await new PostgresIncidentStore(conn).appendPagedNote("INC-2026-9999", {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    expect(capture.some((c) => c.sql.includes("UPDATE"))).toBe(false);
  });

  it("retries a lost revision race and reports a conflict once the attempts run out", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    const outcome = await new PostgresIncidentStore(
      loading(record, 1, capture, 0),
    ).appendPagedNote(record.id, { facts: FACTS, actorUserId: "system-slo", at: T1 });
    expect(outcome).toEqual({ recorded: false, reason: "revision_conflict" });
    expect(capture.filter((c) => c.sql.includes("UPDATE"))).toHaveLength(
      PAGED_NOTE_MAX_ATTEMPTS,
    );
  });

  it("re-reads the row on each retry rather than re-writing a stale one", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 1, capture, 0)).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    expect(capture.filter((c) => c.sql.includes("SELECT"))).toHaveLength(
      PAGED_NOTE_MAX_ATTEMPTS,
    );
  });

  it("lands on a retry when the second attempt wins the row", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    let updates = 0;
    const conn = mockConnection(capture, (sql) => {
      if (sql.includes("SELECT")) return { rows: [incidentRow(record, 1)], rowCount: 1 };
      updates += 1;
      return { rows: [], rowCount: updates === 1 ? 0 : 1 };
    });
    const outcome = await new PostgresIncidentStore(conn).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    expect(outcome).toEqual({ recorded: true, reason: null });
    expect(updates).toBe(2);
  });

  it("stamps the same instant on every attempt", async () => {
    // The entry records when the page happened, not when the last retry got through.
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 1, capture, 0)).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    const stamps = capture
      .filter((c) => c.sql.includes("UPDATE"))
      .map((c) => (JSON.parse(String(c.params?.[INCIDENT_COLUMN_NAMES.indexOf("timeline")])) as TimelineEntry[]).at(-1)?.occurredAt);
    expect(new Set(stamps)).toEqual(new Set([T1]));
  });

  it("reports the contract's refusal of impossible counts without retrying", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    const outcome = await new PostgresIncidentStore(
      loading(record, 1, capture),
    ).appendPagedNote(record.id, {
      facts: { channels: ["slack"], delivered: 9, attempted: 1 },
      actorUserId: "system-slo",
      at: T1,
    });
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toMatch(/^note_refused: /);
    expect(capture.some((c) => c.sql.includes("UPDATE"))).toBe(false);
  });

  it("reports an unexpected write failure rather than raising it", async () => {
    const record = declaredIncident();
    const conn = mockConnection(undefined, (sql) => {
      if (sql.includes("SELECT")) return { rows: [incidentRow(record, 1)], rowCount: 1 };
      throw new Error("connection terminated unexpectedly");
    });
    const outcome = await new PostgresIncidentStore(conn).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toBe("write_failed: connection terminated unexpectedly");
  });

  it("reports an unexpected read failure rather than raising it", async () => {
    const conn = mockConnection(undefined, () => {
      throw new Error("relation \"meta.incidents\" does not exist");
    });
    const outcome = await new PostgresIncidentStore(conn).appendPagedNote("INC-2026-0007", {
      facts: FACTS,
      actorUserId: "system-slo",
      at: T1,
    });
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toMatch(/^read_failed: /);
  });

  it("records a page on a closed incident", async () => {
    // A resolve's note arrives after the close-out, so a terminal status must not refuse it.
    const capture: Captured[] = [];
    const closed = declaredIncident(
      {
        status: "closed",
        ackedAt: T1,
        mitigatedAt: T1,
        resolvedAt: T1,
        closedAt: T1,
        rootCause: "pool exhaustion",
      },
      "sev3",
    );
    const outcome = await new PostgresIncidentStore(
      loading(closed, 2, capture),
    ).appendPagedNote(closed.id, {
      facts: { channels: ["pagerduty_phone"], delivered: 1, attempted: 1, operation: "resolve" },
      actorUserId: "system-slo",
      at: T1,
    });
    expect(outcome.recorded).toBe(true);
    expect(appended(capture).at(-1)?.message).toBe("resolved the alert on pagerduty_phone");
    expect(capture.find((c) => c.sql.includes("UPDATE"))?.params?.[
      INCIDENT_COLUMN_NAMES.indexOf("status")
    ]).toBe("closed");
  });

  it("records an unroutable page, which reached nobody over no channel", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 1, capture)).appendPagedNote(record.id, {
      facts: { channels: [], delivered: 0, attempted: 0 },
      actorUserId: "system-slo",
      at: T1,
    });
    expect(appended(capture).at(-1)?.message).toBe(
      "PAGED NOBODY — no page channel was attempted",
    );
  });

  it("falls back to the current instant when none is given", async () => {
    const capture: Captured[] = [];
    const record = declaredIncident();
    await new PostgresIncidentStore(loading(record, 1, capture)).appendPagedNote(record.id, {
      facts: FACTS,
      actorUserId: "system-slo",
    });
    const stamp = appended(capture).at(-1)?.occurredAt ?? "";
    expect(Number.isNaN(new Date(stamp).getTime())).toBe(false);
  });

  it("retries at most three times, so a page note cannot loop", async () => {
    expect(PAGED_NOTE_MAX_ATTEMPTS).toBe(3);
  });
});
