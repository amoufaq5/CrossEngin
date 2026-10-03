/**
 * The request body cap — a denial-of-service control, now a configuration rather than a constant.
 *
 * The listener buffers a request body in memory before it dispatches, so the cap is the only thing
 * bounding what one unauthenticated connection can make the process allocate. Three properties follow
 * from that, and they are why this is a module rather than a number:
 *
 * - **It is enforced per chunk, as the body arrives.** Checking `content-length` is not enough (a
 *   chunked request declares none, and a header is a claim) and checking after the read is not a
 *   control at all — by then the allocation has already happened. `readLimitedBody` refuses on the
 *   chunk that crosses the line and never pulls the next one.
 * - **A configured value cannot disable it.** There is no "unlimited": absent means the default, and a
 *   value outside the band is refused rather than clamped, because silently accepting a nonsense cap is
 *   how the control goes missing. `0` and `Infinity` are not tighter and looser settings, they are both
 *   the absence of a cap in one direction or the other.
 * - **A floor, not only a ceiling.** A cap under a few kilobytes 413s ordinary JSON writes, which reads
 *   as a broken server rather than as a strict one.
 */

/** 10 MiB — the cap in force since P1.7, kept as the default so no deployment changes behaviour. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/** 1 KiB. Below this a routine entity write 413s, so a smaller value is a misconfiguration. */
export const MIN_REQUEST_BODY_LIMIT_BYTES = 1024;

/**
 * 1 GiB. The point of a ceiling is that the protection cannot be configured away: the body is held
 * whole in memory, per concurrent request, so a value above this is indistinguishable from no cap.
 * A deployment that genuinely must accept more than a gigabyte in one request wants the signed-URL
 * upload path in `@crossengin/files`, not a bigger buffer.
 */
export const MAX_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024 * 1024;

/** Thrown when a programmatic caller supplies a limit outside the band. */
export class RequestBodyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyLimitError";
  }
}

/** Thrown by `readLimitedBody` on the chunk that crosses the cap; the listener maps it to 413. */
export class RequestBodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`request body exceeds ${limitBytes.toString()} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

function rangeFailure(bytes: number): string | null {
  if (!Number.isInteger(bytes)) {
    return `must be a whole number of bytes, got ${String(bytes)}`;
  }
  if (bytes < MIN_REQUEST_BODY_LIMIT_BYTES) {
    return `must be at least ${MIN_REQUEST_BODY_LIMIT_BYTES.toString()} bytes, got ${bytes.toString()}`;
  }
  if (bytes > MAX_REQUEST_BODY_LIMIT_BYTES) {
    return `must be at most ${MAX_REQUEST_BODY_LIMIT_BYTES.toString()} bytes (1 GiB), got ${bytes.toString()}`;
  }
  return null;
}

/**
 * The limit the listener enforces. `null`/`undefined` means "not configured" and yields the default;
 * anything outside the band throws, so a caller cannot produce a server with the control removed.
 */
export function resolveMaxRequestBodyBytes(configured: number | null | undefined): number {
  if (configured === null || configured === undefined) return DEFAULT_MAX_REQUEST_BODY_BYTES;
  const failure = rangeFailure(configured);
  if (failure !== null) {
    throw new RequestBodyLimitError(`request body limit ${failure}`);
  }
  return configured;
}

export type RequestBodyLimitParse =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

const SIZE_RE = /^(\d+)(b|kb|mb|gb|kib|mib|gib)?$/;

const UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  kib: 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
};

/**
 * Parses a CLI/env size into bytes: a bare integer, or one with a `kb`/`mb`/`gb` suffix. The suffixes
 * exist because a cap written in raw bytes is a place to lose a factor of 1000 by eye, and the mistake
 * is only visible in production. Returns a result rather than throwing so the caller can raise its own
 * usage error with the flag name attached.
 */
export function parseRequestBodyLimit(raw: string): RequestBodyLimitParse {
  const match = SIZE_RE.exec(raw.trim().toLowerCase());
  if (match === null) {
    return { ok: false, reason: `expected bytes or a size like 25mb, got '${raw}'` };
  }
  const digits = match[1] ?? "";
  const unit = match[2] ?? "b";
  const multiplier = UNIT_MULTIPLIERS[unit] ?? 1;
  const bytes = Number(digits) * multiplier;
  if (!Number.isSafeInteger(bytes)) {
    return { ok: false, reason: `'${raw}' does not fit in a safe integer number of bytes` };
  }
  const failure = rangeFailure(bytes);
  if (failure !== null) return { ok: false, reason: failure };
  return { ok: true, bytes };
}

/**
 * Buffers an incoming body, refusing as soon as the running total passes `limitBytes`.
 *
 * The refusal happens inside the loop, before the next chunk is requested: an over-limit request costs
 * the bytes already in flight and nothing more. Returns `null` for an empty body, which the gateway
 * distinguishes from a zero-length one.
 */
export async function readLimitedBody(
  source: AsyncIterable<Uint8Array>,
  limitBytes: number = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<Uint8Array | null> {
  const limit = resolveMaxRequestBodyBytes(limitBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > limit) throw new RequestBodyTooLargeError(limit);
    chunks.push(chunk);
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
