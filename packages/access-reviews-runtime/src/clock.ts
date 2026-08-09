export interface Clock {
  now(): Date;
  nowMs(): number;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowMs(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class FixedClock implements Clock {
  private current: Date;
  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  nowMs(): number {
    return this.current.getTime();
  }
  nowIso(): string {
    return this.current.toISOString();
  }
  set(next: Date): void {
    this.current = new Date(next.getTime());
  }
  advance(milliseconds: number): void {
    if (milliseconds < 0) throw new Error("FixedClock cannot move backward");
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export interface IdGenerator {
  next(prefix: string): string;
}

export class CountingIdGenerator implements IdGenerator {
  private counter: number;
  constructor(start = 0) {
    this.counter = start;
  }
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString().padStart(8, "0")}`;
  }
}

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export class RandomIdGenerator implements IdGenerator {
  constructor(private readonly length = 16) {
    if (length < 8 || length > 32) {
      throw new Error("RandomIdGenerator length must be within the id suffix range (8-32)");
    }
  }
  next(prefix: string): string {
    let suffix = "";
    for (let i = 0; i < this.length; i += 1) {
      suffix += RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)];
    }
    return `${prefix}_${suffix}`;
  }
}

const DURATION_REGEX = /^(\d+)([smhdw])$/;

const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
});

export function parseDurationMs(window: string): number {
  const match = window.match(DURATION_REGEX);
  if (match === null) {
    throw new Error(
      `invalid duration '${window}' (expected like '5m', '1h', '24h', '30d')`,
    );
  }
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as string;
  const unitMs = UNIT_MS[unit];
  if (unitMs === undefined || amount <= 0) {
    throw new Error(`invalid duration '${window}'`);
  }
  return amount * unitMs;
}
