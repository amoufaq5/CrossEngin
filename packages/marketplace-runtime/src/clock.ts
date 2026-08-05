/**
 * Deterministic time + id sources for the install engine, so a test can pin
 * both and assert exact record shapes. Mirrors the workflow-runtime clock.
 */

export interface Clock {
  /** Current wall-clock time as an ISO 8601 string. */
  now(): string;
}

/** A clock frozen at a fixed instant (advanceable), for reproducible tests. */
export class FixedClock implements Clock {
  private current: number;

  constructor(iso = "2026-01-01T00:00:00.000Z") {
    this.current = Date.parse(iso);
  }

  now(): string {
    return new Date(this.current).toISOString();
  }

  /** Moves the clock forward by `ms` and returns the new instant. */
  advance(ms: number): string {
    this.current += ms;
    return this.now();
  }
}

/** The real wall clock. */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export interface IdGenerator {
  /** The next opaque installation id. */
  next(): string;
}

/** Installation ids from `crypto.randomUUID()` (`inst_<uuid>`) — the engine default. */
export class RandomIdGenerator implements IdGenerator {
  constructor(private readonly prefix = "inst") {}

  next(): string {
    return `${this.prefix}_${globalThis.crypto.randomUUID()}`;
  }
}

/** A monotonic id generator (`inst_00000001`, …) for reproducible tests. */
export class CountingIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "inst") {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}_${this.counter.toString().padStart(8, "0")}`;
  }
}

/** Formats an installation id from a numeric sequence, the stable `inst_` prefix. */
export function formatInstallationId(seq: number): string {
  return `inst_${seq.toString().padStart(8, "0")}`;
}
