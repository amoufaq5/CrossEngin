import { describe, expect, it } from "vitest";

import {
  KILL_SWITCH_COLUMNS,
  KILL_SWITCH_COLUMN_NAMES,
  killSwitchPlaceholders,
  killSwitchRowValues,
  killSwitchUpdateAssignments,
  rowToKillSwitch,
} from "./records.js";
import {
  ARMER,
  FLAG_ID,
  INCIDENT_ID,
  KILL_SWITCH_ID,
  RELEASER,
  T0,
  T1,
  T2,
  TENANT,
  TRIGGERER,
  killSwitch,
  killSwitchRow,
  releasedKillSwitch,
} from "./test-fakes.js";

const at = (col: string): number => KILL_SWITCH_COLUMN_NAMES.indexOf(col);

describe("KILL_SWITCH_COLUMN_NAMES", () => {
  it("has no duplicates", () => {
    expect(new Set(KILL_SWITCH_COLUMN_NAMES).size).toBe(KILL_SWITCH_COLUMN_NAMES.length);
  });

  it("starts with kill_switch_id, the key an UPDATE matches on", () => {
    expect(KILL_SWITCH_COLUMN_NAMES[0]).toBe("kill_switch_id");
  });

  it("omits the surrogate id column, which has a database default", () => {
    expect(KILL_SWITCH_COLUMN_NAMES).not.toContain("id");
  });

  it("joins into the column list", () => {
    expect(KILL_SWITCH_COLUMNS).toBe(KILL_SWITCH_COLUMN_NAMES.join(", "));
  });

  it("is frozen, so no caller can reorder it under a prepared statement", () => {
    expect(Object.isFrozen(KILL_SWITCH_COLUMN_NAMES)).toBe(true);
  });

  it("covers every column of meta.feature_flag_kill_switches bar the surrogate key", () => {
    expect([...KILL_SWITCH_COLUMN_NAMES].sort()).toEqual(
      [
        "armed_at",
        "armed_by_user_id",
        "co_triggered_at",
        "co_triggered_by_user_id",
        "expired_at",
        "expires_at",
        "flag_id",
        "impact_scope_notes",
        "justification",
        "kill_switch_id",
        "overridden_value_json",
        "related_incident_id",
        "released_at",
        "released_by_user_id",
        "released_reason",
        "status",
        "tenant_id",
        "trigger_kind",
        "triggered_at",
        "triggered_by_user_id",
      ].sort(),
    );
  });
});

describe("killSwitchPlaceholders", () => {
  it("emits one placeholder per column, numbered from 1", () => {
    const parts = killSwitchPlaceholders().split(", ");
    expect(parts).toHaveLength(KILL_SWITCH_COLUMN_NAMES.length);
    expect(parts[0]).toBe("$1");
    expect(parts[parts.length - 1]).toBe(`$${KILL_SWITCH_COLUMN_NAMES.length}`);
  });

  it("casts nothing — no column of this table is JSONB", () => {
    expect(killSwitchPlaceholders()).not.toContain("::");
  });
});

describe("killSwitchUpdateAssignments", () => {
  it("skips the first column and starts binding at $2", () => {
    const parts = killSwitchUpdateAssignments().split(", ");
    expect(parts).toHaveLength(KILL_SWITCH_COLUMN_NAMES.length - 1);
    expect(parts[0]).toBe("tenant_id = $2");
  });

  it("never assigns kill_switch_id, which the WHERE clause matches on", () => {
    expect(killSwitchUpdateAssignments()).not.toContain("kill_switch_id =");
  });

  it("agrees with the placeholder numbering for every shared column", () => {
    for (const col of KILL_SWITCH_COLUMN_NAMES.slice(1)) {
      expect(killSwitchUpdateAssignments()).toContain(`${col} = $${at(col) + 1}`);
    }
  });
});

describe("killSwitchRowValues", () => {
  it("supplies exactly one value per column", () => {
    expect(killSwitchRowValues(killSwitch())).toHaveLength(
      KILL_SWITCH_COLUMN_NAMES.length,
    );
  });

  it("binds the contract id to kill_switch_id", () => {
    expect(killSwitchRowValues(killSwitch())[at("kill_switch_id")]).toBe(KILL_SWITCH_ID);
  });

  it("binds the contract flagId to flag_id verbatim", () => {
    expect(killSwitchRowValues(killSwitch())[at("flag_id")]).toBe(FLAG_ID);
  });

  it("writes a platform-wide switch with a null tenant_id", () => {
    expect(killSwitchRowValues(killSwitch())[at("tenant_id")]).toBeNull();
  });

  it("writes a tenant-scoped switch with its tenant_id", () => {
    const values = killSwitchRowValues(killSwitch({ tenantId: TENANT }));
    expect(values[at("tenant_id")]).toBe(TENANT);
  });

  it("carries the incident link the restart path reads", () => {
    expect(killSwitchRowValues(killSwitch())[at("related_incident_id")]).toBe(INCIDENT_ID);
  });

  it("nulls impact_scope_notes when the optional field is absent", () => {
    expect(killSwitchRowValues(killSwitch())[at("impact_scope_notes")]).toBeNull();
  });

  it("writes impact_scope_notes when present", () => {
    const values = killSwitchRowValues(killSwitch({ impactScopeNotes: "checkout only" }));
    expect(values[at("impact_scope_notes")]).toBe("checkout only");
  });

  it("writes the release trio for a released record", () => {
    const values = killSwitchRowValues(releasedKillSwitch());
    expect(values[at("released_at")]).toBe(T2);
    expect(values[at("released_by_user_id")]).toBe(RELEASER);
    expect(values[at("released_reason")]).toBe(
      "error budget recovered; burn rate back under 1x",
    );
  });

  it("keeps the overridden value as the JSON text the contract validated", () => {
    expect(killSwitchRowValues(killSwitch())[at("overridden_value_json")]).toBe("false");
  });

  it("refuses a record whose overriddenValueJson is not JSON", () => {
    const bad = { ...killSwitch(), overriddenValueJson: "not json" };
    expect(() => killSwitchRowValues(bad)).toThrow();
  });

  it("refuses a triggered record missing triggeredByUserId", () => {
    const bad = { ...killSwitch(), triggeredByUserId: null };
    expect(() => killSwitchRowValues(bad)).toThrow();
  });

  it("refuses a released record missing its reason", () => {
    const bad = { ...releasedKillSwitch(), releasedReason: null };
    expect(() => killSwitchRowValues(bad)).toThrow();
  });

  it("refuses an incident_response trigger with no incident link", () => {
    const bad = {
      ...killSwitch(),
      triggerKind: "incident_response" as const,
      relatedIncidentId: null,
    };
    expect(() => killSwitchRowValues(bad)).toThrow();
  });

  it("refuses a manual_admin trigger co-triggered by the arming user", () => {
    const bad = {
      ...killSwitch(),
      triggerKind: "manual_admin" as const,
      coTriggeredByUserId: ARMER,
      coTriggeredAt: T1,
    };
    expect(() => killSwitchRowValues(bad)).toThrow();
  });
});

describe("rowToKillSwitch", () => {
  it("round-trips a triggered switch through the row projection", () => {
    const record = killSwitch();
    expect(rowToKillSwitch(killSwitchRow(record))).toEqual(record);
  });

  it("round-trips a released switch", () => {
    const record = releasedKillSwitch();
    expect(rowToKillSwitch(killSwitchRow(record))).toEqual(record);
  });

  it("round-trips a tenant-scoped switch", () => {
    const record = killSwitch({ tenantId: TENANT });
    expect(rowToKillSwitch(killSwitchRow(record))).toEqual(record);
  });

  it("omits impactScopeNotes rather than nulling it, since the schema says optional", () => {
    const parsed = rowToKillSwitch(killSwitchRow(killSwitch()));
    expect("impactScopeNotes" in parsed).toBe(false);
  });

  it("keeps impactScopeNotes when the column holds one", () => {
    const record = killSwitch({ impactScopeNotes: "EU region only" });
    expect(rowToKillSwitch(killSwitchRow(record)).impactScopeNotes).toBe("EU region only");
  });

  it("normalizes Date-typed timestamp columns to ISO strings", () => {
    const row = { ...killSwitchRow(killSwitch()), armed_at: new Date(T0) };
    expect(rowToKillSwitch(row).armedAt).toBe(T0);
  });

  it("normalizes a nullable Date column too", () => {
    const row = { ...killSwitchRow(killSwitch()), triggered_at: new Date(T1) };
    expect(rowToKillSwitch(row).triggeredAt).toBe(T1);
  });

  it("reads a missing nullable column as null, not undefined", () => {
    const row = { ...killSwitchRow(killSwitch()) };
    delete row["expires_at"];
    expect(rowToKillSwitch(row).expiresAt).toBeNull();
  });

  it("re-validates: rejects a row hand-edited to released without a releasing user", () => {
    const row = { ...killSwitchRow(releasedKillSwitch()), released_by_user_id: null };
    expect(() => rowToKillSwitch(row)).toThrow();
  });

  it("re-validates: rejects a row whose co-trigger equals its trigger user", () => {
    const row = {
      ...killSwitchRow(killSwitch()),
      trigger_kind: "manual_admin",
      co_triggered_by_user_id: TRIGGERER,
      co_triggered_at: T1,
    };
    expect(() => rowToKillSwitch(row)).toThrow();
  });

  it("re-validates: rejects a row whose expires_at precedes armed_at", () => {
    const row = { ...killSwitchRow(killSwitch()), expires_at: "2026-09-30T09:00:00.000Z" };
    expect(() => rowToKillSwitch(row)).toThrow();
  });

  it("re-validates: rejects a row with an out-of-vocabulary status", () => {
    const row = { ...killSwitchRow(killSwitch()), status: "disarmed" };
    expect(() => rowToKillSwitch(row)).toThrow();
  });

  it("re-validates: rejects a row whose kill_switch_id lost its prefix", () => {
    const row = { ...killSwitchRow(killSwitch()), kill_switch_id: "slo00001" };
    expect(() => rowToKillSwitch(row)).toThrow();
  });
});
