import { z } from "zod";

export const REQUEST_OUTCOMES = ["ok", "error"] as const;
export type RequestOutcomeKind = (typeof REQUEST_OUTCOMES)[number];

export const RequestOutcomeSchema = z
  .object({
    surface: z.string().min(1),
    outcome: z.enum(REQUEST_OUTCOMES),
    at: z.string().datetime({ offset: true }),
    statusCode: z.number().int().min(100).max(599).optional(),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.statusCode !== undefined) {
      const isError = v.statusCode >= 500;
      if (isError && v.outcome !== "error") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcome"],
          message: `statusCode ${v.statusCode} is a 5xx but outcome is '${v.outcome}'`,
        });
      }
    }
  });
export type RequestOutcome = z.infer<typeof RequestOutcomeSchema>;

export interface WindowCounts {
  readonly total: number;
  readonly failed: number;
}

export function failureRate(counts: WindowCounts): number {
  if (counts.total === 0) return 0;
  return counts.failed / counts.total;
}

interface Sample {
  readonly ms: number;
  readonly failed: boolean;
  readonly latencyMs?: number;
}

export interface RollingWindowOptions {
  readonly retentionMs?: number;
  readonly maxSamplesPerSurface?: number;
}

export interface LatencyStats {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly count: number;
}

export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (p <= 0) return sortedAsc[0] ?? null;
  if (p >= 100) return sortedAsc[sortedAsc.length - 1] ?? null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? null;
}

export class RollingWindow {
  private readonly samples: Map<string, Sample[]> = new Map();
  private readonly retentionMs: number;
  private readonly maxSamples: number;

  constructor(options: RollingWindowOptions = {}) {
    this.retentionMs = options.retentionMs ?? 24 * 3_600_000;
    this.maxSamples = options.maxSamplesPerSurface ?? 100_000;
    if (this.retentionMs <= 0) throw new Error("retentionMs must be positive");
    if (this.maxSamples <= 0) throw new Error("maxSamplesPerSurface must be positive");
  }

  record(outcome: RequestOutcome): void {
    const ms = Date.parse(outcome.at);
    if (Number.isNaN(ms)) throw new Error(`unparseable timestamp '${outcome.at}'`);
    const list = this.samples.get(outcome.surface) ?? [];
    list.push({
      ms,
      failed: outcome.outcome === "error",
      ...(outcome.latencyMs === undefined ? {} : { latencyMs: outcome.latencyMs }),
    });
    if (list.length > this.maxSamples) {
      list.splice(0, list.length - this.maxSamples);
    }
    this.samples.set(outcome.surface, list);
  }

  prune(now: number): void {
    const cutoff = now - this.retentionMs;
    for (const [surface, list] of this.samples) {
      const kept = list.filter((s) => s.ms >= cutoff);
      if (kept.length === 0) {
        this.samples.delete(surface);
      } else {
        this.samples.set(surface, kept);
      }
    }
  }

  count(surface: string, windowMs: number, now: number): WindowCounts {
    if (windowMs <= 0) throw new Error("windowMs must be positive");
    const list = this.samples.get(surface);
    if (list === undefined) return { total: 0, failed: 0 };
    const cutoff = now - windowMs;
    let total = 0;
    let failed = 0;
    for (const sample of list) {
      if (sample.ms < cutoff || sample.ms > now) continue;
      total += 1;
      if (sample.failed) failed += 1;
    }
    return { total, failed };
  }

  latencyStats(surface: string, windowMs: number, now: number): LatencyStats {
    if (windowMs <= 0) throw new Error("windowMs must be positive");
    const list = this.samples.get(surface);
    if (list === undefined) return { p50: null, p95: null, p99: null, count: 0 };
    const cutoff = now - windowMs;
    const latencies: number[] = [];
    for (const sample of list) {
      if (sample.ms < cutoff || sample.ms > now) continue;
      if (sample.latencyMs === undefined) continue;
      latencies.push(sample.latencyMs);
    }
    latencies.sort((a, b) => a - b);
    return {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      count: latencies.length,
    };
  }

  surfaces(): readonly string[] {
    return [...this.samples.keys()];
  }

  clear(): void {
    this.samples.clear();
  }
}
