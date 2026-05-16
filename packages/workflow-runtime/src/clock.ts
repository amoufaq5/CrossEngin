import { randomBytes } from "node:crypto";

export interface Clock {
  now(): Date;
  nowSeconds(): number;
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
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
  nowSeconds(): number {
    return Math.floor(this.current.getTime() / 1000);
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

export type WorkflowIdKind = "wfi" | "wfa" | "wfe" | "wfs" | "wft" | "wfd";

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

export interface IdGenerator {
  generate(kind: WorkflowIdKind): string;
}

export class RandomIdGenerator implements IdGenerator {
  private readonly length: number;
  constructor(length = 24) {
    if (length < 8 || length > 40) {
      throw new Error(`id length must be 8..40, got ${length}`);
    }
    this.length = length;
  }
  generate(kind: WorkflowIdKind): string {
    return `${kind}_${encodeBase32Lower(new Uint8Array(randomBytes(20)), this.length)}`;
  }
}

export class CountingIdGenerator implements IdGenerator {
  private counters: Map<WorkflowIdKind, number> = new Map();
  private readonly padTo: number;
  constructor(padTo = 8) {
    if (padTo < 8 || padTo > 40) {
      throw new Error(`padTo must be 8..40, got ${padTo}`);
    }
    this.padTo = padTo;
  }
  generate(kind: WorkflowIdKind): string {
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const padded = next.toString().padStart(this.padTo, "0");
    return `${kind}_${padded.replace(/[^a-z0-9]/g, "0")}`;
  }
  reset(): void {
    this.counters.clear();
  }
}
