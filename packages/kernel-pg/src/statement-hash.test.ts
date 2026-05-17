import { describe, expect, it } from "vitest";

import {
  excerptStatement,
  hashStatement,
  isStatementHash,
  normalizeSql,
} from "./statement-hash.js";

describe("normalizeSql", () => {
  it("collapses runs of whitespace", () => {
    expect(normalizeSql("SELECT   1\n\n FROM\ttab;")).toBe("SELECT 1 FROM tab;");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSql("\n  CREATE TABLE x ();  \n")).toBe("CREATE TABLE x ();");
  });

  it("is idempotent under repeated application", () => {
    const input = "CREATE INDEX foo_idx ON foo (a, b);";
    expect(normalizeSql(normalizeSql(input))).toBe(normalizeSql(input));
  });
});

describe("hashStatement", () => {
  it("produces a 64-character lowercase hex string", () => {
    const h = hashStatement("CREATE TABLE x (id UUID PRIMARY KEY);");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats whitespace-equivalent statements as identical", () => {
    const a = hashStatement("CREATE TABLE x (id UUID);");
    const b = hashStatement("CREATE   TABLE   x   (id UUID);");
    const c = hashStatement("  CREATE TABLE x (id UUID);  ");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("produces different hashes for semantically different statements", () => {
    const a = hashStatement("CREATE TABLE x (id UUID);");
    const b = hashStatement("CREATE TABLE y (id UUID);");
    expect(a).not.toBe(b);
  });

  it("is deterministic across invocations", () => {
    const stmt = "ALTER TABLE meta.foo ENABLE ROW LEVEL SECURITY;";
    const runs = new Set([
      hashStatement(stmt),
      hashStatement(stmt),
      hashStatement(stmt),
    ]);
    expect(runs.size).toBe(1);
  });

  it("matches the known sha256 of a fixture statement", () => {
    expect(hashStatement("SELECT 1;")).toBe(
      "17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a",
    );
  });
});

describe("isStatementHash", () => {
  it("accepts a real hash", () => {
    expect(isStatementHash(hashStatement("anything"))).toBe(true);
  });

  it("rejects uppercase hex", () => {
    expect(isStatementHash("A".repeat(64))).toBe(false);
  });

  it("rejects wrong-length inputs", () => {
    expect(isStatementHash("a".repeat(63))).toBe(false);
    expect(isStatementHash("a".repeat(65))).toBe(false);
    expect(isStatementHash("")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isStatementHash("g".repeat(64))).toBe(false);
  });
});

describe("excerptStatement", () => {
  it("returns the normalized statement when under the limit", () => {
    expect(excerptStatement("SELECT  1;")).toBe("SELECT 1;");
  });

  it("truncates and appends an ellipsis when over the limit", () => {
    const long = "a".repeat(300);
    const result = excerptStatement(long, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith("…")).toBe(true);
  });

  it("uses a default cap of 200 characters", () => {
    const long = "x".repeat(500);
    const result = excerptStatement(long);
    expect(result.length).toBe(200);
  });
});
