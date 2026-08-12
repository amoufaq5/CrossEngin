import { randomBytes } from "node:crypto";

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

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeBase32Lower(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 0x1f];
    }
  }
  while (out.length < length) {
    out += CROCKFORD[(buffer << (5 - bits)) & 0x1f];
    bits = 0;
  }
  return out.slice(0, length);
}

export class RandomIdGenerator implements IdGenerator {
  private readonly length: number;
  constructor(length = 24) {
    if (length < 8 || length > 40) {
      throw new Error(`id length must be 8..40, got ${length}`);
    }
    this.length = length;
  }
  next(prefix: string): string {
    if (prefix.length === 0) throw new Error("id prefix must be non-empty");
    return `${prefix}_${encodeBase32Lower(new Uint8Array(randomBytes(20)), this.length)}`;
  }
}

export class CountingIdGenerator implements IdGenerator {
  private counters: Map<string, number> = new Map();
  private readonly padTo: number;
  constructor(padTo = 8) {
    if (padTo < 4 || padTo > 40) {
      throw new Error(`padTo must be 4..40, got ${padTo}`);
    }
    this.padTo = padTo;
  }
  next(prefix: string): string {
    if (prefix.length === 0) throw new Error("id prefix must be non-empty");
    const nextValue = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, nextValue);
    return `${prefix}_${nextValue.toString().padStart(this.padTo, "0")}`;
  }
  reset(): void {
    this.counters.clear();
  }
}
