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
 *
 * It takes `p` because `256 * n * r` -- what this computed until ADR-0398 -- is **not** always
 * above `128 * r * (n + p + 2)`: the two cross at `n = p + 2`, so for `n < p + 2` the allowance was
 * *below* the requirement and scrypt threw the very error this function exists to avoid. The hole
 * sat exactly on `parsePasswordHash`'s own floor, which admits `n = 2`, and `n = 2, p = 1` is the
 * one parameter set that function called re-derivable and this one could not derive. Measured on
 * pure Node (v22.23.4): `n=2, r=1, p=1` threw under `256*n*r` and answers in 0 ms
 * under this form, while at the shipped defaults the two forms differ by **6,144 bytes** of
 * allowance (67,108,864 -> 67,115,008) and by nothing else. The cost is unchanged *by
 * construction* and not merely measured-small: `maxmem` is a **ceiling** node compares against,
 * never an allocation, so raising it cannot make a derivation dearer -- 15 runs each put the
 * medians at 73.0 ms and 74.9 ms over ranges of 65.6-78.3 and 68.3-77.7, which is one noise
 * distribution. (An earlier draft of this comment quoted "74 ms -> 77 ms" beside the allowance
 * delta, which reads as a consequence of it. It is not one.) So the correction closes the
 * degenerate corner at the root for free, rather than being worked around one level up by a floor
 * nobody could derive from the formula.
 */
export function scryptMaxmem(n: number, r: number, p: number): number {
  return 256 * r * (n + p + 2);
}

export interface PasswordScryptParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

/**
 * The two resources a parameter set spends, bounded separately -- which is the whole decision, and
 * it is what a single ceiling gets wrong.
 *
 * CPU is proportional to `n * r * p` and memory to `128 * r * (n + p + 2)`, so **`p` buys CPU for
 * free**: measured on 4 cores at the shipped `n=2^15, r=8`, `p=512` costs **29.8 s at 34.1 MB** and
 * `p=1024` **60.7 s at 34.6 MB** -- flat memory at every value. `r` buys both, so an *unbounded* `r`
 * is stopped by the host rather than by us: `r=1024` needs **4.3 GB**, and N=2^24 at r=8 answers
 * `Deriving bits failed` against a 17 GB requirement. ADR-0395 named `r` as the hazard and quoted
 * ~30 s; that figure is `p`'s. A ceiling on memory alone would admit the 60-second row; one on CPU
 * alone would admit the 4.3 GB row. Hence two.
 *
 * **But "`r`'s own worst case is the one the host refuses for us" was false of the band that
 * matters**, and an adversarial pass over ADR-0398 measured it: *inside* these ceilings `r` is the
 * **dearest** lever, not the self-limiting one. Three admitted sets at identical work 4,194,304 span
 * **972 ms to 3,481 ms** -- `n=2, r=2^20, p=2` is 3,481 ms, `n=2, r=1, p=2^21` 2,959 ms, and the
 * n-heavy `n=2^19, r=8, p=1` only 1,329 ms -- so `n * r * p` is a *cost model* and not a wall-clock
 * one, and a bound stated in work does not bound latency uniformly across shapes. The host refuses
 * nothing these ceilings admit; the ceilings are the whole fence.
 *
 * The column's CHECK is `[0-9]+` three times -- no bound, no digit cap -- so `p=99999999` stores
 * and, linear in `p`, costs **~5.9 million seconds (68 days)** on one of four libuv threads at
 * 34 MB. (An earlier draft said ~1.6 million, which understates it 3.7x and is inconsistent with
 * this comment's own `p=1024` figure one paragraph up -- 60.7 s / 1024 is 59 ms per `p`. It looks
 * like the `r=1024` row's 15.0 s transposed onto `p`.) Four such rows starve fs and dns for every
 * request, not only logins.
 *
 * 16x admits OWASP's N=2^17 floor, which is 4x the default, with room for a deployment to raise it
 * twice more. 1 GiB is ~30x the default's 33.6 MB. Neither is a tight bound and neither can be: a
 * legitimate OWASP-floor hash already costs hundreds of milliseconds, so the job here is to make
 * the worst case recoverable rather than to eliminate cost -- and **the worst admitted case is
 * ~3.5 s, not the ~1.3 s an earlier draft claimed**, which was the n-heavy shape stated as the cap.
 *
 * Two cautions for anyone quoting these numbers. **The wall-clock figures in this file come from at
 * least two hosts**: the cost table below puts N=2^17 at 501-981 ms where a later pass measured
 * 313.6 ms for the same parameters, a 1.6-1.9x spread, so a figure here is a *host's* measurement
 * and only the ratios travel. And **`PASSWORD_MEMORY_CEILING_BYTES` bounds OpenSSL's `Blen+Vlen`,
 * not resident memory**: a p-heavy set runs at ~1.9x its model and `n=2, r=1677721, p=1` peaks at
 * ~1,275 MB against a model of 1 GiB minus 384 bytes, so "stays allocatable on a small VM" is
 * understated by about 200 MB at the extreme.
 */
export const PASSWORD_WORK_CEILING_FACTOR = 16;
/**
 * 1 GiB. Not expressed as a multiple, because what bounds it is the host and not the default.
 *
 * **It is also, by coincidence, `128 * N * r` at `N=2^20, r=8` -- the *documented* formula
 * `scryptMaxmem` calls the trap eleven lines above** -- so it lands exactly **3,072 bytes** below
 * the real `128 * r * (N + p + 2)` requirement for that set, which is the same 3,072 bytes that
 * comment names as the whole problem. The consequence is that scrypt's canonical file-encryption
 * set (Percival's own `N=2^20, r=8, p=1`, and libsodium's `SENSITIVE` preset) is refused *by this
 * ceiling* and not only by the work one.
 *
 * Left at a round 1 GiB rather than nudged to `1 GiB + 3,072`, on two grounds. The effect is nil:
 * that set is **32x** the default's work and the CPU ceiling refuses it at 16x regardless, so
 * raising this constant changes nothing admitted. And the constant means *what this host can
 * allocate*, which is a round number by nature; deriving it from a parameter set would be the
 * category error the coincidence invites. Said out loud because the next reader will draw the
 * inference an adversarial pass over ADR-0398 drew, and it is worth knowing it is not the
 * provenance.
 */
export const PASSWORD_MEMORY_CEILING_BYTES = 1_073_741_824;

/** `n * r * p` for the shipped defaults, which both ceilings are stated relative to. */
export const PASSWORD_DEFAULT_WORK =
  PASSWORD_SCRYPT_DEFAULTS.n * PASSWORD_SCRYPT_DEFAULTS.r * PASSWORD_SCRYPT_DEFAULTS.p;

/**
 * Whether this build will derive under these parameters at all.
 *
 * One predicate with two readers, so the write path and the read path cannot come to disagree about
 * which hashes exist -- a hash `hashPassword` accepted and `parsePasswordHash` then refused would be
 * a row written by this binary that this binary calls unreadable.
 *
 * **Four clauses, and the third is not a cost bound.** RFC 7914 §6 requires `N < 2^(16*r)`, and
 * OpenSSL enforces it -- reporting the violation with **the same error code as a memory-limit
 * failure** (`error:030000AC … memory limit exceeded`, `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`), which
 * is why it reads as a `maxmem` problem and is not one: such a set throws at **any** `maxmem`,
 * `MAX_SAFE_INTEGER` included. Without this clause the two cost ceilings admitted **127** sets that
 * cannot derive at all -- every `r = 1` with `n >= 2^16` -- so `parsePasswordHash` admitted the row
 * and `deriveScrypt` threw, which by this module's own account becomes a retryable **503 with a
 * false diagnosis** that bypasses the `credential_unreadable` 401. That is the exact defect
 * ADR-0398 exists to close, and the two ceilings *created* its reachable population; found by an
 * adversarial pass over that increment rather than by it. It only ever bites at `r = 1`, because
 * the work ceiling already forces `n <= 2^22` and `2^32` is the bound at `r = 2`.
 *
 * Shape first, and **the ordering's original justification was backwards**: it read *"a
 * non-power-of-two `n` makes the cost arithmetic meaningless rather than merely large"*, implying
 * the shape check is self-sufficient. It is not -- `n & (n - 1)` coerces to int32, so it answers
 * *power of two* for non-powers at or above 2^31 (`2^32 + 4` measured as admitted by that clause
 * alone), and what saves it is the **cost** ceiling forcing `n <= 4,194,304`, well inside int32.
 * So shape first is right only because cost follows; raising or removing the work ceiling makes the
 * shape check live, and it would need `Math.log2(n) % 1 === 0` to stand alone.
 */
export function passwordParamsAreDerivable(params: PasswordScryptParams): boolean {
  const { n, r, p } = params;
  if (!Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return false;
  // RFC 7914 §6, enforced by OpenSSL under a misleading error code. `2 ** (16 * r)` is `Infinity`
  // for `r >= 64`, which is the right answer: there is no `n` the work ceiling admits at that `r`.
  if (n >= 2 ** (16 * r)) return false;
  if (n * r * p > PASSWORD_DEFAULT_WORK * PASSWORD_WORK_CEILING_FACTOR) return false;
  return 128 * r * (n + p + 2) <= PASSWORD_MEMORY_CEILING_BYTES;
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
  const params = { n: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // A stored hash whose parameters are degenerate cannot be re-derived, and treating it as a
  // mismatch would tell the caller their password was wrong. `unreadable_hash` is a different
  // fact and the caller is expected to act on it differently.
  //
  // Since ADR-0398 that covers *cost* as well as shape, and the cost half is what the comment
  // above was already promising and not delivering. `deriveScrypt` **throws** for a parameter set
  // this used to admit, and a throw out of `verifyPassword` is not an `unreadable_hash`: it
  // propagates through `verifyLogin` to the route's `ctx.verify` catch, which answers
  // `503 "The credential directory could not be reached. Retry shortly."` -- a retryable status
  // with a false diagnosis (the directory was reached; one row is unusable) that also bypasses the
  // `credential_unreadable` **401** arm built for exactly this. Refusing here is what routes the
  // row back to the answer this function's own contract names.
  //
  // The ceiling is on the two resources rather than on each parameter, because the hazard moves
  // between them: see `passwordParamsAreDerivable`.
  if (!passwordParamsAreDerivable(params)) return null;
  return { kdf: PASSWORD_KDF, params, saltHex: m[4]!, hashHex: m[5]! };
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
      {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: scryptMaxmem(params.n, params.r, params.p),
      },
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
  // Refused at the write as well as the read, and a throw rather than a `null` because this is the
  // salt-length guard's position: a caller supplying its own parameters has made a mistake it can
  // fix, where a *stored* row is a fact the reader has to absorb. Without it the two halves could
  // disagree -- `hashPassword` would mint a row `parsePasswordHash` calls unreadable, which is the
  // one shape a shared predicate exists to make unrepresentable.
  if (!passwordParamsAreDerivable(params)) {
    throw new Error(
      `scrypt parameters outside this build's bounds: n=${params.n.toString()}` +
        ` r=${params.r.toString()} p=${params.p.toString()}`,
    );
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
