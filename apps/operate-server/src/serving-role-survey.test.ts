import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  formatServingRoleSurvey,
  SERVING_ROLE_VERDICT_IS_HEALTHY,
  SERVING_ROLE_VERDICTS,
  surveyServingRole,
} from "./serving-role-survey.js";

interface Facts {
  readonly role?: string;
  readonly active: boolean;
  readonly bypass?: boolean;
  readonly owner?: boolean;
  readonly superuser?: boolean;
  readonly forced?: boolean;
}

function row(f: Facts): Record<string, unknown> {
  return {
    role: f.role ?? "crossengin_app",
    policies_active: f.active,
    bypasses_rls: f.bypass ?? false,
    is_owner: f.owner ?? false,
    rls_enabled: true,
    rls_forced: f.forced ?? false,
    is_superuser: f.superuser ?? false,
  };
}

function conn(rows: readonly Record<string, unknown>[] | Error): {
  readonly conn: PgConnection;
  readonly calls: { sql: string; params: readonly unknown[] }[];
} {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const c = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (rows instanceof Error) throw rows;
      return { rows, rowCount: rows.length };
    },
    transaction: async () => {
      throw new Error("the survey opens no transaction");
    },
    close: async () => undefined,
  } as unknown as PgConnection;
  return { conn: c, calls };
}

describe("surveyServingRole", () => {
  it("asks Postgres's own verdict over the policied tables of the named schema", async () => {
    const { conn: c, calls } = conn([row({ active: true })]);
    await surveyServingRole(c, ["meta"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([["meta"]]);
    // The verdict is row_security_active, through the shared select list, never a composition of
    // ownership and attributes (ADR-0362).
    expect(calls[0]?.sql).toContain("row_security_active(c.oid)");
    // The filter, and not the select list (which also names `c.relrowsecurity`): without it the 32
    // `meta` tables carrying no RLS answer `row_security_active = false` for a confined role, so the
    // survey would report a confined session as bypassing — measured 32 of 147 on a fresh catalog.
    expect(calls[0]?.sql).toMatch(/\bWHERE n\.nspname = ANY\(\$1::text\[\]\) AND c\.relkind IN \('r', 'p'\) AND c\.relrowsecurity\s*$/);
  });

  it("surveys every schema it is handed in one statement, and names them all", async () => {
    // `--store pg-columns`: the entity tables in the column store's schema are created by the
    // serving process at boot, so it owns them, while `meta` belongs to the migrate owner. A survey
    // of `meta` alone would answer "confined" for a process whose every record read bypasses.
    const { conn: c, calls } = conn([
      row({ active: true }),
      row({ active: false, owner: true }),
      row({ active: false, owner: true }),
    ]);
    const s = await surveyServingRole(c, ["meta", "public"]);
    expect(calls[0]?.params).toEqual([["meta", "public"]]);
    expect(s).toMatchObject({ verdict: "bypasses_rls", schemas: ["meta", "public"], bypassedTables: 2 });
    const [line] = formatServingRoleSurvey(s, false);
    expect(line?.text).toContain("2 of 3 policied table(s) in schemas meta, public");
    expect(line?.text).toContain("it owns them (2)");
  });

  it("is confined when every policied table applies its policies", async () => {
    const s = await surveyServingRole(conn([row({ active: true }), row({ active: true })]).conn, ["meta"]);
    expect(s).toMatchObject({ verdict: "confined", role: "crossengin_app", policiedTables: 2, bypassedTables: 0 });
  });

  it("names the image superuser as a superuser, not by its BYPASSRLS bit", async () => {
    // The official image's POSTGRES_USER carries both, and dropping only BYPASSRLS leaves it
    // unconfined, so the cause that names the remedy is the superuser one.
    const rows = [1, 2, 3].map(() => row({ role: "crossengin", active: false, bypass: true, owner: true, superuser: true }));
    const s = await surveyServingRole(conn(rows).conn, ["meta"]);
    expect(s.verdict).toBe("bypasses_rls");
    expect(s.bypassedTables).toBe(3);
    expect(s.causes).toEqual({ superuser: 3, bypassrls: 0, owner: 0, exempt: 0 });
  });

  it("counts each non-superuser cause separately, and a forced owner as confined", async () => {
    const s = await surveyServingRole(
      conn([
        row({ active: false, bypass: true }),
        row({ active: false, owner: true }),
        row({ active: false }),
        row({ active: true, owner: true, forced: true }),
      ]).conn,
      ["meta"],
    );
    expect(s).toMatchObject({ verdict: "bypasses_rls", policiedTables: 4, bypassedTables: 3 });
    expect(s.causes).toEqual({ superuser: 0, bypassrls: 1, owner: 1, exempt: 1 });
  });

  it("says it asked nothing when the schema holds no policied table", async () => {
    const s = await surveyServingRole(conn([]).conn, ["meta"]);
    expect(s.verdict).toBe("no_policied_tables");
    expect(s.role).toBeNull();
  });

  it("reports a failed probe rather than throwing, since a boot report must not refuse", async () => {
    const s = await surveyServingRole(conn(new Error("permission denied for schema meta")).conn, ["meta"]);
    expect(s).toMatchObject({ verdict: "unreadable", detail: "permission denied for schema meta" });
  });

  it("reads an unreadable verdict column as unreadable, never as confined", async () => {
    // The kernel's parse is strict because a missing verdict read permissively would be "not
    // bypassing", the reassuring direction; here it becomes a report rather than a boot failure.
    const bad = { ...row({ active: true }), policies_active: null };
    const s = await surveyServingRole(conn([row({ active: true }), bad]).conn, ["meta"]);
    expect(s.verdict).toBe("unreadable");
    expect(s.detail).toMatch(/policies_active/);
  });
});

describe("formatServingRoleSurvey", () => {
  it("is healthy for confined alone, over the whole enum", () => {
    expect(SERVING_ROLE_VERDICTS.filter((v) => SERVING_ROLE_VERDICT_IS_HEALTHY[v])).toEqual(["confined"]);
  });

  it("warns on a bypassing session, names the cause and the remedy", async () => {
    const s = await surveyServingRole(
      conn([row({ role: "crossengin", active: false, bypass: true, owner: true, superuser: true })]).conn,
      ["meta"],
    );
    const lines = formatServingRoleSurvey(s, false);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.text).toContain("role crossengin BYPASSES the policies on 1 of 1");
    expect(lines[0]?.text).toContain("it is a superuser (1)");
    expect(lines[0]?.text).toContain("POSTGRES_APP_USER");
    expect(lines[0]?.text).not.toContain("BYPASSRLS (");
  });

  it("is one info line for a confined session with no deletion declared", async () => {
    const lines = formatServingRoleSurvey(await surveyServingRole(conn([row({ active: true })]).conn, ["meta"]), false);
    expect(lines).toEqual([
      expect.objectContaining({ level: "info", text: expect.stringContaining("is confined on all 1") }),
    ]);
  });

  it("warns that the erasure will refuse when a confined session declares deletion capabilities", async () => {
    const lines = formatServingRoleSurvey(await surveyServingRole(conn([row({ active: true })]).conn, ["meta"]), true);
    expect(lines.map((l) => l.level)).toEqual(["info", "warn"]);
    expect(lines[1]?.text).toContain("rls_would_confine_this_session");
  });

  it("does not add the erasure line to a bypassing session, whose erasure is not refused", async () => {
    const s = await surveyServingRole(conn([row({ active: false, bypass: true })]).conn, ["meta"]);
    expect(formatServingRoleSurvey(s, true)).toHaveLength(1);
  });

  it("warns, naming nothing as established, for the two non-answers", async () => {
    for (const s of [
      await surveyServingRole(conn([]).conn, ["meta"]),
      await surveyServingRole(conn(new Error("boom")).conn, ["meta"]),
    ]) {
      const lines = formatServingRoleSurvey(s, true);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("warn");
      expect(lines[0]?.text).not.toContain("confined on all");
    }
  });
});
