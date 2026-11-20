import type { PgConfig, PgConnection } from "@crossengin/kernel-pg";
import { ERASURE_REFUSAL_REASONS } from "@crossengin/operate-runtime-pg";
import { SCHEMA_ERASER_REFUSAL_REASONS } from "@crossengin/tenant-lifecycle-pg";
import { describe, expect, it } from "vitest";

import {
  DELETION_APPLICATION_NAME,
  DELETION_PGPASSWORD_VAR,
  DELETION_PGUSER_VAR,
  formatDeletionConnectionLine,
  probeDeletionConnection,
  resolveDeletionOwnerConfig,
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
      if (text.includes("current_user")) {
        return { rows: [{ role: opts.role, superuser: opts.superuser === true ? "on" : "off" }], rowCount: 1 };
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

  it("answers unreachable rather than throwing when the connection fails", async () => {
    const probe = await probeDeletionConnection(probeConn({ role: "x", fails: true }).conn);
    expect(probe).toEqual({ kind: "unreachable", detail: "connect ECONNREFUSED" });
  });
});

describe("formatDeletionConnectionLine", () => {
  it("is info and names the role when the erasure can complete", () => {
    const out = formatDeletionConnectionLine("configured", {
      kind: "can_complete",
      role: "crossengin_deletion",
      superuser: false,
      probed: 97,
    });
    expect(out.level).toBe("info");
    expect(out.line).toContain("runs as crossengin_deletion on its own connection (DELETION_PGUSER)");
    expect(out.line).toContain("every one of its 97 target tables is present, scoped and unconfined");
    expect(out.line).not.toContain("SUPERUSER");
  });

  it("names a superuser deletion role and what a compromise of this process then yields", () => {
    const out = formatDeletionConnectionLine("configured", {
      kind: "can_complete",
      role: "crossengin",
      superuser: true,
      probed: 97,
    });
    expect(out.line).toContain("runs as crossengin (a SUPERUSER)");
    expect(out.line).toContain("yields the whole database server");
  });

  it("warns on a confined serving role and names both variables as the remedy", () => {
    const out = formatDeletionConnectionLine("absent", {
      kind: "will_refuse",
      role: "crossengin_app",
      superuser: false,
      probed: 97,
      confined: ["meta.a", "meta.b", "meta.c", "meta.d"],
      missing: [],
      unscoped: [],
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
      superuser: true,
      probed: 97,
      confined: [],
      missing: ["meta.operate_entity_records"],
      unscoped: [],
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
