import { META_OPERATE_ENTITY_RECORDS } from "@crossengin/kernel/bootstrap";
import type { PgConnection } from "@crossengin/kernel-pg";
import { RecordIdConflict, UniqueViolation } from "@crossengin/operate-runtime";
import { assertBindArity } from "@crossengin/testing";
import { describe, expect, it } from "vitest";

import {
  createOp,
  DOCUMENT_RECORD_KEY_CONSTRAINT,
  isDocumentRecordKeyViolation,
} from "./entity-ops.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const TABLE = "meta.operate_entity_records";

function pgError(code: string, constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code,
    constraint,
  });
}

/** A connection whose one INSERT raises `error`; every other statement is a fault in the fake. */
function insertRaising(error: unknown): PgConnection {
  const conn: PgConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      assertBindArity(sql, params ?? []);
      if (/^\s*INSERT INTO meta\.operate_entity_records\b/.test(sql)) throw error;
      throw new Error(`fake: unexpected statement ${sql.slice(0, 60)}`);
    },
    async transaction(fn) {
      return fn(conn);
    },
    async withAdvisoryLock(_key, fn) {
      return fn();
    },
    async close() {},
  };
  return conn;
}

describe("a create of an id the tenant already holds on the document store (ADR-0474)", () => {
  it("names the constraint the catalog declares, so a rename fails here rather than in production", () => {
    const names = (META_OPERATE_ENTITY_RECORDS.uniqueConstraints ?? []).map((u) => u.name);
    expect(names).toContain(DOCUMENT_RECORD_KEY_CONSTRAINT);
    const key = META_OPERATE_ENTITY_RECORDS.uniqueConstraints?.find(
      (u) => u.name === DOCUMENT_RECORD_KEY_CONSTRAINT,
    );
    // The record's own key, not the surrogate primary key: `id` is what no caller names.
    expect(key?.columns).toEqual(["tenant_id", "entity", "record_id"]);
    expect(META_OPERATE_ENTITY_RECORDS.primaryKey).toEqual(["id"]);
  });

  it("turns a 23505 on the record key into RecordIdConflict naming the entity and the id", async () => {
    const conn = insertRaising(pgError("23505", DOCUMENT_RECORD_KEY_CONSTRAINT));
    const err = await createOp(conn, TABLE, TENANT, "Product", { id: "p-1", name: "x" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecordIdConflict);
    expect((err as RecordIdConflict).entity).toBe("Product");
    expect((err as RecordIdConflict).id).toBe("p-1");
  });

  it("leaves a 23505 on any other constraint to the unique-index path", async () => {
    const original = pgError("23505", "operate_entity_records_pkey");
    const err = await createOp(insertRaising(original), TABLE, TENANT, "Product", {
      id: "p-1",
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RecordIdConflict);
    expect(err).not.toBeInstanceOf(UniqueViolation);
    expect(err).toBe(original);
  });

  it("is a key violation only for 23505 on that constraint", () => {
    expect(isDocumentRecordKeyViolation(pgError("23505", DOCUMENT_RECORD_KEY_CONSTRAINT))).toBe(true);
    expect(isDocumentRecordKeyViolation(pgError("23503", DOCUMENT_RECORD_KEY_CONSTRAINT))).toBe(false);
    expect(isDocumentRecordKeyViolation(pgError("23505", "something_else"))).toBe(false);
    expect(isDocumentRecordKeyViolation(new Error("x"))).toBe(false);
    expect(isDocumentRecordKeyViolation(null)).toBe(false);
  });
});
