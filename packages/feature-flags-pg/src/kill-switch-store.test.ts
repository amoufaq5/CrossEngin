import { describe, expect, it } from "vitest";

import {
  KILL_SWITCH_COLUMNS,
  KILL_SWITCH_COLUMN_NAMES,
  killSwitchUpdateAssignments,
} from "./records.js";
import {
  KILL_SWITCH_PARAM_COUNT,
  KillSwitchNotFoundError,
  PostgresKillSwitchStore,
  SET_PLATFORM_CONFIG_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  assertTenantId,
} from "./kill-switch-store.js";
import {
  type Captured,
  EMPTY,
  FLAG_ID,
  INCIDENT_ID,
  KILL_SWITCH_ID,
  TENANT,
  killSwitch,
  killSwitchRow,
  mockConnection,
  written,
  releasedKillSwitch,
  respondTo,
} from "./test-fakes.js";

const rows = (...records: ReturnType<typeof killSwitch>[]): {
  rows: Record<string, unknown>[];
  rowCount: number;
} => ({ rows: records.map((r) => killSwitchRow(r)), rowCount: records.length });

describe("assertTenantId", () => {
  it("accepts a uuid", () => {
    expect(() => assertTenantId(TENANT)).not.toThrow();
  });

  it("refuses anything that could close the set_config literal", () => {
    expect(() => assertTenantId("'); DROP TABLE meta.feature_flags; --")).toThrow(
      /invalid tenantId/,
    );
  });
});

describe("PostgresKillSwitchStore construction", () => {
  it("defaults to the meta schema", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).load(KILL_SWITCH_ID);
    expect(capture[0]?.sql).toContain("meta.feature_flag_kill_switches");
  });

  it("honours an override schema", async () => {
    const capture: Captured[] = [];
    const store = new PostgresKillSwitchStore(mockConnection(capture), {
      schema: "other_meta",
    });
    await store.load(KILL_SWITCH_ID);
    expect(capture[0]?.sql).toContain("other_meta.feature_flag_kill_switches");
  });

  it("refuses a schema name that is not a bare identifier", () => {
    expect(
      () => new PostgresKillSwitchStore(mockConnection(), { schema: 'meta"; DROP' }),
    ).toThrow(/invalid schema identifier/);
  });
});

describe("record", () => {
  it("inserts the full column list with matching placeholders", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).record(killSwitch());
    expect(written(capture).sql).toContain(
      `INSERT INTO meta.feature_flag_kill_switches (${KILL_SWITCH_COLUMNS})`,
    );
    expect(written(capture).sql).toContain(`$${KILL_SWITCH_COLUMN_NAMES.length})`);
  });

  it("binds one parameter per column", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).record(killSwitch());
    expect(written(capture).params).toHaveLength(KILL_SWITCH_PARAM_COUNT);
  });

  it("binds the kill switch id first", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).record(killSwitch());
    expect(written(capture).params?.[0]).toBe(KILL_SWITCH_ID);
  });

  it("claims the platform config-write elevation, and sets no tenant context, for a platform-wide switch", async () => {
    // It used to set nothing at all. That read as "RLS exposes the null-tenant rows", which was
    // true — and the same `tenant_id IS NULL` arm that exposed them to a reader satisfied the
    // `WITH CHECK` of the one `ALL`-scope policy, so any tenant session could arm a platform-wide
    // kill switch. The write arm is a separate `INSERT`-scoped policy on this setting now.
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).record(killSwitch());
    expect(capture).toHaveLength(2);
    expect(capture[0]?.sql).toBe(SET_PLATFORM_CONFIG_WRITE_SQL);
    expect(capture[0]?.sql).toContain("app.platform_config_write");
    expect(capture[0]?.params).toBeUndefined();
    expect(capture[1]?.sql).toContain("INSERT INTO");
  });

  it("never claims the elevation and a tenant context in one transaction", async () => {
    // Both at once would give one transaction a predicate satisfiable by a tenant row and a
    // platform row, which is the shape the split exists to take apart.
    for (const tenantId of [null, TENANT]) {
      const capture: Captured[] = [];
      await new PostgresKillSwitchStore(mockConnection(capture)).record(killSwitch({ tenantId }));
      const settings = capture.filter((c) => c.sql.includes("set_config"));
      expect(settings).toHaveLength(1);
    }
  });

  it("claims the elevation transaction-locally, never session-wide", async () => {
    // `set_config(..., true)` — the third argument is `is_local`. A session-wide `SET` on a pooled
    // connection would carry the elevation into the next caller's work.
    expect(SET_PLATFORM_CONFIG_WRITE_SQL).toContain(", true)");
    expect(SET_PLATFORM_CONFIG_WRITE_SQL.startsWith("SET ")).toBe(false);
  });

  it("does not reuse the cross-tenant read grant as the write grant", async () => {
    // ADR-0313's hole arriving from the other direction: a grant that authorises reading the
    // platform's rows must not authorise writing them.
    expect(SET_PLATFORM_CONFIG_WRITE_SQL).not.toContain("app.platform_audit");
  });

  it("sets the tenant context before inserting a tenant-scoped switch", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).record(
      killSwitch({ tenantId: TENANT }),
    );
    expect(capture).toHaveLength(2);
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(capture[0]?.params).toEqual([TENANT]);
    expect(capture[1]?.sql).toContain("INSERT INTO");
  });

  it("refuses to write a record the contract rejects", async () => {
    const capture: Captured[] = [];
    const store = new PostgresKillSwitchStore(mockConnection(capture));
    const bad = { ...killSwitch(), triggeredAt: null };
    await expect(store.record(bad)).rejects.toThrow();
    expect(capture).toHaveLength(0);
  });
});

describe("loadForIncident", () => {
  it("filters on the incident link and the active predicate", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture, () => EMPTY)).loadForIncident(
      INCIDENT_ID,
    );
    expect(capture[0]?.sql).toContain("WHERE related_incident_id = $1");
    expect(capture[0]?.sql).toContain("status = 'triggered_active'");
    expect(capture[0]?.sql).toContain("expires_at IS NULL OR expires_at > now()");
    expect(capture[0]?.params).toEqual([INCIDENT_ID]);
  });

  it("asks for two rows so a duplicate is visible rather than hidden by LIMIT 1", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture, () => EMPTY)).loadForIncident(
      INCIDENT_ID,
    );
    expect(capture[0]?.sql).toContain("LIMIT 2");
  });

  it("returns null when the incident rolled nothing back", async () => {
    const store = new PostgresKillSwitchStore(mockConnection(undefined, () => EMPTY));
    await expect(store.loadForIncident(INCIDENT_ID)).resolves.toBeNull();
  });

  it("returns the switch the SLO loop needs to name after a restart", async () => {
    const record = killSwitch();
    const store = new PostgresKillSwitchStore(
      mockConnection(undefined, respondTo([["related_incident_id", rows(record)]])),
    );
    await expect(store.loadForIncident(INCIDENT_ID)).resolves.toEqual(record);
  });

  it("throws rather than pick one when two switches are active for one incident", async () => {
    const two = rows(killSwitch(), killSwitch({ id: "fks_slo00002" }));
    const store = new PostgresKillSwitchStore(
      mockConnection(undefined, respondTo([["related_incident_id", two]])),
    );
    await expect(store.loadForIncident(INCIDENT_ID)).rejects.toThrow(
      /more than one active kill switch/,
    );
  });

  it("sets the tenant context when the caller knows whose switch it wants", async () => {
    const capture: Captured[] = [];
    const store = new PostgresKillSwitchStore(mockConnection(capture, () => EMPTY));
    await store.loadForIncident(INCIDENT_ID, TENANT);
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(capture[1]?.sql).toContain("related_incident_id");
  });
});

describe("load", () => {
  it("selects the stored columns by kill switch id", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture, () => EMPTY)).load(
      KILL_SWITCH_ID,
    );
    expect(capture[0]?.sql).toContain(`SELECT ${KILL_SWITCH_COLUMNS}`);
    expect(capture[0]?.sql).toContain("WHERE kill_switch_id = $1");
    expect(capture[0]?.params).toEqual([KILL_SWITCH_ID]);
  });

  it("returns null for an unknown id", async () => {
    const store = new PostgresKillSwitchStore(mockConnection(undefined, () => EMPTY));
    await expect(store.load(KILL_SWITCH_ID)).resolves.toBeNull();
  });

  it("parses the row back into the record, release fields and all", async () => {
    const record = releasedKillSwitch();
    const store = new PostgresKillSwitchStore(
      mockConnection(undefined, respondTo([["WHERE kill_switch_id", rows(record)]])),
    );
    await expect(store.load(KILL_SWITCH_ID)).resolves.toEqual(record);
  });
});

describe("listActiveForFlag", () => {
  it("filters on the flag and the active predicate, newest first", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture, () => EMPTY)).listActiveForFlag(
      FLAG_ID,
    );
    expect(capture[0]?.sql).toContain("WHERE flag_id = $1");
    expect(capture[0]?.sql).toContain("status = 'triggered_active'");
    expect(capture[0]?.sql).toContain("ORDER BY armed_at DESC");
  });

  it("defaults the limit to 100", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture, () => EMPTY)).listActiveForFlag(
      FLAG_ID,
    );
    expect(capture[0]?.params).toEqual([FLAG_ID, 100]);
  });

  it("binds a caller's limit", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture, () => EMPTY)).listActiveForFlag(
      FLAG_ID,
      5,
    );
    expect(capture[0]?.params).toEqual([FLAG_ID, 5]);
  });

  it("refuses a non-positive limit instead of emitting LIMIT 0", async () => {
    const capture: Captured[] = [];
    const store = new PostgresKillSwitchStore(mockConnection(capture));
    await expect(store.listActiveForFlag(FLAG_ID, 0)).rejects.toThrow(/limit must be positive/);
    expect(capture).toHaveLength(0);
  });

  it("parses every row it gets back", async () => {
    const a = killSwitch();
    const b = killSwitch({ id: "fks_slo00002" });
    const store = new PostgresKillSwitchStore(
      mockConnection(undefined, respondTo([["flag_id = $1", rows(a, b)]])),
    );
    await expect(store.listActiveForFlag(FLAG_ID)).resolves.toEqual([a, b]);
  });

  it("returns an empty list rather than null when nothing is active", async () => {
    const store = new PostgresKillSwitchStore(mockConnection(undefined, () => EMPTY));
    await expect(store.listActiveForFlag(FLAG_ID)).resolves.toEqual([]);
  });
});

describe("release", () => {
  it("refuses a record that is not released, so the method cannot be used to overwrite a row", async () => {
    const capture: Captured[] = [];
    const store = new PostgresKillSwitchStore(mockConnection(capture));
    await expect(store.release(killSwitch())).rejects.toThrow(/needs a released record/);
    expect(capture).toHaveLength(0);
  });

  it("updates every non-key column and matches on the id", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).release(releasedKillSwitch());
    expect(written(capture).sql).toContain(`SET ${killSwitchUpdateAssignments()}`);
    expect(written(capture).sql).toContain("WHERE kill_switch_id = $1");
    expect(written(capture).params?.[0]).toBe(KILL_SWITCH_ID);
    expect(written(capture).params).toHaveLength(KILL_SWITCH_PARAM_COUNT);
  });

  it("guards on the only status the transition map lets a release leave", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).release(releasedKillSwitch());
    expect(written(capture).sql).toContain("AND status IN ('triggered_active')");
  });

  it("treats a zero-row update as a failure, never a success", async () => {
    const store = new PostgresKillSwitchStore(mockConnection(undefined, () => EMPTY));
    await expect(store.release(releasedKillSwitch())).rejects.toBeInstanceOf(
      KillSwitchNotFoundError,
    );
  });

  it("names the switch in the not-found error", async () => {
    const store = new PostgresKillSwitchStore(mockConnection(undefined, () => EMPTY));
    await expect(store.release(releasedKillSwitch())).rejects.toThrow(KILL_SWITCH_ID);
  });

  it("resolves when one row was released", async () => {
    const store = new PostgresKillSwitchStore(mockConnection());
    await expect(store.release(releasedKillSwitch())).resolves.toBeUndefined();
  });

  it("scopes the update to the tenant that owns the switch", async () => {
    const capture: Captured[] = [];
    await new PostgresKillSwitchStore(mockConnection(capture)).release(
      releasedKillSwitch({ tenantId: TENANT }),
    );
    expect(capture[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(capture[1]?.sql).toContain("UPDATE meta.feature_flag_kill_switches");
  });
});

describe("KILL_SWITCH_PARAM_COUNT", () => {
  it("is one per persisted column", () => {
    expect(KILL_SWITCH_PARAM_COUNT).toBe(KILL_SWITCH_COLUMN_NAMES.length);
  });
});
