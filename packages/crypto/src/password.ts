import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { hmacSha256Hex } from "./hmac.js";

/**
 * Password verification for `POST /v1/auth/token`.
 *
 * The three pins in `algorithms.ts` are untouched and `isCryptoOperation("encrypt")` stays false,
 * for `aead.ts`' reason: they describe the key **registry** -- which algorithms a registered
 * `KeyHandle` may carry, what a handle is for, which key-management acts are audited -- and a
 * password hash registers no key, holds no material in `meta.crypto_keys` and has no lifecycle.
 * scrypt is not a `KeyAlgorithm` and must not become one: a registerable scrypt "key" would need
 * a private-material column that table does not have.
 */

/** The one KDF this module produces. Encoded into every hash, so a reader never has to guess. */
export const PASSWORD_KDF = "scrypt" as const;

/**
 * scrypt cost, measured on a 4-core 2026 cloud VM (min-of-3, r=8, p=1, 64-byte output):
 *
 *   N=2^14   56-70 ms    16 MiB
 *   N=2^15  114-144 ms   32 MiB   <- default
 *   N=2^16  218-475 ms   64 MiB
 *   N=2^17  501-981 ms  128 MiB
 *
 * 2^15 is the default because the cost lands where an interactive login can afford it and the
 * memory stays inside a small VM. OWASP's floor is 2^17, which is ~700 ms here and 128 MiB per
 * concurrent login -- a real denial of service against a 4-thread pool -- so the parameters are
 * stored per hash and a deployment that can afford more raises `n` without invalidating anything.
 */
export const PASSWORD_SCRYPT_DEFAULTS = Object.freeze({ n: 32768, r: 8, p: 1 });

/** 16 bytes, which is what the column's CHECK pins as 32 hex characters. */
export const PASSWORD_SALT_BYTES = 16;
/** 64 bytes, pinned by the column's CHECK as 128 hex characters. */
export const PASSWORD_HASH_BYTES = 64;

/**
 * Node's default scrypt `maxmem` is 32 MiB, and the real requirement -- found by bisection, not
 * from the documented `128 * N * r` -- is `128 * r * (N + p + 2)`: exactly 3,072 bytes more at
 * r=8, p=1. That tiny excess is the whole problem, because `128 * N * r` at the default N=2^15,
 * r=8 is **exactly** 33,554,432, i.e. precisely the default ceiling, so the requirement sits just
 * above it and scrypt throws
 * `error:030000AC:digital envelope routines::memory limit exceeded`.
 *
 * Measured: N=2^14 succeeds with no `maxmem` and N=2^15 does not. So omitting it is a silent
 * ceiling at 2^14 that nobody declared, and computing it from the documented formula would leave
 * the default parameters failing by 3 KiB. The factor of 2 is deliberate headroom over the
 * measured minimum rather than a value fitted to it.
 */
export function scryptMaxmem(n: number, r: number): number {
  return 256 * n * r;
}

export interface PasswordScryptParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

/** Why a candidate password did not verify. Never distinguishes *wrong* from *no such user*. */
export const PASSWORD_VERIFY_OUTCOMES = ["matched", "mismatched", "unreadable_hash"] as const;
export type PasswordVerifyOutcome = (typeof PASSWORD_VERIFY_OUTCOMES)[number];

/**
 * `matched` is the only outcome that admits. A map rather than `outcome === "matched"` so a fourth
 * outcome is a compile error at the one place that decides, instead of a new member inheriting
 * whichever branch an `if` happened to end on.
 */
export const PASSWORD_OUTCOME_ADMITS: Readonly<
  Record<"matched", true> & Record<Exclude<PasswordVerifyOutcome, "matched">, false>
> = Object.freeze({ matched: true, mismatched: false, unreadable_hash: false });

export interface ParsedPasswordHash {
  readonly kdf: typeof PASSWORD_KDF;
  readonly params: PasswordScryptParams;
  readonly saltHex: string;
  readonly hashHex: string;
}

const ENCODED_RE =
  /^scrypt\$([0-9]+)\$([0-9]+)\$([0-9]+)\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

/**
 * `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`, the same shape the column's CHECK constrains.
 *
 * The parameters travel with the digest because a password hash that does not record them cannot
 * be verified once the deployment's defaults move, and re-deriving under today's defaults would
 * silently refuse every password set under yesterday's. That is also why there is no sibling
 * `algorithm` column: this string is the single spelling of what produced it.
 */
export function encodePasswordHash(parsed: ParsedPasswordHash): string {
  const { n, r, p } = parsed.params;
  return `${parsed.kdf}$${n.toString()}$${r.toString()}$${p.toString()}$${parsed.saltHex}$${parsed.hashHex}`;
}

/** `null` for anything this module did not produce -- never a throw, and never a partial parse. */
export function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  const m = ENCODED_RE.exec(encoded);
  if (m === null) return null;
  const n = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // A stored hash whose parameters are degenerate cannot be re-derived, and treating it as a
  // mismatch would tell the caller their password was wrong. `unreadable_hash` is a different
  // fact and the caller is expected to act on it differently.
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return null;
  return { kdf: PASSWORD_KDF, params: { n, r, p }, saltHex: m[4]!, hashHex: m[5]! };
}

/**
 * The pepper is applied **before** the KDF, so the value scrypt stretches is already keyed to this
 * deployment.
 *
 * `meta.users` has no RLS -- it carries no `tenant_id`, so by the catalog's own first invariant it
 * gets no policy -- and the confinement is the serving role's table GRANT. That role is the one
 * the gateway runs as, so the hash *is* readable by anything holding it, and the whole point of
 * the pepper is that reading the table is then not enough. Same shape as ADR-0302's per-tenant
 * bounce key and ADR-0338's column key: one deployment secret, nothing extra stored.
 *
 * HMAC and not concatenation, because a bare `pepper + password` is length-extendable and makes
 * the boundary between the two guessable; HMAC fixes the input to 32 bytes either way, which also
 * removes scrypt's own 'very long password costs more' behaviour from the request path.
 */
function pepperedInput(password: string, pepper: string): Buffer {
  // `hmacSha256Hex` carries its own 16-byte key floor, so a caller who skipped
  // `parseCredentialPepper` still cannot key this on a two-character pepper -- a second guard
  // under the parser's 32-byte one rather than a substitute for it.
  return Buffer.from(hmacSha256Hex(new TextEncoder().encode(pepper), password), "hex");
}

async function deriveScrypt(
  password: string,
  pepper: string,
  salt: Buffer,
  params: PasswordScryptParams,
): Promise<Buffer> {
  const input = pepperedInput(password, pepper);
  return new Promise<Buffer>((resolve, reject) => {
    // The ASYNC form, which is a correctness decision and not a style one: `scryptSync` at these
    // parameters blocks the event loop for ~130 ms, so every concurrent request on a single-process
    // server stalls behind one login. Measured: 8 concurrent async derivations at N=2^15 finish in
    // 415 ms with a 10 ms timer still firing 39 times. The libuv pool (4 by default, shared with
    // fs and dns) is what bounds login throughput, which is why the caller also needs a lockout
    // rather than treating the KDF cost as its rate limiter.
    scrypt(
      input,
      salt,
      PASSWORD_HASH_BYTES,
      { N: params.n, r: params.r, p: params.p, maxmem: scryptMaxmem(params.n, params.r) },
      (err, derived) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(derived);
      },
    );
  });
}

export interface HashPasswordOptions {
  readonly params?: PasswordScryptParams;
  /** Test seam only. Production callers let this default to a fresh random salt. */
  readonly salt?: Buffer;
}

export async function hashPassword(
  password: string,
  pepper: string,
  opts: HashPasswordOptions = {},
): Promise<string> {
  const params = opts.params ?? PASSWORD_SCRYPT_DEFAULTS;
  const salt = opts.salt ?? randomBytes(PASSWORD_SALT_BYTES);
  if (salt.length !== PASSWORD_SALT_BYTES) {
    throw new Error(`password salt must be ${PASSWORD_SALT_BYTES.toString()} bytes`);
  }
  const derived = await deriveScrypt(password, pepper, salt, params);
  return encodePasswordHash({
    kdf: PASSWORD_KDF,
    params,
    saltHex: salt.toString("hex"),
    hashHex: derived.toString("hex"),
  });
}

/**
 * Verifies a candidate against a stored hash, re-deriving under **the parameters the hash was
 * produced with** rather than today's defaults.
 *
 * `unreadable_hash` is kept apart from `mismatched` deliberately: the first says nothing about the
 * password and the caller must not count it as a failed attempt, because a corrupt or
 * foreign-format row would otherwise lock a user out of an account whose password they typed
 * correctly.
 */
export async function verifyPassword(
  password: string,
  encodedHash: string,
  pepper: string,
): Promise<PasswordVerifyOutcome> {
  const parsed = parsePasswordHash(encodedHash);
  if (parsed === null) return "unreadable_hash";
  const expected = Buffer.from(parsed.hashHex, "hex");
  const derived = await deriveScrypt(
    password,
    pepper,
    Buffer.from(parsed.saltHex, "hex"),
    parsed.params,
  );
  // Lengths are pinned by the regex, so this cannot throw -- but the guard stays, because
  // `timingSafeEqual` throws on a length mismatch and a throw here would escape as a 500 from the
  // one function whose whole job is to answer yes or no.
  if (expected.length !== derived.length) return "mismatched";
  return timingSafeEqual(expected, derived) ? "matched" : "mismatched";
}

/**
 * Spends one derivation's worth of work and answers `mismatched`, for the case where there is no
 * stored hash to verify against -- an unknown email, a user who has never been given a password.
 *
 * Without this an unauthenticated caller can enumerate accounts by latency alone: the natural
 * shape is to return as soon as the lookup misses, which answers in under a millisecond where a
 * real account costs ~130 ms, and the existing precedent next door has exactly that shape
 * (`resolvePrincipalForCredential` returns `principal_not_found` immediately on a miss, correctly,
 * because it is behind a credential and this is not).
 *
 * It derives under **the parameters passed in**, which must be the deployment's current ones. A
 * fixed dummy cost would equalise today and diverge the moment the floor is raised, which is the
 * sharper half of the trap: the oracle would come back silently, one parameter change later, in a
 * deployment that had already tested this.
 *
 * The salt is random per call and the result is discarded. Nothing here depends on the digest, so
 * there is no dummy hash to keep in sync with anything -- which is why this is a function and not
 * a stored record.
 */
export async function spendPasswordWork(
  password: string,
  pepper: string,
  params: PasswordScryptParams = PASSWORD_SCRYPT_DEFAULTS,
): Promise<PasswordVerifyOutcome> {
  await deriveScrypt(password, pepper, randomBytes(PASSWORD_SALT_BYTES), params);
  return "mismatched";
}

/** Whether a stored hash should be re-derived because the deployment's cost has since risen. */
export function passwordHashIsStale(
  encodedHash: string,
  params: PasswordScryptParams = PASSWORD_SCRYPT_DEFAULTS,
): boolean {
  const parsed = parsePasswordHash(encodedHash);
  if (parsed === null) return false; // unreadable is a different problem with a different remedy
  return parsed.params.n < params.n || parsed.params.r < params.r || parsed.params.p < params.p;
}
