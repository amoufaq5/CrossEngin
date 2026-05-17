export interface CostCeiling {
  readonly maxUsdPerRequest?: number;
  readonly maxUsdPerWindow?: number;
  readonly windowSeconds?: number;
}

export interface CostUsageWindow {
  readonly tenantId: string;
  readonly windowStartUnixMs: number;
  readonly costUsd: number;
}

export interface CostTracker {
  getWindow(tenantId: string): Promise<CostUsageWindow | null>;
  recordUsage(input: { tenantId: string; costUsd: number }): Promise<void>;
  checkCeiling(input: {
    tenantId: string;
    estimatedCostUsd: number;
    ceiling: CostCeiling;
  }): Promise<CostCeilingCheck>;
}

export interface CostCeilingCheck {
  readonly allowed: boolean;
  readonly reason?: "per_request_exceeded" | "window_exceeded";
  readonly currentWindowUsd: number;
  readonly limitUsd: number;
}

interface MemoryEntry {
  windowStartUnixMs: number;
  costUsd: number;
}

export class InMemoryCostTracker implements CostTracker {
  private readonly windows = new Map<string, MemoryEntry>();
  private readonly windowSeconds: number;
  private readonly clock: () => number;

  constructor(opts: { windowSeconds?: number; clock?: () => number } = {}) {
    this.windowSeconds = opts.windowSeconds ?? 86_400;
    this.clock = opts.clock ?? (() => Date.now());
  }

  async getWindow(tenantId: string): Promise<CostUsageWindow | null> {
    const now = this.clock();
    const entry = this.windows.get(tenantId);
    if (entry === undefined) return null;
    if (this.isExpired(entry.windowStartUnixMs, now)) return null;
    return {
      tenantId,
      windowStartUnixMs: entry.windowStartUnixMs,
      costUsd: entry.costUsd,
    };
  }

  async recordUsage(input: { tenantId: string; costUsd: number }): Promise<void> {
    const now = this.clock();
    const existing = this.windows.get(input.tenantId);
    if (existing === undefined || this.isExpired(existing.windowStartUnixMs, now)) {
      this.windows.set(input.tenantId, {
        windowStartUnixMs: now,
        costUsd: input.costUsd,
      });
      return;
    }
    existing.costUsd += input.costUsd;
  }

  async checkCeiling(input: {
    tenantId: string;
    estimatedCostUsd: number;
    ceiling: CostCeiling;
  }): Promise<CostCeilingCheck> {
    const { ceiling, estimatedCostUsd, tenantId } = input;
    if (
      ceiling.maxUsdPerRequest !== undefined &&
      estimatedCostUsd > ceiling.maxUsdPerRequest
    ) {
      return {
        allowed: false,
        reason: "per_request_exceeded",
        currentWindowUsd: 0,
        limitUsd: ceiling.maxUsdPerRequest,
      };
    }
    if (ceiling.maxUsdPerWindow === undefined) {
      return { allowed: true, currentWindowUsd: 0, limitUsd: Number.POSITIVE_INFINITY };
    }
    const window = await this.getWindow(tenantId);
    const current = window?.costUsd ?? 0;
    if (current + estimatedCostUsd > ceiling.maxUsdPerWindow) {
      return {
        allowed: false,
        reason: "window_exceeded",
        currentWindowUsd: current,
        limitUsd: ceiling.maxUsdPerWindow,
      };
    }
    return { allowed: true, currentWindowUsd: current, limitUsd: ceiling.maxUsdPerWindow };
  }

  private isExpired(startMs: number, nowMs: number): boolean {
    return nowMs - startMs >= this.windowSeconds * 1_000;
  }
}

export class CostCeilingExceededError extends Error {
  readonly kind = "cost_ceiling_exceeded" as const;
  readonly check: CostCeilingCheck;

  constructor(check: CostCeilingCheck) {
    super(`cost ceiling exceeded: ${check.reason ?? "unknown"}`);
    this.name = "CostCeilingExceededError";
    this.check = check;
  }

  isRetryable(): boolean {
    return false;
  }
}
