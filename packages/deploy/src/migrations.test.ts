import { describe, expect, it } from "vitest";
import {
  MIGRATION_KINDS,
  MIGRATION_STATUSES,
  MigrationApplicationRecordSchema,
  MigrationDeclarationSchema,
  MigrationSequenceSchema,
  isDestructive,
  nextSequenceNumber,
  pendingMigrations,
  type MigrationDeclaration,
} from "./migrations.js";

const SHA256_64 = "a".repeat(64);

describe("constants", () => {
  it("MIGRATION_STATUSES has 4 entries", () => {
    expect(MIGRATION_STATUSES).toEqual(["pending", "applied", "failed", "rolled_forward"]);
  });

  it("MIGRATION_KINDS has 11 entries", () => {
    expect(MIGRATION_KINDS).toHaveLength(11);
    expect(MIGRATION_KINDS).toContain("schema_rename");
    expect(MIGRATION_KINDS).toContain("compensating");
  });
});

describe("MigrationDeclarationSchema", () => {
  const base: MigrationDeclaration = {
    id: "0042_add_column",
    kind: "schema_add_column",
    description: "add residency column",
    sqlPath: "migrations/0042_add_column.sql",
    sqlSha256: SHA256_64,
    forwardCompatibleWith: ["1.0.0"],
    forwardOnly: true,
    isDestructive: false,
    requiresMaintenanceWindow: false,
    locksTables: [],
  };

  it("accepts a non-destructive add_column migration", () => {
    expect(() => MigrationDeclarationSchema.parse(base)).not.toThrow();
  });

  it("rejects a malformed migration id", () => {
    expect(() => MigrationDeclarationSchema.parse({ ...base, id: "add_column" })).toThrow(
      /NNNN_snake_case/,
    );
  });

  it("rejects schema_rename without isDestructive=true", () => {
    expect(() =>
      MigrationDeclarationSchema.parse({
        ...base,
        id: "0043_rename_col",
        kind: "schema_rename",
        isDestructive: false,
      }),
    ).toThrow(/destructive/);
  });

  it("rejects destructive migration with fewer than 2 forwardCompatibleWith", () => {
    expect(() =>
      MigrationDeclarationSchema.parse({
        ...base,
        id: "0043_rename_col",
        kind: "schema_rename",
        isDestructive: true,
        forwardCompatibleWith: ["1.0.0"],
      }),
    ).toThrow(/forwardCompatibleWith/);
  });

  it("accepts a destructive migration with ≥ 2 forwardCompatibleWith", () => {
    expect(() =>
      MigrationDeclarationSchema.parse({
        ...base,
        id: "0043_rename_col",
        kind: "schema_rename",
        isDestructive: true,
        forwardCompatibleWith: ["1.0.0", "2.0.0"],
      }),
    ).not.toThrow();
  });

  it("rejects long-running table-lock without maintenance window", () => {
    expect(() =>
      MigrationDeclarationSchema.parse({
        ...base,
        locksTables: ["large_table"],
        estimatedDurationSeconds: 60,
        requiresMaintenanceWindow: false,
      }),
    ).toThrow(/maintenance/i);
  });

  it("accepts table-lock < 5s without maintenance window", () => {
    expect(() =>
      MigrationDeclarationSchema.parse({
        ...base,
        locksTables: ["small_table"],
        estimatedDurationSeconds: 3,
      }),
    ).not.toThrow();
  });

  it("rejects bad SHA-256 length", () => {
    expect(() => MigrationDeclarationSchema.parse({ ...base, sqlSha256: "deadbeef" })).toThrow();
  });
});

describe("MigrationSequenceSchema", () => {
  const m = (id: string): MigrationDeclaration => ({
    id,
    kind: "schema_add_column",
    description: "x",
    sqlPath: `migrations/${id}.sql`,
    sqlSha256: SHA256_64,
    forwardCompatibleWith: ["1.0.0"],
    forwardOnly: true,
    isDestructive: false,
    requiresMaintenanceWindow: false,
    locksTables: [],
  });

  it("accepts strictly increasing sequence numbers", () => {
    expect(() =>
      MigrationSequenceSchema.parse([m("0001_a"), m("0002_b"), m("0003_c")]),
    ).not.toThrow();
  });

  it("rejects non-strictly-increasing sequence", () => {
    expect(() => MigrationSequenceSchema.parse([m("0002_a"), m("0001_b")])).toThrow(
      /strictly greater/,
    );
  });

  it("rejects duplicate ids", () => {
    expect(() => MigrationSequenceSchema.parse([m("0001_a"), m("0001_a")])).toThrow(
      /duplicate migration id/,
    );
  });
});

describe("MigrationApplicationRecordSchema", () => {
  const base = {
    migrationId: "0042_add_column",
    appliedAt: "2026-05-14T10:00:00Z",
    appliedBy: "ci",
    durationMs: 1234,
    status: "applied" as const,
    appVersionAtApply: "1.0.0",
    environment: "production",
    sqlSha256: SHA256_64,
  };

  it("accepts an applied record", () => {
    expect(() => MigrationApplicationRecordSchema.parse(base)).not.toThrow();
  });

  it("requires errorMessage on failed", () => {
    expect(() => MigrationApplicationRecordSchema.parse({ ...base, status: "failed" })).toThrow(
      /errorMessage/,
    );
  });

  it("requires compensatingMigrationId on rolled_forward", () => {
    expect(() =>
      MigrationApplicationRecordSchema.parse({ ...base, status: "rolled_forward" }),
    ).toThrow(/compensatingMigrationId/);
  });
});

describe("helpers", () => {
  const base = (
    id: string,
    kind: MigrationDeclaration["kind"] = "schema_add_column",
  ): MigrationDeclaration => ({
    id,
    kind,
    description: "x",
    sqlPath: `migrations/${id}.sql`,
    sqlSha256: SHA256_64,
    forwardCompatibleWith: ["1.0.0"],
    forwardOnly: true,
    isDestructive: false,
    requiresMaintenanceWindow: false,
    locksTables: [],
  });

  it("nextSequenceNumber returns 1 for empty sequence", () => {
    expect(nextSequenceNumber([])).toBe(1);
  });

  it("nextSequenceNumber returns max + 1", () => {
    expect(nextSequenceNumber([base("0001_a"), base("0042_b")])).toBe(43);
  });

  it("isDestructive returns true for schema_rename kind", () => {
    expect(isDestructive(base("0001_a", "schema_rename"))).toBe(true);
  });

  it("isDestructive returns true if isDestructive flag is set", () => {
    expect(isDestructive({ ...base("0001_a"), isDestructive: true })).toBe(true);
  });

  it("pendingMigrations excludes applied ids", () => {
    const seq = [base("0001_a"), base("0002_b"), base("0003_c")];
    expect(pendingMigrations(seq, ["0001_a"]).map((m) => m.id)).toEqual(["0002_b", "0003_c"]);
  });
});
