import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  buildDrReadinessLifecycle,
  loadDrReadinessConfig,
  parseDrReadinessConfig,
} from "./dr-readiness.js";

function fakeConn(captured: string[]): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string) => {
      captured.push(sql);
      return { rows: [], rowCount: 0 } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => {}) as PgConnection["close"],
  };
  return conn;
}

describe("parseDrReadinessConfig", () => {
  it("applies defaults for an empty input", () => {
    const config = parseDrReadinessConfig({ input: {} });
    expect(config.tenantId).toBeNull();
    expect(config.intervalMs).toBe(3_600_000);
    expect(config.input.runbooks).toEqual([]);
    expect(config.input.backups).toEqual([]);
    expect(config.input.replication).toEqual([]);
  });

  it("accepts a tenant id + interval", () => {
    const config = parseDrReadinessConfig({
      tenantId: "11111111-1111-1111-1111-111111111111",
      intervalMs: 60_000,
      input: {},
    });
    expect(config.tenantId).toBe("11111111-1111-1111-1111-111111111111");
    expect(config.intervalMs).toBe(60_000);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseDrReadinessConfig({ input: {}, bogus: 1 })).toThrow();
  });

  it("rejects a non-uuid tenant id", () => {
    expect(() => parseDrReadinessConfig({ tenantId: "not-a-uuid", input: {} })).toThrow();
  });
});

describe("loadDrReadinessConfig", () => {
  it("reads + validates a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-cfg-"));
    const path = join(dir, "dr.json");
    await writeFile(path, JSON.stringify({ input: {} }), "utf8");
    const config = await loadDrReadinessConfig(path);
    expect(config.intervalMs).toBe(3_600_000);
  });

  it("throws a clear error for a missing file", async () => {
    await expect(loadDrReadinessConfig("/no/such/dr-config.json")).rejects.toThrow(
      /--dr-readiness-config/,
    );
  });
});

describe("buildDrReadinessLifecycle", () => {
  it("assessOnce reads recent executions, assesses, and persists a snapshot", async () => {
    const captured: string[] = [];
    const lifecycle = buildDrReadinessLifecycle(fakeConn(captured), parseDrReadinessConfig({ input: {} }));
    const report = await lifecycle.assessOnce();
    // No executions + no declared infra ⇒ ready, zero issues.
    expect(report.ready).toBe(true);
    expect(report.counts.totalIssues).toBe(0);
    // It read the two execution streams and wrote a readiness snapshot row.
    expect(captured.some((s) => s.includes("dr_failover_executions"))).toBe(true);
    expect(captured.some((s) => s.includes("dr_drill_executions"))).toBe(true);
    expect(captured.some((s) => s.includes("INSERT INTO") && s.includes("dr_readiness_snapshots"))).toBe(true);
  });

  it("exposes a scheduler that starts + stops over an injected timer", () => {
    let started = false;
    const lifecycle = buildDrReadinessLifecycle(fakeConn([]), parseDrReadinessConfig({ input: {} }), {
      scheduler: {
        setInterval: () => {
          started = true;
          return 1;
        },
        clearInterval: () => {
          started = false;
        },
      },
    });
    lifecycle.scheduler.start();
    expect(started).toBe(true);
    lifecycle.scheduler.stop();
    expect(started).toBe(false);
  });
});
