/**
 * How many password verifications may run at once, decided **before** any scrypt work.
 *
 * ## Why a lockout is not a limiter
 *
 * The lockout bounds guesses against one account. It does nothing about *how many* derivations run
 * at once, and a derivation is ~80-130 ms on a libuv thread pool of 4 (by default) that is shared
 * with `fs` and `dns`. Measured before this module existed, against a real Postgres: 80 concurrent
 * logins for unknown addresses -- each of which spends a full derivation by design, so an unknown
 * address costs exactly what a real one does -- took 2.17 s, and an `fs.readFile` issued during the
 * burst waited **2,095 ms** for a thread. So an unauthenticated caller could stall every file and
 * DNS operation in the process, not merely the login.
 *
 * ## What this does and does not buy
 *
 * At most `concurrency` verifications run, at most `queue` wait for a slot (FIFO, doing no work
 * while they wait), and everything past that is answered at once with a retryable status. The cap
 * is derived from the pool size and leaves one thread free, so `fs` and `dns` are never fully
 * starved by sign-ins. It does **not** stop a flood from occupying every sign-in slot: login is
 * still deniable by volume, and the process around it is not. That is the trade, stated rather than
 * implied away -- shedding is cheap and bounded, where the alternative was unbounded queueing on a
 * resource the whole process shares.
 *
 * ## Why a refusal here is not an enumeration oracle
 *
 * The login answers one body for every *refusal of a credential* because an unauthenticated caller
 * must learn nothing about an account. An admission refusal is decided before any lookup, from two
 * facts the caller controls: how many sign-ins are in flight across the process, and how many name
 * the same normalised email string. Neither depends on whether that email names a user, so a
 * 429/503 is the same answer for an address that exists and one that does not, and it is
 * deliberately a different status from the 401 because it says *come back*, not *wrong password*.
 * Admitted requests are unchanged: every path still spends a derivation.
 */

export const LOGIN_ADMISSION_REFUSALS = ["saturated", "account_busy"] as const;
export type LoginAdmissionRefusal = (typeof LOGIN_ADMISSION_REFUSALS)[number];

/**
 * `saturated` is 503: the process is out of verification capacity, a fact about the server.
 * `account_busy` is 429: this caller already has the per-account allowance in flight, a fact about
 * the caller's own request rate.
 */
export const LOGIN_ADMISSION_REFUSAL_STATUS: Readonly<Record<LoginAdmissionRefusal, 429 | 503>> =
  Object.freeze({ saturated: 503, account_busy: 429 });

export interface LoginAdmissionPolicy {
  /** Verifications that may run at once, across the process. */
  readonly concurrency: number;
  /** Requests that may wait for a slot. Past this they are refused rather than queued. */
  readonly queue: number;
  /** Requests naming one account that may be in flight (running or queued) at once. */
  readonly perAccount: number;
  readonly retryAfterSeconds: number;
}

const DEFAULT_UV_THREADPOOL_SIZE = 4;
const MAX_UV_THREADPOOL_SIZE = 1024;

/**
 * The libuv pool size this process was started with, read the way libuv reads it.
 *
 * Read from the environment and never configured separately: the cap protects that pool, so it is
 * derived from the one number that sizes it. A deployment wanting more sign-in throughput raises
 * `UV_THREADPOOL_SIZE`, which is the resource, rather than a second knob that could disagree with
 * it. A value that does not parse as a positive integer reads as 1, the conservative answer.
 */
export function libuvPoolSize(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env["UV_THREADPOOL_SIZE"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_UV_THREADPOOL_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_UV_THREADPOOL_SIZE);
}

/** One thread is left for `fs` and `dns`; a pool of one has nothing to leave. */
export function defaultLoginAdmissionPolicy(poolSize: number = libuvPoolSize()): LoginAdmissionPolicy {
  const concurrency = Math.max(1, poolSize - 1);
  return Object.freeze({ concurrency, queue: concurrency * 4, perAccount: 2, retryAfterSeconds: 1 });
}

export type Admission =
  | { readonly admitted: true; readonly release: () => void }
  | {
      readonly admitted: false;
      readonly refusal: LoginAdmissionRefusal;
      readonly retryAfterSeconds: number;
    };

export class LoginAdmission {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly perKey = new Map<string, number>();

  constructor(readonly policy: LoginAdmissionPolicy) {
    if (!Number.isInteger(policy.concurrency) || policy.concurrency < 1) {
      throw new Error(`login admission concurrency must be an integer >= 1, got ${String(policy.concurrency)}`);
    }
    if (!Number.isInteger(policy.queue) || policy.queue < 0) {
      throw new Error(`login admission queue must be an integer >= 0, got ${String(policy.queue)}`);
    }
    if (!Number.isInteger(policy.perAccount) || policy.perAccount < 1) {
      throw new Error(`login admission per-account cap must be an integer >= 1, got ${String(policy.perAccount)}`);
    }
    if (!Number.isInteger(policy.retryAfterSeconds) || policy.retryAfterSeconds < 1) {
      throw new Error(`login admission Retry-After must be an integer >= 1, got ${String(policy.retryAfterSeconds)}`);
    }
  }

  /**
   * Admits, queues or refuses. The per-account check comes first and counts queued requests too, so
   * one account cannot hold the queue: what matters for an account is how many of its guesses are
   * in flight, not whether they are running yet.
   */
  async enter(accountKey: string): Promise<Admission> {
    const held = this.perKey.get(accountKey) ?? 0;
    if (held >= this.policy.perAccount) return this.refuse("account_busy");
    if (this.active >= this.policy.concurrency && this.waiters.length >= this.policy.queue) {
      return this.refuse("saturated");
    }
    this.perKey.set(accountKey, held + 1);
    if (this.active < this.policy.concurrency) {
      this.active += 1;
    } else {
      // The slot is handed over by `release` rather than re-contended, so a waiter cannot be
      // overtaken by a request that arrived after it.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        const now = (this.perKey.get(accountKey) ?? 1) - 1;
        if (now <= 0) this.perKey.delete(accountKey);
        else this.perKey.set(accountKey, now);
        const next = this.waiters.shift();
        if (next !== undefined) next();
        else this.active -= 1;
      },
    };
  }

  snapshot(): { readonly active: number; readonly queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  private refuse(refusal: LoginAdmissionRefusal): Admission {
    return { admitted: false, refusal, retryAfterSeconds: this.policy.retryAfterSeconds };
  }
}

/**
 * Reports shedding at most once per interval, with the count since the last report.
 *
 * A flood is exactly when shedding happens, so a line per refused request would turn the defence
 * into a log-volume attack. One line per interval says the same thing and stays bounded.
 */
export function buildShedReporter(
  admission: LoginAdmission,
  report: (line: string) => void,
  intervalMs: number,
  clock: () => number = Date.now,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  let pending = 0;
  return () => {
    pending += 1;
    const now = clock();
    if (now - last < intervalMs) return;
    last = now;
    const snap = admission.snapshot();
    report(
      `[auth] shed ${pending.toString()} sign-in request(s) before any password work` +
        ` (${snap.active.toString()} running, ${snap.queued.toString()} queued,` +
        ` cap ${admission.policy.concurrency.toString()}+${admission.policy.queue.toString()},` +
        ` ${admission.policy.perAccount.toString()} per account)`,
    );
    pending = 0;
  };
}
