import { describe, expect, it } from "vitest";

import {
  EntityRecordRowSchema,
  generateRecordId,
  mergeRecord,
  resolveRecordId,
  rowToRecord,
} from "./records.js";

describe("records — id generation", () => {
  it("mints rec_ prefixed ids that are unique and monotone-ish", () => {
    const a = generateRecordId();
    const b = generateRecordId();
    expect(a).toMatch(/^rec_[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });

  it("resolveRecordId keeps a usable own id", () => {
    expect(resolveRecordId({ id: "prod-1" })).toBe("prod-1");
    expect(resolveRecordId({ id: "ABC_123-x" })).toBe("ABC_123-x");
  });

  it("resolveRecordId mints a fresh id when own id is missing or unusable", () => {
    expect(resolveRecordId({})).toMatch(/^rec_/);
    expect(resolveRecordId({ id: 42 })).toMatch(/^rec_/);
    expect(resolveRecordId({ id: "has space" })).toMatch(/^rec_/);
    expect(resolveRecordId({ id: "x".repeat(201) })).toMatch(/^rec_/);
  });
});

describe("records — merge", () => {
  it("merges patch over existing and pins the id", () => {
    const merged = mergeRecord({ id: "p1", name: "A", n: 1 }, { name: "B", id: "evil" }, "p1");
    expect(merged).toEqual({ id: "p1", name: "B", n: 1 });
  });
});

describe("records — row schema + mapping", () => {
  it("accepts a well-formed row and returns its document", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      tenant_id: "00000000-0000-4000-8000-0000000000aa",
      entity: "Product",
      record_id: "prod-1",
      document: { id: "prod-1", sku: "S1" },
      created_at: "2026-06-03T12:00:00.000Z",
      updated_at: "2026-06-03T12:00:00.000Z",
    };
    const parsed = EntityRecordRowSchema.parse(row);
    expect(rowToRecord(parsed)).toEqual({ id: "prod-1", sku: "S1" });
  });

  it("accepts Date-typed timestamps (node-postgres returns Date)", () => {
    expect(() =>
      EntityRecordRowSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        tenant_id: "00000000-0000-4000-8000-0000000000aa",
        entity: "Product",
        record_id: "prod-1",
        document: {},
        created_at: new Date(),
        updated_at: new Date(),
      }),
    ).not.toThrow();
  });

  it("rejects a row whose document is not an object", () => {
    expect(() =>
      EntityRecordRowSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        tenant_id: "00000000-0000-4000-8000-0000000000aa",
        entity: "Product",
        record_id: "prod-1",
        document: "nope",
        created_at: "2026-06-03T12:00:00.000Z",
        updated_at: "2026-06-03T12:00:00.000Z",
      }),
    ).toThrow();
  });
});
