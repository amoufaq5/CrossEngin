import type { DrTierSpec, FailoverRecord, DrillRecord } from "@crossengin/dr";
import { SystemClock, RandomIdGenerator, type Clock, type IdGenerator } from "./clock.js";
import {
  FailoverExecutor,
  type AbortFailoverInput,
  type CompleteFailoverInput,
  type FailFailoverInput,
  type FailoverTierVerdict,
  type PlanFailoverInput,
  type RevertFailoverInput,
  type StartFailoverInput,
} from "./failover.js";
import {
  DrillExecutor,
  type DrillTierVerdict,
  type PlanDrillInput,
  type RecordDrillResultInput,
} from "./drills.js";
import {
  assessDrReadiness,
  type DrReadinessInput,
  type DrReadinessReport,
} from "./readiness.js";

export interface DrRuntimeOptions {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

export class DrRuntime {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly failovers: FailoverExecutor;
  readonly drills: DrillExecutor;

  constructor(opts: DrRuntimeOptions = {}) {
    this.clock = opts.clock ?? new SystemClock();
    this.ids = opts.ids ?? new RandomIdGenerator();
    this.failovers = new FailoverExecutor({ clock: this.clock, ids: this.ids });
    this.drills = new DrillExecutor({ clock: this.clock, ids: this.ids });
  }

  planFailover(input: PlanFailoverInput): FailoverRecord {
    return this.failovers.planFailover(input);
  }
  startFailover(record: FailoverRecord, input?: StartFailoverInput): FailoverRecord {
    return this.failovers.startFailover(record, input);
  }
  completeFailover(record: FailoverRecord, input: CompleteFailoverInput): FailoverRecord {
    return this.failovers.completeFailover(record, input);
  }
  failFailover(record: FailoverRecord, input?: FailFailoverInput): FailoverRecord {
    return this.failovers.failFailover(record, input);
  }
  abortFailover(record: FailoverRecord, input?: AbortFailoverInput): FailoverRecord {
    return this.failovers.abortFailover(record, input);
  }
  revertFailover(record: FailoverRecord, input: RevertFailoverInput): FailoverRecord {
    return this.failovers.revertFailover(record, input);
  }
  failoverTierVerdict(record: FailoverRecord, spec: DrTierSpec): FailoverTierVerdict {
    return this.failovers.failoverTierVerdict(record, spec);
  }

  planDrill(input: PlanDrillInput): DrillRecord {
    return this.drills.planDrill(input);
  }
  recordDrillResult(record: DrillRecord, input: RecordDrillResultInput): DrillRecord {
    return this.drills.recordDrillResult(record, input);
  }
  drillTierVerdict(record: DrillRecord, spec: DrTierSpec): DrillTierVerdict {
    return this.drills.drillTierVerdict(record, spec);
  }

  assess(input: DrReadinessInput): DrReadinessReport {
    return assessDrReadiness({ ...input, now: input.now ?? this.clock.now() });
  }
}

export type IntervalHandle = unknown;

export interface IntervalScheduler {
  setInterval(handler: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface DrReadinessSchedulerOptions {
  readonly assess: () => DrReadinessReport | Promise<DrReadinessReport>;
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onReport?: (report: DrReadinessReport) => void;
  readonly onError?: (err: unknown) => void;
}

export class DrReadinessScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: DrReadinessSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    void this.assessOnce();
    this.handle = this.scheduler().setInterval(() => void this.assessOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  private async assessOnce(): Promise<void> {
    try {
      const report = await this.opts.assess();
      this.opts.onReport?.(report);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
