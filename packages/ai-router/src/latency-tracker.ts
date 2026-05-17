export interface LatencyTracker {
  record(input: { providerId: string; latencyMs: number; success: boolean }): void;
  stats(providerId: string): LatencyStats;
}

export interface LatencyStats {
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface InMemoryLatencyOptions {
  readonly windowSize?: number;
}

interface Entry {
  readonly latencyMs: number;
  readonly success: boolean;
}

export class InMemoryLatencyTracker implements LatencyTracker {
  private readonly windows = new Map<string, Entry[]>();
  private readonly windowSize: number;

  constructor(opts: InMemoryLatencyOptions = {}) {
    this.windowSize = opts.windowSize ?? 100;
  }

  record(input: { providerId: string; latencyMs: number; success: boolean }): void {
    const entries = this.windows.get(input.providerId) ?? [];
    entries.push({ latencyMs: input.latencyMs, success: input.success });
    if (entries.length > this.windowSize) entries.shift();
    this.windows.set(input.providerId, entries);
  }

  stats(providerId: string): LatencyStats {
    const entries = this.windows.get(providerId) ?? [];
    if (entries.length === 0) {
      return { samples: 0, successes: 0, failures: 0, p50Ms: 0, p95Ms: 0 };
    }
    const sorted = entries
      .slice()
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .map((e) => e.latencyMs);
    return {
      samples: entries.length,
      successes: entries.filter((e) => e.success).length,
      failures: entries.filter((e) => !e.success).length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    };
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}
