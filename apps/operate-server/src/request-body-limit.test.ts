import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  MAX_REQUEST_BODY_LIMIT_BYTES,
  MIN_REQUEST_BODY_LIMIT_BYTES,
  parseRequestBodyLimit,
  readLimitedBody,
  RequestBodyLimitError,
  RequestBodyTooLargeError,
  resolveMaxRequestBodyBytes,
} from "./request-body-limit.js";

function bytes(n: number): Uint8Array {
  return new Uint8Array(n);
}

async function* yielding(...chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

describe("the band", () => {
  it("defaults to the 10 MiB cap that has been in force since P1.7", () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(10 * 1024 * 1024);
  });

  it("sits inside its own floor and ceiling", () => {
    expect(MIN_REQUEST_BODY_LIMIT_BYTES).toBeLessThan(DEFAULT_MAX_REQUEST_BODY_BYTES);
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBeLessThan(MAX_REQUEST_BODY_LIMIT_BYTES);
  });
});

describe("resolveMaxRequestBodyBytes", () => {
  it("yields the default when nothing is configured", () => {
    expect(resolveMaxRequestBodyBytes(null)).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
    expect(resolveMaxRequestBodyBytes(undefined)).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
  });

  it("accepts a larger cap and a tighter one", () => {
    expect(resolveMaxRequestBodyBytes(64 * 1024 * 1024)).toBe(64 * 1024 * 1024);
    expect(resolveMaxRequestBodyBytes(64 * 1024)).toBe(64 * 1024);
  });

  it("accepts the exact boundaries", () => {
    expect(resolveMaxRequestBodyBytes(MIN_REQUEST_BODY_LIMIT_BYTES)).toBe(
      MIN_REQUEST_BODY_LIMIT_BYTES,
    );
    expect(resolveMaxRequestBodyBytes(MAX_REQUEST_BODY_LIMIT_BYTES)).toBe(
      MAX_REQUEST_BODY_LIMIT_BYTES,
    );
  });

  it("refuses a value that would remove the control", () => {
    for (const disabling of [0, -1, Number.POSITIVE_INFINITY, MAX_REQUEST_BODY_LIMIT_BYTES + 1]) {
      expect(() => resolveMaxRequestBodyBytes(disabling)).toThrow(RequestBodyLimitError);
    }
  });

  it("refuses a value so small the server would 413 ordinary writes", () => {
    expect(() => resolveMaxRequestBodyBytes(MIN_REQUEST_BODY_LIMIT_BYTES - 1)).toThrow(
      RequestBodyLimitError,
    );
  });

  it("refuses a non-integer and NaN rather than truncating", () => {
    expect(() => resolveMaxRequestBodyBytes(1024.5)).toThrow(RequestBodyLimitError);
    expect(() => resolveMaxRequestBodyBytes(Number.NaN)).toThrow(RequestBodyLimitError);
  });

  it("names the band in the message", () => {
    expect(() => resolveMaxRequestBodyBytes(2)).toThrow(/at least 1024 bytes/);
    expect(() => resolveMaxRequestBodyBytes(2 * MAX_REQUEST_BODY_LIMIT_BYTES)).toThrow(/1 GiB/);
  });
});

describe("parseRequestBodyLimit", () => {
  it("reads a bare byte count", () => {
    expect(parseRequestBodyLimit("1048576")).toEqual({ ok: true, bytes: 1048576 });
  });

  it("reads binary suffixes, case-insensitively and with surrounding space", () => {
    expect(parseRequestBodyLimit("25mb")).toEqual({ ok: true, bytes: 25 * 1024 * 1024 });
    expect(parseRequestBodyLimit(" 25MB ")).toEqual({ ok: true, bytes: 25 * 1024 * 1024 });
    expect(parseRequestBodyLimit("25MiB")).toEqual({ ok: true, bytes: 25 * 1024 * 1024 });
    expect(parseRequestBodyLimit("64kb")).toEqual({ ok: true, bytes: 64 * 1024 });
    expect(parseRequestBodyLimit("1gb")).toEqual({ ok: true, bytes: 1024 * 1024 * 1024 });
    expect(parseRequestBodyLimit("2048b")).toEqual({ ok: true, bytes: 2048 });
  });

  it("refuses a value outside the band with the same rule resolve uses", () => {
    const tooBig = parseRequestBodyLimit("2gb");
    expect(tooBig.ok).toBe(false);
    expect(tooBig.ok ? "" : tooBig.reason).toContain("1 GiB");

    const tooSmall = parseRequestBodyLimit("8");
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.ok ? "" : tooSmall.reason).toContain("at least 1024");
  });

  it("refuses zero, which would reject every body", () => {
    expect(parseRequestBodyLimit("0").ok).toBe(false);
    expect(parseRequestBodyLimit("0mb").ok).toBe(false);
  });

  it("refuses shapes that are not a size", () => {
    for (const raw of ["", "none", "unlimited", "-1", "10 mb", "1.5mb", "10tb", "1e9", "Infinity"]) {
      expect(parseRequestBodyLimit(raw).ok, raw).toBe(false);
    }
  });

  it("refuses a count that overflows a safe integer before range-checking it", () => {
    const result = parseRequestBodyLimit("99999999999999999999gb");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("safe integer");
  });
});

describe("readLimitedBody", () => {
  it("returns null for an empty stream", async () => {
    await expect(readLimitedBody(yielding())).resolves.toBeNull();
    await expect(readLimitedBody(yielding(bytes(0)))).resolves.toBeNull();
  });

  it("joins chunks in order", async () => {
    const body = await readLimitedBody(
      yielding(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])),
    );
    expect(body === null ? [] : [...body]).toEqual([1, 2, 3, 4, 5]);
  });

  it("accepts a body exactly at the limit", async () => {
    const body = await readLimitedBody(yielding(bytes(1024), bytes(1024)), 2048);
    expect(body?.byteLength).toBe(2048);
  });

  it("refuses one byte over the limit", async () => {
    await expect(readLimitedBody(yielding(bytes(2048), bytes(1)), 2048)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("carries the limit it enforced, which the 413 document reports", async () => {
    const error = await readLimitedBody(yielding(bytes(4096)), 2048).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestBodyTooLargeError);
    expect((error as RequestBodyTooLargeError).limitBytes).toBe(2048);
    expect((error as RequestBodyTooLargeError).message).toContain("2048");
  });

  it("stops pulling the stream on the chunk that crosses the limit", async () => {
    // The whole point of the cap: an over-limit request must not be allowed to allocate the rest of
    // itself. If this ever reads to the end, the control has become a post-hoc check.
    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled += 1;
        yield bytes(1024);
      }
    }
    await expect(readLimitedBody(endless(), 4096)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(pulled).toBe(5);
  });

  it("enforces the default cap when no limit is passed", async () => {
    const megabyte = bytes(1024 * 1024);
    async function* eleven(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 11; i++) yield megabyte;
    }
    const error = await readLimitedBody(eleven()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestBodyTooLargeError);
    expect((error as RequestBodyTooLargeError).limitBytes).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
  });

  it("refuses a disabling limit before reading anything", async () => {
    let pulled = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      pulled += 1;
      yield bytes(1);
    }
    await expect(readLimitedBody(counted(), 0)).rejects.toBeInstanceOf(RequestBodyLimitError);
    expect(pulled).toBe(0);
  });
});
