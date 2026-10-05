import {
  META_TABLES,
  META_WORKFLOW_ACTIVITIES,
  META_WORKFLOW_SIGNALS,
  META_WORKFLOW_TIMERS,
  type TableDefinition,
} from "@crossengin/kernel/bootstrap";
import { describe, expect, it } from "vitest";

import {
  insertColumnList,
  missingRequiredColumns,
  requiredColumnNames,
} from "./required-columns.js";

const INSERT = `INSERT INTO meta.widgets (
   a, b,
   c
 )
 VALUES ($1, $2, $3)
 ON CONFLICT (a) DO UPDATE SET b = EXCLUDED.b`;

describe("requiredColumnNames", () => {
  it("includes a notNull column with no default", () => {
    expect(requiredColumnNames(META_WORKFLOW_TIMERS)).toContain("kind");
  });

  it("excludes a notNull column that carries a default", () => {
    // `timezone` DEFAULT 'UTC' and `fire_count` DEFAULT 0: NOT NULL, yet Postgres fills them.
    expect(requiredColumnNames(META_WORKFLOW_TIMERS)).not.toContain("timezone");
    expect(requiredColumnNames(META_WORKFLOW_TIMERS)).not.toContain("fire_count");
  });

  it("excludes a nullable column", () => {
    expect(requiredColumnNames(META_WORKFLOW_TIMERS)).not.toContain("cancelled_at");
  });

  it("excludes the generated primary key", () => {
    expect(requiredColumnNames(META_WORKFLOW_TIMERS)).not.toContain("id");
  });

  it("answers for a hand-built table", () => {
    const table: TableDefinition = {
      schema: "meta",
      name: "probe",
      columns: [
        { name: "a", type: "TEXT", notNull: true },
        { name: "b", type: "TEXT", notNull: true, default: "'x'" },
        { name: "c", type: "TEXT" },
        { name: "d", type: "TEXT", notNull: false },
      ],
      primaryKey: ["a"],
    };
    expect(requiredColumnNames(table)).toEqual(["a"]);
  });

  it("answers [] for a table with no required columns", () => {
    const table: TableDefinition = {
      schema: "meta",
      name: "probe",
      columns: [{ name: "a", type: "TEXT" }],
      primaryKey: ["a"],
    };
    expect(requiredColumnNames(table)).toEqual([]);
  });

  it("every META_TABLES entry answers without throwing", () => {
    for (const table of META_TABLES) {
      expect(Array.isArray(requiredColumnNames(table))).toBe(true);
    }
  });
});

describe("insertColumnList", () => {
  it("reads a multi-line column list in order", () => {
    expect(insertColumnList(INSERT)).toEqual(["a", "b", "c"]);
  });

  it("reads a single-line column list", () => {
    expect(insertColumnList("INSERT INTO meta.w (x, y) VALUES ($1, $2)")).toEqual(["x", "y"]);
  });

  it("stops at the first closing paren, not the VALUES list", () => {
    expect(insertColumnList("INSERT INTO meta.w (x) VALUES ($1, $2, $3)")).toEqual(["x"]);
  });

  it("throws on a statement that is not an INSERT", () => {
    expect(() => insertColumnList("UPDATE meta.w SET x = $1")).toThrow(/not an INSERT/);
  });

  it("throws rather than answering [] on an unterminated list", () => {
    expect(() => insertColumnList("INSERT INTO meta.w (x, y")).toThrow(/unterminated/);
  });

  it("throws on an INSERT with no column list at all", () => {
    expect(() => insertColumnList("INSERT INTO meta.w VALUES ($1)")).toThrow();
  });
});

describe("missingRequiredColumns", () => {
  it("is empty when every required column is named", () => {
    const table: TableDefinition = {
      schema: "meta",
      name: "probe",
      columns: [
        { name: "a", type: "TEXT", notNull: true },
        { name: "b", type: "TEXT", notNull: true },
      ],
      primaryKey: ["a"],
    };
    expect(missingRequiredColumns(table, "INSERT INTO meta.probe (a, b) VALUES ($1, $2)")).toEqual(
      [],
    );
  });

  it("names the omitted required column", () => {
    const table: TableDefinition = {
      schema: "meta",
      name: "probe",
      columns: [
        { name: "a", type: "TEXT", notNull: true },
        { name: "b", type: "TEXT", notNull: true },
      ],
      primaryKey: ["a"],
    };
    expect(missingRequiredColumns(table, "INSERT INTO meta.probe (a) VALUES ($1)")).toEqual(["b"]);
  });

  it("reproduces the three defects of this class", () => {
    // The statements as they stood: the signal store's nine columns (ADR-0331) and the timer and
    // activity stores' (ADR-0332). Pinned so the regression is a *test* rather than a memory.
    const signalInsert = `INSERT INTO meta.workflow_signals (
      signal_id, instance_id, tenant_id, signal_name, correlation_key,
      status, received_at, matched_at, consumed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
    expect(missingRequiredColumns(META_WORKFLOW_SIGNALS, signalInsert)).toEqual([
      "delivery_guarantee",
      "source_system",
    ]);

    const timerInsert = `INSERT INTO meta.workflow_timers (
      timer_id, instance_id, tenant_id, timer_name, status, scheduled_at,
      fire_at, fired_at, cancelled_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
    expect(missingRequiredColumns(META_WORKFLOW_TIMERS, timerInsert)).toEqual(["kind"]);

    const activityInsert = `INSERT INTO meta.workflow_activities (
      activity_id, instance_id, tenant_id, definition_activity_key, kind,
      status, attempt_number, scheduled_at, started_at, completed_at,
      input_sha256, output_sha256, error_code, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`;
    expect(missingRequiredColumns(META_WORKFLOW_ACTIVITIES, activityInsert)).toEqual([
      "label",
      "max_attempts",
      "retry_policy",
      "timeout_seconds",
      "timeout_at",
      "sequence_cursor",
    ]);
  });
});
