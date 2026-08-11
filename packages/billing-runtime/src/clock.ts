import { randomUUID } from "node:crypto";

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now(): Date {
    return this.current;
  }
  nowIso(): string {
    return this.current.toISOString();
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(when: Date): void {
    this.current = when;
  }
}

/** Mints UUIDs for usage records / invoice line items / invoices. */
export interface UuidGenerator {
  next(): string;
}

export class RandomUuidGenerator implements UuidGenerator {
  next(): string {
    return randomUUID();
  }
}

/** Deterministic valid v4-shaped UUIDs for tests: `00000000-0000-4000-8000-<counter>`. */
export class CountingUuidGenerator implements UuidGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    const tail = this.counter.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${tail}`;
  }
}
