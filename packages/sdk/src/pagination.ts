import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const MIN_PAGE_LIMIT = 1;

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];
export const SortDirectionSchema = z.enum(SORT_DIRECTIONS);

const CURSOR_REGEX = /^[A-Za-z0-9_-]+$/;

export const CursorPayloadSchema = z
  .object({
    sortField: z.string().min(1),
    sortDirection: SortDirectionSchema,
    lastId: z.string().min(1),
    lastSortValue: z.union([z.string(), z.number()]),
    issuedAt: z.number().int().nonnegative(),
  })
  .strict();
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export const PaginationRequestSchema = z
  .object({
    cursor: z.string().regex(CURSOR_REGEX).optional(),
    limit: z
      .number()
      .int()
      .min(MIN_PAGE_LIMIT)
      .max(MAX_PAGE_LIMIT)
      .default(DEFAULT_PAGE_LIMIT),
    sortField: z.string().min(1).optional(),
    sortDirection: SortDirectionSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.cursor !== undefined && (v.sortField !== undefined || v.sortDirection !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursor"],
        message:
          "cannot provide both cursor and sortField/sortDirection (cursor encodes the sort)",
      });
    }
  });
export type PaginationRequest = z.infer<typeof PaginationRequestSchema>;

export interface PageMeta<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
  readonly totalEstimate?: number;
}

export const PaginationResponseMetaSchema = z
  .object({
    nextCursor: z.string().regex(CURSOR_REGEX).nullable(),
    hasMore: z.boolean(),
    limit: z.number().int().min(MIN_PAGE_LIMIT).max(MAX_PAGE_LIMIT),
    totalEstimate: z.number().int().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.nextCursor === null && v.hasMore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hasMore"],
        message: "hasMore=true requires a non-null nextCursor",
      });
    }
    if (v.nextCursor !== null && !v.hasMore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextCursor"],
        message: "nextCursor is non-null only when hasMore=true",
      });
    }
  });
export type PaginationResponseMeta = z.infer<typeof PaginationResponseMetaSchema>;

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += BASE64URL_ALPHABET[a >> 2];
    out += BASE64URL_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    out += BASE64URL_ALPHABET[((b & 0x0f) << 2) | (c >> 6)];
    out += BASE64URL_ALPHABET[c & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const a = bytes[i] ?? 0;
    out += BASE64URL_ALPHABET[a >> 2];
    out += BASE64URL_ALPHABET[(a & 0x03) << 4];
  } else if (remaining === 2) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    out += BASE64URL_ALPHABET[a >> 2];
    out += BASE64URL_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    out += BASE64URL_ALPHABET[(b & 0x0f) << 2];
  }
  return out;
}

function base64UrlToBytes(value: string): Uint8Array {
  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    const ch = BASE64URL_ALPHABET[i];
    if (ch !== undefined) lookup[ch] = i;
  }
  const len = value.length;
  const fullGroups = Math.floor(len / 4);
  const remainder = len % 4;
  const outLength = fullGroups * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  const out = new Uint8Array(outLength);
  let outIndex = 0;
  let i = 0;
  for (let g = 0; g < fullGroups; g++) {
    const a = lookup[value[i++] ?? ""];
    const b = lookup[value[i++] ?? ""];
    const c = lookup[value[i++] ?? ""];
    const d = lookup[value[i++] ?? ""];
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      throw new Error("invalid base64url character");
    }
    out[outIndex++] = (a << 2) | (b >> 4);
    out[outIndex++] = ((b & 0x0f) << 4) | (c >> 2);
    out[outIndex++] = ((c & 0x03) << 6) | d;
  }
  if (remainder === 2) {
    const a = lookup[value[i++] ?? ""];
    const b = lookup[value[i++] ?? ""];
    if (a === undefined || b === undefined) throw new Error("invalid base64url character");
    out[outIndex++] = (a << 2) | (b >> 4);
  } else if (remainder === 3) {
    const a = lookup[value[i++] ?? ""];
    const b = lookup[value[i++] ?? ""];
    const c = lookup[value[i++] ?? ""];
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error("invalid base64url character");
    }
    out[outIndex++] = (a << 2) | (b >> 4);
    out[outIndex++] = ((b & 0x0f) << 4) | (c >> 2);
  } else if (remainder === 1) {
    throw new Error("invalid base64url length");
  }
  return out;
}

export function encodeCursor(payload: CursorPayload): string {
  CursorPayloadSchema.parse(payload);
  const json = JSON.stringify(payload);
  const bytes = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i) & 0xff;
  return bytesToBase64Url(bytes);
}

export function decodeCursor(cursor: string): CursorPayload {
  if (!CURSOR_REGEX.test(cursor)) {
    throw new Error("cursor must be base64url");
  }
  const bytes = base64UrlToBytes(cursor);
  let json = "";
  for (let i = 0; i < bytes.length; i++) json += String.fromCharCode(bytes[i] ?? 0);
  const parsed: unknown = JSON.parse(json);
  return CursorPayloadSchema.parse(parsed);
}

export function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_LIMIT;
  if (requested < MIN_PAGE_LIMIT) return MIN_PAGE_LIMIT;
  if (requested > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return Math.floor(requested);
}

export function buildPageMeta<T>(
  data: readonly T[],
  nextCursor: string | null,
  limit: number,
  totalEstimate?: number,
): PageMeta<T> {
  return {
    data,
    nextCursor,
    hasMore: nextCursor !== null,
    limit,
    totalEstimate,
  };
}
