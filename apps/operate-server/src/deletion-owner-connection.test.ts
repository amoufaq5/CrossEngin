import type { PgConfig, PgConnection } from "@crossengin/kernel-pg";
import { ERASURE_REFUSAL_REASONS } from "@crossengin/operate-runtime-pg";
import { RETAINED_SHARED_TABLES, SCHEMA_ERASER_REFUSAL_REASONS } from "@crossengin/tenant-lifecycle-pg";
import { describe, expect, it } from "vitest";

import {
  DELETION_APPLICATION_NAME,
  DELETION_PGPASSWORD_VAR,
  DELETION_PGUSER_VAR,
  formatDeletionConnectionLine,
  probeDeletionConnection,
  resolveDeletionOwnerConfig,
  tenantSchemaDroppable,
} from "./deletion-owner-connection.js";

const SERVING: PgConfig = {
  host: "db",
  port: 5432,
  user: "crossengin_app",
  password: "app-secret",
  database: "crossengin",
  ssl: "prefer",
  sslRootCert: null,
  applicationName: "crossengin-pg",
};

describe("resolveDeletionOwnerConfig", () => {
  it("is absent with neither variable, so behaviour is unchanged", () => {
    expect(resolveDeletionOwnerConfig(SERVING, {})).toEqual({ kind: "absent" });
    expect(
      resolveDeletionOwnerConfig(SERVING, { [DELETION_PGUSER_VAR]: "", [DELETION_PGPASSWORD_VAR]: "" }),
    ).toEqual({ kind: "absent" });
  });

  it("changes only the role, its password and the application name", () => {
    const source = resolveDeletionOwnerConfig(SERVING, {
      [DELETION_PGUSER_VAR]: "crossengin",
      [DELETION_PGPASSWORD_VAR]: "owner-secret",
    });
    expect(source).toEqual({
      kind: "configured",
      config: {
        ...SERVING,
        user: "crossengin",
        password: "owner-secret",
        applicationName: DELETION_APPLICATION_NAME,
      },
    });
  });

  it("accepts a role with no password, which trust, peer and cert authentication need", () => {
    const source = resolveDeletionOwnerConfig(SERVING, { [DELETION_PGUSER_VAR]: "crossengin" });
    expect(source.kind).toBe("configured");
    if (source.kind === "configured") expect(source.config.password).toBe("");
  });

  it("refuses a password with no role, naming both variables and printing neither value", () => {
    expect(() => resolveDeletionOwnerConfig(SERVING, { [DELETION_PGPASSWORD_VAR]: "owner-secret" })).toThrow(
      /DELETION_PGPASSWORD is set and DELETION_PGUSER is not/,
    );
    try {
      resolveDeletionOwnerConfig(SERVING, { [DELETION_PGPASSWORD_VAR]: "owner-secret" });
    } catch (err) {
      expect(String(err)).not.toContain("owner-secret");
    }
  });
});

function probeConn(opts: {
  readonly role: string;
  readonly superuser?: boolean;
  readonly superuserMember?: boolean;
  /** Direct memberships, and the breadth counts the role question answers (ADR-0458). */
  readonly memberships?: readonly string[];
  readonly ownsMeta?: number;
  readonly updatableMeta?: number;
  readonly deletableRetained?: number;
  /** The serving connection's role, and whether this one inherits it. */
  readonly creatorRole?: string;
  readonly inheritsCreator?: boolean;
  /** `schema.table (PRIVILEGE)` the pipeline-privilege probe answers ungranted. */
  readonly pipelineUngranted?: readonly string[];
  /** Per-tenant schema names, and whether this role may drop each. */
  readonly schemas?: Readonly<Record<string, boolean>>;
  readonly unreadable?: readonly string[];
  readonly undeletable?: readonly string[];
  readonly confined?: readonly string[];
  readonly missing?: readonly string[];
  readonly unscoped?: readonly string[];
  readonly fails?: boolean;
}): {
  readonly conn: PgConnection;
  readonly calls: Array<{ readonly text: string; readonly params: readonly unknown[] }>;
} {
  const calls: Array<{ readonly text: string; readonly params: readonly unknown[] }> = [];
  const conn: PgConnection = {
    query: (async (text: string, params?: readonly unknown[]) => {
      calls.push({ text, params: params ?? [] });
      if (opts.fails === true) throw new Error("connect ECONNREFUSED");
      if (text === "SELECT current_user AS role") {
        return { rows: [{ role: opts.creatorRole ?? opts.role }], rowCount: 1 };
      }
      if (text.includes("current_user AS role")) {
        return {
          rows: [
            {
              role: opts.role,
              superuser: opts.superuser === true ? "on" : "off",
              superuser_member: opts.superuserMember === true,
              memberships: (opts.memberships ?? []).join(","),
              // bigint counts come back from node-postgres as strings.
              owns_meta: String(opts.ownsMeta ?? 0),
              updatable_meta: String(opts.updatableMeta ?? 0),
              deletable_retained: String(opts.deletableRetained ?? 0),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("FROM pg_roles r WHERE r.rolname = $1")) {
        return { rows: [{ droppable: opts.inheritsCreator === true }], rowCount: 1 };
      }
      if (text.includes("FROM unnest($2::text[], $3::text[]) AS q(table_name, privilege)")) {
        const schema = String(params?.[0] ?? "");
        const tables = (params?.[1] ?? []) as readonly string[];
        const privileges = (params?.[2] ?? []) as readonly string[];
        const rows = tables.map((table, i) => ({
          table_name: table,
          privilege: privileges[i],
          present: true,
          granted: !(opts.pipelineUngranted ?? []).includes(`${schema}.${table} (${privileges[i] ?? ""})`),
        }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("AS droppable FROM pg_namespace n WHERE n.nspname = $1")) {
        const name = String(params?.[0] ?? "");
        const droppable = opts.schemas?.[name];
        return droppable === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ droppable }], rowCount: 1 };
      }
      if (text.includes("FROM pg_namespace")) {
        const prefix = String(params?.[0] ?? "");
        const rows = Object.entries(opts.schemas ?? {})
          .filter(([name]) => name.startsWith(prefix))
          .map(([schema_name, droppable]) => ({ schema_name, droppable }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("row_security_active")) {
        const schema = String(params?.[0] ?? "");
        const names = (params?.[1] ?? []) as readonly string[];
        const rows = names
          .filter((name) => !(opts.missing ?? []).includes(`${schema}.${name}`))
          .map((name) => ({
            table_name: name,
            confined: (opts.confined ?? []).includes(`${schema}.${name}`),
            scoped: !(opts.unscoped ?? []).includes(`${schema}.${name}`),
            may_select: !(opts.unreadable ?? []).includes(`${schema}.${name}`),
            may_delete: !(opts.undeletable ?? []).includes(`${schema}.${name}`),
          }));
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unmodelled statement: ${text}`);
    }) as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return { conn, calls };
}

describe("probeDeletionConnection", () => {
  it("asks Postgres who the session is and runs the erasure's own probe", async () => {
    const p = probeConn({ role: "crossengin", superuser: true });
    const probe = await probeDeletionConnection(p.conn);
    expect(probe.kind).toBe("can_complete");
    if (probe.kind === "can_complete") {
      expect(probe.role).toBe("crossengin");
      expect(probe.superuser).toBe(true);
      expect(probe.probed).toBeGreaterThan(50);
    }
    expect(p.calls.some((c) => c.text.includes("row_security_active"))).toBe(true);
  });

  it("probes meta, which is the schema the pipeline erases — never a --schema it is not handed", async () => {
    const p = probeConn({ role: "crossengin" });
    await probeDeletionConnection(p.conn);
    const schemas = new Set(
      p.calls.filter((c) => c.text.includes("row_security_active")).map((c) => c.params[0]),
    );
    expect(schemas).toEqual(new Set(["meta"]));
  });

  it("reports a confined role with the tables it is confined on", async () => {
    const p = probeConn({ role: "crossengin_app", confined: ["meta.audit_log", "meta.operate_entity_records"] });
    const probe = await probeDeletionConnection(p.conn);
    expect(probe).toMatchObject({
      kind: "will_refuse",
      role: "crossengin_app",
      superuser: false,
      confined: ["meta.operate_entity_records"],
      missing: [],
      unscoped: [],
    });
  });

  it("does not answer can_complete when a table is missing or unscoped, however unconfined the role", async () => {
    const missing = await probeDeletionConnection(
      probeConn({ role: "crossengin", missing: ["meta.operate_entity_records"] }).conn,
    );
    expect(missing).toMatchObject({ kind: "will_refuse", missing: ["meta.operate_entity_records"], confined: [] });
    const unscoped = await probeDeletionConnection(
      probeConn({ role: "crossengin", unscoped: ["meta.operate_entity_records"] }).conn,
    );
    expect(unscoped).toMatchObject({ kind: "will_refuse", unscoped: ["meta.operate_entity_records"] });
  });

  it("tells a dedicated role from a superuser and from a member of one (ADR-0458)", async () => {
    const dedicated = await probeDeletionConnection(probeConn({ role: "crossengin_eraser" }).conn);
    expect(dedicated).toMatchObject({ kind: "can_complete", posture: "dedicated", superuser: false });
    const owner = await probeDeletionConnection(probeConn({ role: "crossengin", superuser: true }).conn);
    expect(owner).toMatchObject({ posture: "superuser", superuser: true });
    // Attributes are not inherited, but a member may SET ROLE to the superuser, so it is one.
    const member = await probeDeletionConnection(
      probeConn({ role: "crossengin_eraser", superuserMember: true }).conn,
    );
    expect(member).toMatchObject({ posture: "superuser_by_membership", superuser: true });
  });

  it("names a grant the erasure needs and the role lacks, and nothing for a statutory read-only table", async () => {
    const probe = await probeDeletionConnection(
      probeConn({
        role: "crossengin_eraser",
        undeletable: ["meta.operate_entity_records", "meta.invoices"],
      }).conn,
    );
    expect(probe).toMatchObject({
      kind: "will_refuse",
      unprivileged: ["meta.operate_entity_records (DELETE)"],
      confined: [],
    });
  });

  it("names the per-tenant schemas the role cannot drop, and ignores a name that is not one", async () => {
    const probe = await probeDeletionConnection(
      probeConn({
        role: "crossengin_eraser",
        schemas: {
          t_0123456789abcdef0123456789abcdef: false,
          t_fedcba9876543210fedcba9876543210: true,
          t_not_a_tenant_schema: false,
        },
      }).conn,
    );
    expect(probe).toMatchObject({
      kind: "can_complete",
      undroppableSchemas: ["t_0123456789abcdef0123456789abcdef"],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
    });
  });

  it("counts DELETE on a retained table as breadth, never on a fenced erasure target (ADR-0458, live)", async () => {
    // The restrictive DELETE fence also covers six tables a tenant must not delete and the erasure
    // does empty, so the eraser holds DELETE there; counting every fenced table read the provisioned
    // role as broader. The question is asked over the retention union, passed as the parameter.
    const p = probeConn({ role: "crossengin_eraser" });
    const probe = await probeDeletionConnection(p.conn);
    expect(probe).toMatchObject({ posture: "dedicated" });
    const role = p.calls.find((c) => c.text.includes("AS deletable_retained"));
    expect(role?.text).not.toContain("polpermissive");
    const asked = (role?.params[0] ?? []) as readonly string[];
    expect([...asked]).toEqual([...RETAINED_SHARED_TABLES]);
    expect(asked).toContain("audit_log");
    for (const erased of ["crypto_audit", "dr_drill_executions", "notification_suppressions"]) {
      expect(asked).not.toContain(erased);
    }
  });

  it("does not call a role dedicated because it lacks rolsuper: memberships, ownership and stray grants make it broader (ADR-0458)", async () => {
    // BYPASSRLS takes the restrictive DELETE fences out of play, so the absence of a grant is the
    // only protection the retained audit trail has — each breadth is a route around it.
    for (const [opts, phrase] of [
      [{ memberships: ["pg_write_all_data"] }, "a member of pg_write_all_data"],
      [{ memberships: ["crossengin_app", "pg_execute_server_program"] }, "a member of crossengin_app, pg_execute_server_program"],
      [{ ownsMeta: 146 }, "owns 146 meta table(s)"],
      [{ updatableMeta: 3 }, "may UPDATE 3 meta table(s)"],
      [{ deletableRetained: 1 }, "may DELETE from 1 retained table(s)"],
    ] as const) {
      const probe = await probeDeletionConnection(probeConn({ role: "crossengin_eraser", ...opts }).conn);
      expect(probe, phrase).toMatchObject({ posture: "broader", superuser: false });
      if (probe.kind === "unreachable") throw new Error("unreachable");
      expect(probe.breadth).toContain(phrase);
      const said = formatDeletionConnectionLine("configured", probe);
      expect(said.level, phrase).toBe("warn");
      expect(said.line).toContain(`broader than the erasure needs: ${phrase}`);
      expect(said.line).not.toContain("a dedicated role");
    }
    // The superuser postures outrank breadth: a superuser owns everything by definition.
    const owner = await probeDeletionConnection(
      probeConn({ role: "crossengin", superuser: true, ownsMeta: 146 }).conn,
    );
    expect(owner).toMatchObject({ posture: "superuser", breadth: [] });
  });

  it("asks structurally whether a later per-tenant schema is droppable, not only the ones present at boot (ADR-0458)", async () => {
    const creator = probeConn({ role: "crossengin" });
    const none = await probeDeletionConnection(probeConn({ role: "crossengin_eraser" }).conn);
    expect(none).toMatchObject({ futureSchemas: { kind: "not_applicable" } });
    const undroppable = await probeDeletionConnection(probeConn({ role: "crossengin_eraser" }).conn, {
      futureSchemaCreator: creator.conn,
    });
    expect(undroppable).toMatchObject({
      kind: "can_complete",
      undroppableSchemas: [],
      futureSchemas: { kind: "undroppable", owner: "crossengin" },
    });
    if (undroppable.kind === "unreachable") throw new Error("unreachable");
    // A fresh deployment has no per-tenant schema at boot, which is exactly when a snapshot says
    // nothing — the structural answer is what warns.
    const said = formatDeletionConnectionLine("configured", undroppable);
    expect(said.level).toBe("warn");
    expect(said.line).toContain("it can drop no per-tenant schema: they are created by crossengin");
    expect(said.line).toContain("--tenant-erasure-routes answers schema_not_droppable");
    const droppable = await probeDeletionConnection(
      probeConn({ role: "crossengin", superuser: true, inheritsCreator: true }).conn,
      { futureSchemaCreator: creator.conn },
    );
    expect(droppable).toMatchObject({ futureSchemas: { kind: "droppable", owner: "crossengin" } });
  });

  it("names a missing INSERT on a table the pipeline appends to as a missing grant (ADR-0458)", async () => {
    const probe = await probeDeletionConnection(
      probeConn({ role: "crossengin_eraser", pipelineUngranted: ["meta.tenant_tombstones (INSERT)"] }).conn,
    );
    expect(probe).toMatchObject({ kind: "will_refuse", unprivileged: ["meta.tenant_tombstones (INSERT)"] });
  });

  it("answers unreachable rather than throwing when the connection fails", async () => {
    const probe = await probeDeletionConnection(probeConn({ role: "x", fails: true }).conn);
    expect(probe).toEqual({ kind: "unreachable", detail: "connect ECONNREFUSED" });
  });
});

describe("tenantSchemaDroppable", () => {
  const TENANT = "01234567-89ab-cdef-0123-456789abcdef";
  it("answers per tenant from the schema's owner, and true when there is no schema to drop", async () => {
    const undroppable = probeConn({ role: "crossengin_eraser", schemas: { t_0123456789abcdef0123456789abcdef: false } });
    expect(await tenantSchemaDroppable(undroppable.conn, TENANT)).toBe(false);
    expect(undroppable.calls[0]?.params).toEqual(["t_0123456789abcdef0123456789abcdef"]);
    const owned = probeConn({ role: "crossengin", schemas: { t_0123456789abcdef0123456789abcdef: true } });
    expect(await tenantSchemaDroppable(owned.conn, TENANT)).toBe(true);
    expect(await tenantSchemaDroppable(probeConn({ role: "crossengin_eraser" }).conn, TENANT)).toBe(true);
  });
});

describe("formatDeletionConnectionLine", () => {
  it("is info and names the role when the erasure can complete", () => {
    const out = formatDeletionConnectionLine("configured", {
      kind: "can_complete",
      role: "crossengin_eraser",
      posture: "dedicated",
      superuser: false,
      probed: 97,
      undroppableSchemas: [],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
    });
    expect(out.level).toBe("info");
    expect(out.line).toContain("runs as crossengin_eraser on its own connection (DELETION_PGUSER)");
    expect(out.line).toContain("a dedicated role");
    expect(out.line).toContain("every one of its 97 target tables is present, scoped, granted and unconfined");
    expect(out.line).not.toContain("SUPERUSER");
  });

  it("names a superuser deletion role and what a compromise of this process then yields", () => {
    const out = formatDeletionConnectionLine("configured", {
      kind: "can_complete",
      role: "crossengin",
      posture: "superuser",
      superuser: true,
      probed: 97,
      undroppableSchemas: [],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
    });
    // A warning now (ADR-0458): the documents recommend the dedicated role, so a superuser here is a
    // choice whose cost the operator should read on every boot, not only once in a README.
    expect(out.level).toBe("warn");
    expect(out.line).toContain("runs as crossengin (a SUPERUSER)");
    expect(out.line).toContain("yields the whole database server");
    expect(out.line).toContain("crossengin_eraser");
    const member = formatDeletionConnectionLine("configured", {
      kind: "can_complete",
      role: "crossengin_eraser",
      posture: "superuser_by_membership",
      superuser: true,
      probed: 97,
      undroppableSchemas: [],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
    });
    expect(member.level).toBe("warn");
    expect(member.line).toContain("a member of a SUPERUSER role, which it can SET ROLE to");
    expect(member.line).not.toContain("a dedicated role");
    // Already the shipped role: the remedy is the step that names what to REVOKE, not "use it".
    expect(member.line).toContain("re-run the eraser-role step");
    expect(member.line).not.toContain("the dedicated crossengin_eraser role");
    expect(out.line).toContain("the dedicated crossengin_eraser role");
  });

  it("does not name the superuser cost on the serving connection, where [pg] already says it", () => {
    const out = formatDeletionConnectionLine("absent", {
      kind: "can_complete",
      role: "crossengin",
      posture: "superuser",
      superuser: true,
      probed: 97,
      undroppableSchemas: [],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
    });
    expect(out.level).toBe("info");
    expect(out.line).not.toContain("yields the whole database server");
  });

  it("warns on per-tenant schemas the role cannot drop, without claiming every deletion is refused", () => {
    const out = formatDeletionConnectionLine("configured", {
      kind: "can_complete",
      role: "crossengin_eraser",
      posture: "dedicated",
      superuser: false,
      probed: 97,
      undroppableSchemas: ["t_0123456789abcdef0123456789abcdef"],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
    });
    expect(out.level).toBe("warn");
    expect(out.line).toContain("cannot DROP 1 per-tenant schema(s)");
    expect(out.line).not.toContain("every deletion will be refused");
  });

  it("warns on a missing grant with the re-grant remedy (ADR-0458)", () => {
    const out = formatDeletionConnectionLine("configured", {
      kind: "will_refuse",
      role: "crossengin_eraser",
      posture: "dedicated",
      superuser: false,
      probed: 97,
      undroppableSchemas: [],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
      confined: [],
      missing: [],
      unscoped: [],
      unprivileged: ["meta.new_table (DELETE)"],
    });
    expect(out.level).toBe("warn");
    expect(out.line).toContain("refused table_privilege_missing");
    expect(out.line).toContain("eraser-role step");
    expect(out.line).not.toContain(DELETION_PASSWORD_REMEDY_MARK);
  });

  it("warns on a confined serving role and names both variables as the remedy", () => {
    const out = formatDeletionConnectionLine("absent", {
      kind: "will_refuse",
      role: "crossengin_app",
      posture: "dedicated",
      superuser: false,
      probed: 97,
      undroppableSchemas: [],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
      confined: ["meta.a", "meta.b", "meta.c", "meta.d"],
      missing: [],
      unscoped: [],
      unprivileged: [],
    });
    expect(out.level).toBe("warn");
    expect(out.line).toContain("runs as crossengin_app on the serving connection (DELETION_PGUSER unset)");
    expect(out.line).toContain("confines 4 (meta.a, meta.b, meta.c and 1 more)");
    expect(out.line).toContain("refused rls_would_confine_this_session");
    expect(out.line).toContain(DELETION_PGUSER_VAR);
    expect(out.line).toContain(DELETION_PGPASSWORD_VAR);
    expect(out.line).not.toContain("so a deletion can complete");
  });

  it("warns on a missing table with the schema remedy, not the role remedy", () => {
    const out = formatDeletionConnectionLine("configured", {
      kind: "will_refuse",
      role: "crossengin",
      posture: "superuser",
      superuser: true,
      probed: 97,
      undroppableSchemas: [],
      breadth: [],
      futureSchemas: { kind: "not_applicable" },
      confined: [],
      missing: ["meta.operate_entity_records"],
      unscoped: [],
      unprivileged: [],
    });
    expect(out.level).toBe("warn");
    expect(out.line).toContain("refused table_missing");
    expect(out.line).toContain("crossengin apply");
    expect(out.line).not.toContain("so a deletion can complete");
    expect(out.line).not.toContain(DELETION_PASSWORD_REMEDY_MARK);
  });

  it("warns, rather than claiming either answer, when nothing could be asked", () => {
    const out = formatDeletionConnectionLine("configured", { kind: "unreachable", detail: "timeout" });
    expect(out.level).toBe("warn");
    expect(out.line).toContain("could not be checked at boot (timeout)");
    expect(out.line).not.toContain("unconfined");
    expect(out.line).not.toContain("so a deletion can complete");
  });
});

// The role remedy's own phrase, so the missing-table arm can be shown not to send an operator to it.
const DELETION_PASSWORD_REMEDY_MARK = "which the deletion pipeline alone connects as";

describe("the schema eraser's refusal vocabulary", () => {
  it("mirrors operate-runtime-pg's, which the retry map classifies by name", () => {
    // tenant-lifecycle-pg cannot import operate-runtime-pg, so the mirror is checked here, where both
    // are in reach: a reason added there and not here would classify `final` by default.
    expect([...SCHEMA_ERASER_REFUSAL_REASONS].sort()).toEqual([...ERASURE_REFUSAL_REASONS].sort());
  });
});
