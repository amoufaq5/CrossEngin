/**
 * The deadline every provider call runs under.
 *
 * An *inactivity* timeout rather than a total one, on purpose: a design reply of 8,192 tokens from a
 * CPU-served local model can legitimately take many minutes while bytes keep arriving, and a total
 * deadline short enough to catch a hung vendor would kill that working stream. What a hung provider
 * does that a slow one does not is go silent — so the clock is reset by every chunk that arrives and
 * fires only when nothing has arrived for `timeoutMs`, covering the wait for the response headers as
 * well as the gaps between body chunks.
 *
 * Firing aborts the `AbortSignal` handed to `fetch` (which closes the socket) **and** settles any
 * pending body read, because a body reader is not guaranteed to observe the fetch signal — a test
 * double never does, and relying on it would leave the one case this exists for hanging.
 */

export const DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS = 120_000;
export const MIN_PROVIDER_INACTIVITY_TIMEOUT_MS = 1;

export class ProviderInactivityTimeout extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`provider sent nothing for ${timeoutMs.toString()}ms; the request was aborted`);
    this.name = "ProviderInactivityTimeout";
    this.timeoutMs = timeoutMs;
  }
}

export interface InactivityWatchdog {
  /** Pass to `fetch`; aborted when the watchdog fires. */
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  /** Something arrived: restart the clock. */
  touch(): void;
  /** Stop the clock; idempotent. Call in a `finally`. */
  dispose(): void;
  /**
   * `promise`, settled early with `ProviderInactivityTimeout` if the watchdog fires first. For the
   * wait on the response headers, where a transport that ignores `signal` would otherwise hang.
   */
  guard<T>(promise: Promise<T>): Promise<T>;
  /**
   * The body, read under the watchdog: each chunk restarts the clock, a pending read rejects with
   * `ProviderInactivityTimeout` when it fires, and cancelling the wrapper cancels the source, so a
   * consumer that stops reading early releases the connection instead of leaving it open.
   */
  watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}

export function resolveInactivityTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PROVIDER_INACTIVITY_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < MIN_PROVIDER_INACTIVITY_TIMEOUT_MS) {
    throw new Error(`inactivity timeout must be a finite number >= ${MIN_PROVIDER_INACTIVITY_TIMEOUT_MS.toString()}ms, got ${String(value)}`);
  }
  return Math.floor(value);
}

export function startInactivityWatchdog(timeoutMs: number): InactivityWatchdog {
  const ms = resolveInactivityTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let disposed = false;
  const waiters = new Set<(err: Error) => void>();

  const fire = (): void => {
    timer = null;
    if (disposed) return;
    timedOut = true;
    const err = new ProviderInactivityTimeout(ms);
    controller.abort(err);
    for (const reject of waiters) reject(err);
    waiters.clear();
  };
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fire, ms);
  };
  arm();

  const watchdog: InactivityWatchdog = {
    signal: controller.signal,
    get timedOut(): boolean {
      return timedOut;
    },
    touch(): void {
      if (!disposed && !timedOut) arm();
    },
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      waiters.clear();
    },
    async guard<T>(promise: Promise<T>): Promise<T> {
      if (timedOut) throw new ProviderInactivityTimeout(ms);
      let rejectWait: ((err: Error) => void) | null = null;
      const expired = new Promise<never>((_, reject) => {
        rejectWait = reject;
        waiters.add(reject);
      });
      expired.catch(() => undefined);
      try {
        return await Promise.race([promise, expired]);
      } finally {
        if (rejectWait !== null) waiters.delete(rejectWait);
      }
    },
    watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
      const reader = body.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(ctrl): Promise<void> {
          if (timedOut) {
            ctrl.error(new ProviderInactivityTimeout(ms));
            return;
          }
          let rejectWait: ((err: Error) => void) | null = null;
          const expired = new Promise<never>((_, reject) => {
            rejectWait = reject;
            waiters.add(reject);
          });
          try {
            const result = await Promise.race([reader.read(), expired]);
            if (result.done) {
              ctrl.close();
              return;
            }
            watchdog.touch();
            ctrl.enqueue(result.value);
          } catch (err) {
            void reader.cancel(err).catch(() => undefined);
            ctrl.error(err);
          } finally {
            if (rejectWait !== null) waiters.delete(rejectWait);
            // A rejection nobody awaits would be reported as unhandled.
            expired.catch(() => undefined);
          }
        },
        async cancel(reason): Promise<void> {
          await reader.cancel(reason).catch(() => undefined);
        },
      });
    },
  };
  return watchdog;
}
