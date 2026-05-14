import { describe, expect, it } from "vitest";
import {
  CursorPayloadSchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PaginationRequestSchema,
  PaginationResponseMetaSchema,
  SORT_DIRECTIONS,
  buildPageMeta,
  clampLimit,
  decodeCursor,
  encodeCursor,
  type CursorPayload,
} from "./pagination.js";

describe("constants", () => {
  it("declares page limit bounds", () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(MAX_PAGE_LIMIT).toBe(200);
  });

  it("SORT_DIRECTIONS = asc/desc", () => {
    expect(SORT_DIRECTIONS).toEqual(["asc", "desc"]);
  });
});

describe("CursorPayloadSchema", () => {
  it("accepts a valid payload", () => {
    expect(() =>
      CursorPayloadSchema.parse({
        sortField: "createdAt",
        sortDirection: "desc",
        lastId: "id-100",
        lastSortValue: 1_700_000_000,
        issuedAt: 1_700_000_000,
      }),
    ).not.toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      CursorPayloadSchema.parse({
        sortField: "x",
        sortDirection: "asc",
        lastId: "y",
        lastSortValue: 1,
        issuedAt: 1,
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("PaginationRequestSchema", () => {
  it("defaults limit to 50", () => {
    const r = PaginationRequestSchema.parse({});
    expect(r.limit).toBe(50);
  });

  it("rejects limit > 200", () => {
    expect(() => PaginationRequestSchema.parse({ limit: 500 })).toThrow();
  });

  it("rejects cursor combined with sortField", () => {
    expect(() =>
      PaginationRequestSchema.parse({
        cursor: "abc",
        sortField: "createdAt",
      }),
    ).toThrow(/cannot provide both cursor and sortField/);
  });

  it("rejects malformed cursor", () => {
    expect(() =>
      PaginationRequestSchema.parse({ cursor: "not!base64url" }),
    ).toThrow();
  });
});

describe("encodeCursor / decodeCursor", () => {
  const payload: CursorPayload = {
    sortField: "createdAt",
    sortDirection: "desc",
    lastId: "id-100",
    lastSortValue: "2026-05-14T10:00:00Z",
    issuedAt: 1_715_680_800,
  };

  it("roundtrips a payload", () => {
    const encoded = encodeCursor(payload);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(payload);
  });

  it("produces a base64url cursor (no +, /, or =)", () => {
    const encoded = encodeCursor(payload);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("decodes a numeric lastSortValue", () => {
    const numPayload: CursorPayload = { ...payload, lastSortValue: 42 };
    const decoded = decodeCursor(encodeCursor(numPayload));
    expect(decoded.lastSortValue).toBe(42);
  });

  it("throws on malformed cursor", () => {
    expect(() => decodeCursor("not!base64url")).toThrow();
  });
});

describe("PaginationResponseMetaSchema", () => {
  it("rejects hasMore=true with nextCursor=null", () => {
    expect(() =>
      PaginationResponseMetaSchema.parse({
        nextCursor: null,
        hasMore: true,
        limit: 50,
      }),
    ).toThrow(/non-null nextCursor/);
  });

  it("rejects nextCursor non-null with hasMore=false", () => {
    expect(() =>
      PaginationResponseMetaSchema.parse({
        nextCursor: "abc",
        hasMore: false,
        limit: 50,
      }),
    ).toThrow(/only when hasMore=true/);
  });

  it("accepts the terminal page", () => {
    expect(() =>
      PaginationResponseMetaSchema.parse({
        nextCursor: null,
        hasMore: false,
        limit: 50,
      }),
    ).not.toThrow();
  });
});

describe("clampLimit", () => {
  it("returns default for undefined", () => {
    expect(clampLimit(undefined)).toBe(50);
  });

  it("clamps below min", () => {
    expect(clampLimit(0)).toBe(1);
  });

  it("clamps above max", () => {
    expect(clampLimit(500)).toBe(200);
  });

  it("floors fractional", () => {
    expect(clampLimit(50.7)).toBe(50);
  });
});

describe("buildPageMeta", () => {
  it("sets hasMore=true when nextCursor is non-null", () => {
    const meta = buildPageMeta([1, 2, 3], "cursor-abc", 50);
    expect(meta.hasMore).toBe(true);
    expect(meta.data).toEqual([1, 2, 3]);
  });

  it("sets hasMore=false when nextCursor is null", () => {
    const meta = buildPageMeta([1], null, 50);
    expect(meta.hasMore).toBe(false);
  });
});
