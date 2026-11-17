import type { Entity, SequenceDefault } from "@crossengin/types/meta-schema";

import type { EntityRecord } from "./store.js";

export const DEFAULT_SEQUENCE_FORMAT = "{SEQ:6}";

/**
 * Allocates the next monotonic value for a named, period-scoped counter. One
 * call yields one value; concurrent callers never receive the same value.
 */
export interface SequenceAllocator {
  allocate(input: SequenceAllocationInput): Promise<number>;
}

export interface SequenceAllocationInput {
  readonly tenantId: string;
  readonly sequenceName: string;
  /** Bucket the counter resets within (e.g. the year for a yearly reset). */
  readonly periodKey: string;
  /** First value handed out for a fresh (tenant, name, period). Defaults to 1. */
  readonly start?: number;
}

/** Process-local allocator; the Postgres allocator is the durable sibling. */
export class InMemorySequenceAllocator implements SequenceAllocator {
  private readonly counters = new Map<string, number>();

  allocate(input: SequenceAllocationInput): Promise<number> {
    const key = `${input.tenantId}\u0000${input.sequenceName}\u0000${input.periodKey}`;
    const start = input.start ?? 1;
    const current = this.counters.get(key);
    const next = current === undefined ? start : current + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }

  /** Test/admin helper: the last value handed out, or null if untouched. */
  peek(tenantId: string, sequenceName: string, periodKey: string): number | null {
    return this.counters.get(`${tenantId}\u0000${sequenceName}\u0000${periodKey}`) ?? null;
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Derives the reset bucket key for a sequence at a point in time (UTC). `never`
 * shares one bucket forever; `yearly`/`monthly`/`daily` start fresh each period.
 */
export function derivePeriodKey(
  resetPeriod: SequenceDefault["resetPeriod"],
  now: Date,
): string {
  const y = now.getUTCFullYear();
  const m = pad2(now.getUTCMonth() + 1);
  const d = pad2(now.getUTCDate());
  switch (resetPeriod) {
    case "yearly":
      return String(y);
    case "monthly":
      return `${y}-${m}`;
    case "daily":
      return `${y}-${m}-${d}`;
    case "never":
    case undefined:
    default:
      return "all";
  }
}

/**
 * Renders a sequence value into a document number. Supported tokens:
 * `{SEQ}` / `{SEQ:N}` (zero-padded), `{YYYY}`, `{YY}`, `{MM}`, `{DD}`.
 */
export function formatSequenceNumber(
  format: string,
  value: number,
  now: Date,
): string {
  const y = now.getUTCFullYear();
  return format.replace(/\{(SEQ(?::(\d+))?|YYYY|YY|MM|DD)\}/g, (_match, token: string, width?: string) => {
    if (token.startsWith("SEQ")) {
      const w = width === undefined ? 0 : Number.parseInt(width, 10);
      const s = String(value);
      return w > 0 ? s.padStart(w, "0") : s;
    }
    if (token === "YYYY") return String(y);
    if (token === "YY") return pad2(y % 100);
    if (token === "MM") return pad2(now.getUTCMonth() + 1);
    if (token === "DD") return pad2(now.getUTCDate());
    return _match;
  });
}

export interface SequenceFieldPlan {
  readonly field: string;
  readonly spec: SequenceDefault;
}

/** Extracts the sequence-defaulted fields of an entity (in declaration order). */
export function sequenceFieldPlans(entity: Entity): readonly SequenceFieldPlan[] {
  const out: SequenceFieldPlan[] = [];
  for (const field of entity.fields) {
    if (field.default !== undefined && field.default.kind === "sequence") {
      out.push({ field: field.name, spec: field.default });
    }
  }
  return out;
}

export interface ApplySequenceDefaultsInput {
  readonly record: EntityRecord;
  readonly plans: readonly SequenceFieldPlan[];
  readonly allocator: SequenceAllocator;
  readonly tenantId: string;
  readonly now: Date;
  /**
   * Optional override resolver — lets admin settings replace a field's manifest
   * sequence spec (format/start/resetPeriod) at runtime. Defaults to identity.
   */
  readonly resolveSpec?: (spec: SequenceDefault) => SequenceDefault;
}

/** Whether a sequence-defaulted field is unset and so would be allocated a number. */
export function isSequenceFieldBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Returns a copy of `record` with every sequence-defaulted field that the caller
 * left blank filled by allocating + formatting the next value. A caller-supplied
 * value is always preserved (idempotent imports, migrations).
 */
export async function applySequenceDefaults(
  input: ApplySequenceDefaultsInput,
): Promise<EntityRecord> {
  if (input.plans.length === 0) return input.record;
  const resolve = input.resolveSpec ?? ((s) => s);
  const out: EntityRecord = { ...input.record };
  for (const plan of input.plans) {
    if (!isSequenceFieldBlank(out[plan.field])) continue;
    const spec = resolve(plan.spec);
    const periodKey = derivePeriodKey(spec.resetPeriod, input.now);
    const value = await input.allocator.allocate({
      tenantId: input.tenantId,
      sequenceName: spec.sequence,
      periodKey,
      ...(spec.start !== undefined ? { start: spec.start } : {}),
    });
    out[plan.field] = formatSequenceNumber(spec.format ?? DEFAULT_SEQUENCE_FORMAT, value, input.now);
  }
  return out;
}
