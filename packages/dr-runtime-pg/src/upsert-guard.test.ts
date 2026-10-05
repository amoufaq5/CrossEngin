import { describe, expect, it } from "vitest";
import {
  DRILL_OUTCOMES,
  FAILOVER_STATUSES,
  FAILOVER_TRANSITIONS,
  canTransitionFailover,
  type FailoverStatus,
} from "@crossengin/dr";
import {
  DR_WRITE_REFUSAL_REASONS,
  DrExecutionWriteRefusedError,
  PLANNED_DRILL_OUTCOME,
  drillUpsertGuard,
  excludedSetClause,
  failoverStatusGuard,
  failoverUpsertGuard,
  observationNotStaleGuard,
  refuseUnlessWritten,
} from "./upsert-guard.js";
import { mockConnection, type Captured } from "./test-fakes.js";

const T = "dr_failover_executions";

describe("failoverStatusGuard", () => {
  const sql = failoverStatusGuard(T);

  it("renders exactly the edges FAILOVER_TRANSITIONS declares, walking the map", () => {
    for (const from of FAILOVER_STATUSES) {
      for (const to of FAILOVER_STATUSES) {
        const pair = `('${from}', '${to}')`;
        expect(sql.includes(pair)).toBe(canTransitionFailover(from, to));
      }
    }
  });

  it("renders no pair for a terminal status, with no special case in the renderer", () => {
    const terminal = FAILOVER_STATUSES.filter(
      (s) => FAILOVER_TRANSITIONS[s].length === 0,
    );
    expect(terminal.length).toBeGreaterThan(0);
    for (const s of terminal) {
      expect(sql).not.toContain(`('${s}', `);
    }
  });

  it("admits a same-status write, because re-recording one state is not a transition", () => {
    // `recordFailover` is called again on the same record when a verdict or a note is amended, and
    // `canTransitionFailover(s, s)` is false for every status — so without this arm an ordinary
    // refresh would be refused as an illegal move.
    for (const s of FAILOVER_STATUSES) {
      expect(canTransitionFailover(s, s)).toBe(false);
    }
    expect(sql).toContain(`${T}.status = EXCLUDED.status`);
  });

  it("compares the stored row against EXCLUDED, never a bound parameter", () => {
    // The point of the guard is that the stored state decides. A parameter would be the caller's
    // belief about the stored state, which is the read-then-write window ADR-0321 closed.
    expect(sql).not.toMatch(/\$\d/);
  });
});

describe("observationNotStaleGuard", () => {
  it("refuses an older observation and admits an equal one", () => {
    // `>=` rather than `>`: an injected clock makes two writes in one tick, and a forward transition
    // recorded at the same instant is the ordinary case, not a replay.
    expect(observationNotStaleGuard(T)).toBe(
      `EXCLUDED.recorded_at >= ${T}.recorded_at`,
    );
  });

  it("guards recorded_at and not triggered_at, which is the declaration and immutable", () => {
    expect(observationNotStaleGuard(T)).not.toContain("triggered_at");
  });
});

describe("failoverUpsertGuard", () => {
  it("ANDs the observation rule and the status rule", () => {
    const sql = failoverUpsertGuard(T);
    expect(sql).toContain(observationNotStaleGuard(T));
    expect(sql).toContain("AND");
    expect(sql).toContain("IN (");
  });
});

describe("drillUpsertGuard", () => {
  const sql = drillUpsertGuard("dr_drill_executions");

  it("takes the planned outcome from the declared enum", () => {
    expect(DRILL_OUTCOMES).toContain(PLANNED_DRILL_OUTCOME);
    expect(sql).toContain(`'${PLANNED_DRILL_OUTCOME}'`);
  });

  it("refuses to withdraw a recorded result back to the planned outcome", () => {
    expect(sql).toContain(
      `EXCLUDED.outcome IS DISTINCT FROM '${PLANNED_DRILL_OUTCOME}'`,
    );
    expect(sql).toContain(
      "dr_drill_executions.outcome IS NOT DISTINCT FROM EXCLUDED.outcome",
    );
  });

  it("refuses to un-execute an executed drill", () => {
    expect(sql).toContain("EXCLUDED.executed_at IS NOT NULL");
    expect(sql).toContain("dr_drill_executions.executed_at IS NULL");
  });

  it("renders no transition pair list, because packages/dr declares no DRILL_TRANSITIONS", () => {
    // Inventing one here would be writing contract in the store. The two clauses above are rules the
    // contract does state; an amendment from one result to another is deliberately permitted.
    expect(sql).not.toContain(" IN ((");
  });

  it("uses IS DISTINCT FROM so a NULL outcome compares rather than vanishing", () => {
    // `outcome` is nullable on the execution record, and `x <> 'y'` is NULL — neither true nor
    // false — for a NULL left side, which in a WHERE reads as a refusal of a write that is fine.
    expect(sql).not.toMatch(/outcome <> /);
  });
});

describe("excludedSetClause", () => {
  it("renders one assignment per column from EXCLUDED", () => {
    expect(excludedSetClause(["status", "record"])).toBe(
      "status = EXCLUDED.status,\n             record = EXCLUDED.record",
    );
  });

  it("refuses an empty list, which would be a DO NOTHING wearing a DO UPDATE's clothes", () => {
    expect(() => excludedSetClause([])).toThrow(/DO NOTHING/);
  });

  it("refuses anything that is not a bare column name", () => {
    expect(() => excludedSetClause(["status; DROP TABLE meta.tenants --"])).toThrow(
      /bare column name/,
    );
  });
});

describe("refuseUnlessWritten", () => {
  const d = {
    schema: "meta",
    table: "dr_failover_executions",
    executionId: "fov_00000001",
    recordedAt: "2026-06-02T12:00:00.000Z",
    stateColumn: "status",
  } as const;

  it("returns without asking anything when the write landed", async () => {
    const capture: Captured[] = [];
    await refuseUnlessWritten(mockConnection(capture), 1, d);
    expect(capture).toEqual([]);
  });

  it("names a stale observation when the stored row is newer", async () => {
    const conn = mockConnection(undefined, {
      rows: [{ state: "succeeded", recorded_at: new Date("2026-06-02T13:00:00.000Z") }],
      rowCount: 1,
    });
    await expect(refuseUnlessWritten(conn, 0, d)).rejects.toMatchObject({
      name: "DrExecutionWriteRefusedError",
      reason: "stale_observation",
      executionId: "fov_00000001",
    });
  });

  it("normalises a Date recorded_at rather than stringifying it", async () => {
    // ADR-0331: a TIMESTAMPTZ arrives as a `Date`, and `String(value)` on one is a form Postgres
    // cannot even re-parse. Comparing it against an ISO string would make every refusal read as an
    // illegal transition — the wrong half of the diagnosis, every time.
    const conn = mockConnection(undefined, {
      rows: [{ state: "queued", recorded_at: new Date("2026-06-02T11:00:00.000Z") }],
      rowCount: 1,
    });
    await expect(refuseUnlessWritten(conn, 0, d)).rejects.toMatchObject({
      reason: "illegal_transition",
    });
  });

  it("compares instants, not text, so an offset-bearing recordedAt still orders", async () => {
    // `recordedAt` satisfies `z.string().datetime({ offset: true })`, so `2026-06-02T14:00:00+03:00`
    // is a legal spelling of 11:00Z — *earlier* than a stored 12:00Z, though it sorts later as text.
    const conn = mockConnection(undefined, {
      rows: [{ state: "succeeded", recorded_at: new Date("2026-06-02T12:00:00.000Z") }],
      rowCount: 1,
    });
    await expect(
      refuseUnlessWritten(conn, 0, { ...d, recordedAt: "2026-06-02T14:00:00+03:00" }),
    ).rejects.toMatchObject({ reason: "stale_observation" });
  });

  it("names an illegal transition when the stored row is older or equal", async () => {
    const conn = mockConnection(undefined, {
      rows: [{ state: "reverted", recorded_at: d.recordedAt }],
      rowCount: 1,
    });
    await expect(refuseUnlessWritten(conn, 0, d)).rejects.toThrow(/reverted/);
  });

  it("names a vanished row rather than guessing, when nothing holds the id", async () => {
    const conn = mockConnection(undefined, { rows: [], rowCount: 0 });
    await expect(refuseUnlessWritten(conn, 0, d)).rejects.toMatchObject({
      reason: "row_vanished",
    });
  });

  it("asks for the state column by name and binds the execution id", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, {
      rows: [{ state: "queued", recorded_at: d.recordedAt }],
      rowCount: 1,
    });
    await expect(refuseUnlessWritten(conn, 0, d)).rejects.toThrow();
    expect(capture[0]?.sql).toContain("SELECT status AS state");
    expect(capture[0]?.params).toEqual(["fov_00000001"]);
  });

  it("covers every declared refusal reason", () => {
    expect([...DR_WRITE_REFUSAL_REASONS]).toEqual([
      "stale_observation",
      "illegal_transition",
      "row_vanished",
    ]);
  });

  it("carries the table and reason on the error, not only in its message", async () => {
    const conn = mockConnection(undefined, { rows: [], rowCount: 0 });
    const err = await refuseUnlessWritten(conn, 0, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DrExecutionWriteRefusedError);
    expect((err as DrExecutionWriteRefusedError).table).toBe("meta.dr_failover_executions");
  });
});

describe("the guard is a performance of the contract, not a copy of it", () => {
  it("renders every status in FAILOVER_STATUSES that has an outgoing edge", () => {
    const sql = failoverStatusGuard(T);
    const withEdges = FAILOVER_STATUSES.filter(
      (s: FailoverStatus) => FAILOVER_TRANSITIONS[s].length > 0,
    );
    for (const s of withEdges) expect(sql).toContain(`('${s}', `);
  });

  it("renders as many pairs as the map has edges", () => {
    const edges = FAILOVER_STATUSES.reduce(
      (n, s) => n + FAILOVER_TRANSITIONS[s].length,
      0,
    );
    const rendered = failoverStatusGuard(T).match(/\('[a-z_]+', '[a-z_]+'\)/g) ?? [];
    expect(rendered).toHaveLength(edges);
  });
});
