import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from "@crossengin/workflow-engine";
import { describe, expect, it, vi } from "vitest";

import { definitionContentSha256 } from "./definition-authoring.js";
import {
  DEFAULT_DEFINITION_LOAD_LIMIT,
  PostgresWorkflowDefinitionStore,
  WORKFLOW_DEFINITION_COLUMN_NAMES,
  WORKFLOW_DEFINITION_JSONB_COLUMNS,
  WORKFLOW_DEFINITION_PARAM_COUNT,
  SET_PLATFORM_CONFIG_WRITE_SQL,
  WorkflowDefinitionConflictError,
  assertTenantId,
  definitionPlaceholders,
  definitionRowValues,
  definitionUpdateAssignments,
  rowToWorkflowDefinition,
  summarizeDefinition,
} from "./definition-store.js";
import { WorkflowDefinitionIdResolver } from "./id-mapping.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const AUTHOR = "00000000-0000-4000-8000-0000000000aa";
const APPROVER = "00000000-0000-4000-8000-0000000000bb";
const ROW_UUID = "00000000-0000-4000-8000-000000000900";

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    id: "wfd_abcdef01",
    tenantId: TENANT,
    definitionKey: "purchase.approval",
    version: "1.0.0",
    label: "Purchase approval",
    description: "Routes a purchase order for approval.",
    status: "published",
    states: [
      {
        name: "submitted",
        kind: "initial",
        label: "Submitted",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
      {
        name: "approved",
        kind: "terminal_success",
        label: "Approved",
        onEntryActions: [],
        onExitActions: [],
        slaSeconds: null,
      },
    ],
    transitions: [
      {
        name: "approve",
        fromState: "submitted",
        toState: "approved",
        trigger: { kind: "automatic" },
        guards: [],
        preTransitionActions: [],
        postTransitionActions: [],
      },
    ],
    variables: [],
    timers: [],
    signals: [],
    initialState: "submitted",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 86_400,
    createdAt: "2026-10-01T09:00:00.000Z",
    createdBy: AUTHOR,
    publishedAt: "2026-10-01T10:00:00.000Z",
    publishedBy: APPROVER,
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
    ...overrides,
  });
}

/** A row as Postgres would hand it back: JSONB already parsed, TIMESTAMPTZ as a `Date`. */
function row(
  d: WorkflowDefinition = definition(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ROW_UUID,
    definition_id: d.id,
    tenant_id: d.tenantId,
    definition_key: d.definitionKey,
    version: d.version,
    label: d.label,
    description: d.description,
    status: d.status,
    states: d.states,
    transitions: d.transitions,
    variables: d.variables,
    timers: d.timers,
    signals: d.signals,
    initial_state: d.initialState,
    compensation_strategy: d.compensationStrategy,
    timeout_seconds: d.timeoutSeconds,
    created_at: new Date(d.createdAt),
    created_by: d.createdBy,
    published_at: d.publishedAt === null ? null : new Date(d.publishedAt),
    published_by: d.publishedBy,
    deprecated_at: d.deprecatedAt === null ? null : new Date(d.deprecatedAt),
    superseded_by_definition_id: d.supersededByDefinitionId,
    source_manifest_sha256: d.sourceManifestSha256,
    ...overrides,
  };
}

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult<Record<string, unknown>>,
  capture?: Recorded[],
): PgConnection {
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    if (capture !== undefined) capture.push({ sql, params });
    return handler(sql, params);
  }) as PgConnection["query"];
  const conn: PgConnection = {
    query,
    transaction: vi.fn(async <T,>(fn: (tx: PgConnection) => Promise<T>) =>
      fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

const EMPTY: PgQueryResult<Record<string, unknown>> = { rows: [], rowCount: 0 };

describe("column plan", () => {
  it("names 22 columns, one per contract field, with no duplicates", () => {
    expect(WORKFLOW_DEFINITION_COLUMN_NAMES).toHaveLength(22);
    expect(new Set(WORKFLOW_DEFINITION_COLUMN_NAMES).size).toBe(22);
    expect(WORKFLOW_DEFINITION_PARAM_COUNT).toBe(22);
  });

  it("omits the surrogate id and leads with definition_id, the key an UPDATE matches on", () => {
    expect(WORKFLOW_DEFINITION_COLUMN_NAMES).not.toContain("id");
    expect(WORKFLOW_DEFINITION_COLUMN_NAMES[0]).toBe("definition_id");
  });

  it("casts exactly the five JSONB columns", () => {
    expect([...WORKFLOW_DEFINITION_JSONB_COLUMNS].sort()).toEqual([
      "signals",
      "states",
      "timers",
      "transitions",
      "variables",
    ]);
    const placeholders = definitionPlaceholders().split(", ");
    for (const [i, col] of WORKFLOW_DEFINITION_COLUMN_NAMES.entries()) {
      expect(placeholders[i]).toBe(
        `$${i + 1}${WORKFLOW_DEFINITION_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
      );
    }
  });

  it("assigns every column but the first, offset by one placeholder", () => {
    const assignments = definitionUpdateAssignments().split(", ");
    expect(assignments).toHaveLength(21);
    expect(assignments[0]).toBe("tenant_id = $2");
    expect(assignments.at(-1)).toBe("source_manifest_sha256 = $22");
  });

  it("supplies one value per column, in order", () => {
    const values = definitionRowValues(definition());
    expect(values).toHaveLength(WORKFLOW_DEFINITION_COLUMN_NAMES.length);
    expect(values[0]).toBe("wfd_abcdef01");
    expect(values[1]).toBe(TENANT);
    expect(values[14]).toBe(86_400);
  });

  it("serializes the JSONB columns as text", () => {
    const values = definitionRowValues(definition());
    expect(typeof values[7]).toBe("string");
    expect(JSON.parse(values[7] as string)).toHaveLength(2);
    expect(values[9]).toBe("[]");
  });

  it("refuses to build row values for a record the contract rejects", () => {
    const broken = { ...definition(), initialState: "nowhere" } as WorkflowDefinition;
    expect(() => definitionRowValues(broken)).toThrow();
  });
});

describe("rowToWorkflowDefinition", () => {
  it("round-trips a healthy row", () => {
    expect(rowToWorkflowDefinition(row())).toEqual(definition());
  });

  it("normalizes a Date-typed TIMESTAMPTZ to ISO text", () => {
    expect(rowToWorkflowDefinition(row()).createdAt).toBe("2026-10-01T09:00:00.000Z");
  });

  it("accepts JSONB handed back as text", () => {
    const d = definition();
    const parsed = rowToWorkflowDefinition(
      row(d, { states: JSON.stringify(d.states), transitions: JSON.stringify(d.transitions) }),
    );
    expect(parsed.states).toHaveLength(2);
  });

  it("coerces timeout_seconds from a numeric string", () => {
    expect(rowToWorkflowDefinition(row(definition(), { timeout_seconds: "86400" })).timeoutSeconds).toBe(
      86_400,
    );
  });

  it("re-parses, so a row edited into a state the contract forbids raises", () => {
    // Two `initial` states: a CHECK constraint cannot see inside a JSONB array, so only the
    // re-parse stands between this row and an engine driving it.
    const d = definition();
    const twoInitial = [
      d.states[0]!,
      { ...d.states[1]!, kind: "initial" as const },
    ];
    expect(() => rowToWorkflowDefinition(row(d, { states: twoInitial }))).toThrow();
  });

  it("raises on a row whose initialState names no declared state", () => {
    expect(() => rowToWorkflowDefinition(row(definition(), { initial_state: "ghost" }))).toThrow();
  });

  it("raises on a published row whose author approved their own definition", () => {
    expect(() => rowToWorkflowDefinition(row(definition(), { published_by: AUTHOR }))).toThrow(
      /four-eyes/,
    );
  });

  it("raises on a published row with no publishedAt", () => {
    expect(() => rowToWorkflowDefinition(row(definition(), { published_at: null }))).toThrow();
  });
});

describe("summarizeDefinition", () => {
  it("carries the identity, scope, status and a recomputed digest", () => {
    const d = definition();
    expect(summarizeDefinition(d)).toEqual({
      id: d.id,
      tenantId: d.tenantId,
      definitionKey: d.definitionKey,
      version: d.version,
      status: d.status,
      contentSha256: definitionContentSha256(d),
    });
  });
});

describe("PostgresWorkflowDefinitionStore.publish", () => {
  it("INSERTs a definition nothing holds, and reports the row uuid", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("INSERT INTO meta.workflow_definitions")) {
        return { rows: [{ id: ROW_UUID }], rowCount: 1 };
      }
      return EMPTY;
    }, capture);
    const store = new PostgresWorkflowDefinitionStore(conn);
    const result = await store.publish(definition());
    expect(result.decision).toBe("insert");
    expect(result.refusal).toBeNull();
    expect(result.rowId).toBe(ROW_UUID);
    const insert = capture.find((c) => c.sql.includes("INSERT"));
    expect(insert?.params).toHaveLength(WORKFLOW_DEFINITION_PARAM_COUNT);
    expect(insert?.params?.[0]).toBe("wfd_abcdef01");
  });

  it("sets the tenant RLS context for a tenant-scoped write", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection(
      (sql) => (sql.includes("INSERT") ? { rows: [{ id: ROW_UUID }], rowCount: 1 } : EMPTY),
      capture,
    );
    await new PostgresWorkflowDefinitionStore(conn).publish(definition());
    expect(capture[0]?.sql).toContain("set_config('app.current_tenant_id'");
    expect(capture[0]?.params).toEqual([TENANT]);
  });

  it("claims the platform config-write elevation, and no tenant context, for a platform-wide write", async () => {
    // It used to set nothing at all, on the reasoning that tenant isolation would hide the very row
    // being written. That is still true — and the `tenant_id IS NULL` arm of the one `ALL`-scope
    // policy also satisfied its `WITH CHECK`, so any tenant session could publish a platform-wide
    // definition every tenant without its own would then run. The write arm is its own policy on
    // this setting now; the read arm still needs no grant.
    const capture: Recorded[] = [];
    const conn = mockConnection(
      (sql) => (sql.includes("INSERT") ? { rows: [{ id: ROW_UUID }], rowCount: 1 } : EMPTY),
      capture,
    );
    await new PostgresWorkflowDefinitionStore(conn).publish(definition({ tenantId: null }));
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_PLATFORM_CONFIG_WRITE_SQL);
    expect(settings[0]?.sql).toContain("app.platform_config_write");
    expect(capture.some((c) => c.sql.includes("app.current_tenant_id"))).toBe(false);
  });

  it("claims nothing at all on a platform-wide read", async () => {
    // The platform read policy is `SELECT`-scoped on `tenant_id IS NULL` and needs no grant, so a
    // read claims no elevation — the behaviour it had before the split.
    const capture: Recorded[] = [];
    const conn = mockConnection(() => EMPTY, capture);
    await new PostgresWorkflowDefinitionStore(conn).loadById("wfd_missing00000001");
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("reports unchanged and writes nothing when the stored row is identical", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("SELECT id FROM")) return { rows: [{ id: ROW_UUID }], rowCount: 1 };
      if (sql.includes("WHERE definition_key = $1")) return { rows: [row()], rowCount: 1 };
      return EMPTY;
    }, capture);
    const store = new PostgresWorkflowDefinitionStore(conn);
    const result = await store.publish(definition());
    expect(result.decision).toBe("unchanged");
    expect(result.rowId).toBe(ROW_UUID);
    expect(capture.some((c) => /INSERT|UPDATE/.test(c.sql))).toBe(false);
  });

  it("is idempotent: two publications of one definition write once", async () => {
    let inserted = false;
    const conn = mockConnection((sql) => {
      if (sql.includes("INSERT")) {
        inserted = true;
        return { rows: [{ id: ROW_UUID }], rowCount: 1 };
      }
      if (sql.includes("WHERE definition_key = $1")) {
        return inserted ? { rows: [row()], rowCount: 1 } : EMPTY;
      }
      if (sql.includes("SELECT id FROM")) {
        return inserted ? { rows: [{ id: ROW_UUID }], rowCount: 1 } : EMPTY;
      }
      return EMPTY;
    });
    const store = new PostgresWorkflowDefinitionStore(conn);
    expect((await store.publish(definition())).decision).toBe("insert");
    expect((await store.publish(definition())).decision).toBe("unchanged");
  });

  it("reports a refusal rather than throwing, with the reason named", async () => {
    const conn = mockConnection((sql) =>
      sql.includes("WHERE definition_key = $1")
        ? { rows: [row(definition({ label: "Older wording" }))], rowCount: 1 }
        : EMPTY,
    );
    const result = await new PostgresWorkflowDefinitionStore(conn).publish(definition());
    expect(result.decision).toBe("refused");
    expect(result.refusal).toBe("version_content_differs");
    expect(result.rowId).toBeNull();
  });

  it("guards a draft rewrite on the editable status set", async () => {
    const capture: Recorded[] = [];
    const draft = definition({ status: "draft", publishedAt: null, publishedBy: null });
    const conn = mockConnection((sql) => {
      if (sql.includes("WHERE definition_key = $1")) return { rows: [row(draft)], rowCount: 1 };
      if (sql.includes("UPDATE")) return { rows: [{ id: ROW_UUID }], rowCount: 1 };
      return EMPTY;
    }, capture);
    const result = await new PostgresWorkflowDefinitionStore(conn).publish(
      definition({ ...draft, label: "Reworded" }),
    );
    expect(result.decision).toBe("replace_draft");
    const update = capture.find((c) => c.sql.includes("UPDATE"));
    expect(update?.sql).toContain("status IN ('draft', 'in_review')");
  });

  it("guards a publication on the statuses it may be reached from, and on four eyes", async () => {
    const capture: Recorded[] = [];
    const inReview = definition({ status: "in_review", publishedAt: null, publishedBy: null });
    const conn = mockConnection((sql) => {
      if (sql.includes("WHERE definition_key = $1")) return { rows: [row(inReview)], rowCount: 1 };
      if (sql.includes("UPDATE")) return { rows: [{ id: ROW_UUID }], rowCount: 1 };
      return EMPTY;
    }, capture);
    await new PostgresWorkflowDefinitionStore(conn).publish(definition());
    const update = capture.find((c) => c.sql.includes("UPDATE"));
    expect(update?.sql).toContain("created_by <> $23");
    expect(update?.params?.[22]).toBe(APPROVER);
  });

  it("guards a deprecation on 'published' only", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("WHERE definition_key = $1")) return { rows: [row()], rowCount: 1 };
      if (sql.includes("UPDATE")) return { rows: [{ id: ROW_UUID }], rowCount: 1 };
      return EMPTY;
    }, capture);
    const result = await new PostgresWorkflowDefinitionStore(conn).publish(
      definition({ status: "deprecated", deprecatedAt: "2026-11-01T00:00:00.000Z" }),
    );
    expect(result.decision).toBe("transition_status");
    const update = capture.find((c) => c.sql.includes("UPDATE"));
    expect(update?.sql).toContain("status IN ('published')");
    expect(update?.sql).not.toContain("created_by <>");
  });

  it("raises a conflict when a guarded UPDATE matches no row", async () => {
    const inReview = definition({ status: "in_review", publishedAt: null, publishedBy: null });
    const conn = mockConnection((sql) => {
      if (sql.includes("WHERE definition_key = $1")) return { rows: [row(inReview)], rowCount: 1 };
      return EMPTY;
    });
    await expect(new PostgresWorkflowDefinitionStore(conn).publish(definition())).rejects.toThrow(
      WorkflowDefinitionConflictError,
    );
  });

  it("raises a conflict when an INSERT returns no row", async () => {
    const conn = mockConnection(() => EMPTY);
    await expect(new PostgresWorkflowDefinitionStore(conn).publish(definition())).rejects.toThrow(
      /concurrent publication/,
    );
  });

  it("refuses a definition the contract rejects before touching the database", async () => {
    const conn = mockConnection(() => EMPTY);
    const broken = { ...definition(), publishedBy: AUTHOR } as WorkflowDefinition;
    await expect(new PostgresWorkflowDefinitionStore(conn).publish(broken)).rejects.toThrow();
    expect(conn.query).not.toHaveBeenCalled();
  });

  it("registers the row uuid with an injected resolver, so the first instance needs no lookup", async () => {
    const conn = mockConnection((sql) =>
      sql.includes("INSERT") ? { rows: [{ id: ROW_UUID }], rowCount: 1 } : EMPTY,
    );
    const resolver = new WorkflowDefinitionIdResolver(conn);
    const store = new PostgresWorkflowDefinitionStore(conn, { definitionResolver: resolver });
    await store.publish(definition());
    expect(await resolver.resolve("wfd_abcdef01")).toBe(ROW_UUID);
  });

  it("looks the id up table-wide only when the key list does not already hold it", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection((sql) => {
      if (sql.includes("WHERE definition_key = $1")) return { rows: [row()], rowCount: 1 };
      if (sql.includes("SELECT id FROM")) return { rows: [{ id: ROW_UUID }], rowCount: 1 };
      return EMPTY;
    }, capture);
    await new PostgresWorkflowDefinitionStore(conn).publish(definition());
    // The `rowIdOf` lookup for `unchanged` also names `definition_id = $1`; the gather's query is
    // the one that selects the full column list alongside it.
    expect(
      capture.filter(
        (c) => c.sql.includes("WHERE definition_id = $1") && c.sql.includes("definition_key"),
      ),
    ).toHaveLength(0);
  });

});

describe("assertTenantId", () => {
  it("accepts a uuid", () => {
    expect(() => assertTenantId(TENANT)).not.toThrow();
  });

  it("refuses anything that could not be a uuid for the RLS context", () => {
    for (const bad of ["", "'; SET ROLE postgres; --", "tenant one", "x".repeat(65)]) {
      expect(() => assertTenantId(bad)).toThrow(/invalid tenantId/);
    }
  });
});

describe("PostgresWorkflowDefinitionStore reads", () => {
  it("loads by definition id", async () => {
    const conn = mockConnection((sql) =>
      sql.includes("WHERE definition_id = $1") ? { rows: [row()], rowCount: 1 } : EMPTY,
    );
    const loaded = await new PostgresWorkflowDefinitionStore(conn).loadById(
      "wfd_abcdef01",
      TENANT,
    );
    expect(loaded?.definitionKey).toBe("purchase.approval");
  });

  it("answers null for an id nothing holds", async () => {
    const conn = mockConnection(() => EMPTY);
    expect(await new PostgresWorkflowDefinitionStore(conn).loadById("wfd_missing1")).toBeNull();
  });

  it("prefers the tenant's own row over a platform-wide one on the same key", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection(
      (sql) => (sql.includes("WHERE definition_key = $1 AND version = $2")
        ? { rows: [row()], rowCount: 1 }
        : EMPTY),
      capture,
    );
    await new PostgresWorkflowDefinitionStore(conn).loadByKeyVersion(
      "purchase.approval",
      "1.0.0",
      TENANT,
    );
    const select = capture.find((c) => c.sql.includes("AND version = $2"));
    expect(select?.sql).toContain("ORDER BY tenant_id NULLS LAST");
  });

  it("summarizes every stored version of a key", async () => {
    const conn = mockConnection((sql) =>
      sql.includes("WHERE definition_key = $1")
        ? {
            rows: [row(), row(definition({ id: "wfd_abcdef02", version: "1.1.0" }))],
            rowCount: 2,
          }
        : EMPTY,
    );
    const summaries = await new PostgresWorkflowDefinitionStore(conn).listByKey(
      "purchase.approval",
      TENANT,
    );
    expect(summaries.map((s) => s.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(summaries[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("PostgresWorkflowDefinitionStore.loadEngineDefinitions", () => {
  it("keys the map by definition.id, which is what the instance_started payload records", async () => {
    const conn = mockConnection(() => ({ rows: [row()], rowCount: 1 }));
    const map = await new PostgresWorkflowDefinitionStore(conn).loadEngineDefinitions();
    expect([...map.keys()]).toEqual(["wfd_abcdef01"]);
    expect(map.get("wfd_abcdef01")?.definitionKey).toBe("purchase.approval");
    expect(map.has("purchase.approval")).toBe(false);
  });

  it("loads every status, so an in-flight instance of a deprecated definition still projects", async () => {
    const deprecated = definition({
      id: "wfd_abcdef02",
      version: "0.9.0",
      status: "deprecated",
      deprecatedAt: "2026-09-01T00:00:00.000Z",
    });
    const conn = mockConnection(() => ({
      rows: [row(), row(deprecated, { definition_id: deprecated.id })],
      rowCount: 2,
    }));
    const map = await new PostgresWorkflowDefinitionStore(conn).loadEngineDefinitions();
    expect(map.size).toBe(2);
    expect(map.get("wfd_abcdef02")?.status).toBe("deprecated");
  });

  it("asks for one row past the limit and raises rather than truncating", async () => {
    const capture: Recorded[] = [];
    const rows = [row(), row(definition({ id: "wfd_abcdef02", version: "1.1.0" }))];
    const conn = mockConnection(() => ({ rows, rowCount: rows.length }), capture);
    await expect(
      new PostgresWorkflowDefinitionStore(conn).loadEngineDefinitions({ limit: 1 }),
    ).rejects.toThrow(/truncated map/);
    expect(capture.at(-1)?.params).toEqual([2]);
  });

  it("defaults the limit to DEFAULT_DEFINITION_LOAD_LIMIT", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection(() => EMPTY, capture);
    await new PostgresWorkflowDefinitionStore(conn).loadEngineDefinitions();
    expect(capture.at(-1)?.params).toEqual([DEFAULT_DEFINITION_LOAD_LIMIT + 1]);
  });

  it("refuses a non-positive limit", async () => {
    const conn = mockConnection(() => EMPTY);
    await expect(
      new PostgresWorkflowDefinitionStore(conn).loadEngineDefinitions({ limit: 0 }),
    ).rejects.toThrow(/limit must be positive/);
  });

  it("raises when two rows claim one definition id", async () => {
    const conn = mockConnection(() => ({ rows: [row(), row()], rowCount: 2 }));
    await expect(
      new PostgresWorkflowDefinitionStore(conn).loadEngineDefinitions(),
    ).rejects.toThrow(/two rows claim/);
  });

  it("registers every loaded definition with the resolver", async () => {
    const conn = mockConnection(() => ({ rows: [row()], rowCount: 1 }));
    const resolver = new WorkflowDefinitionIdResolver(conn);
    await new PostgresWorkflowDefinitionStore(conn, {
      definitionResolver: resolver,
    }).loadEngineDefinitions();
    expect(resolver.size()).toBe(1);
  });

  it("raises on an unreadable row rather than serving a shorter map", async () => {
    const conn = mockConnection(() => ({
      rows: [row(definition(), { initial_state: "ghost" })],
      rowCount: 1,
    }));
    await expect(
      new PostgresWorkflowDefinitionStore(conn).loadEngineDefinitions(),
    ).rejects.toThrow();
  });
});

describe("schema option", () => {
  it("refuses an identifier that is not a bare schema name", () => {
    const conn = mockConnection(() => EMPTY);
    expect(
      () => new PostgresWorkflowDefinitionStore(conn, { schema: 'meta"; DROP TABLE x; --' }),
    ).toThrow(/invalid schema identifier/);
  });

  it("uses the supplied schema in its statements", async () => {
    const capture: Recorded[] = [];
    const conn = mockConnection(() => EMPTY, capture);
    await new PostgresWorkflowDefinitionStore(conn, { schema: "other" }).loadById("wfd_abcdef01");
    expect(capture.at(-1)?.sql).toContain("FROM other.workflow_definitions");
  });
});
