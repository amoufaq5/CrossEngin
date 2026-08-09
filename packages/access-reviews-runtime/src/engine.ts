import {
  isItemOverdue,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
  type PrincipalUnderReview,
} from "@crossengin/access-reviews";
import { SystemClock, RandomIdGenerator, type Clock, type IdGenerator } from "./clock.js";
import {
  dueCampaigns,
  overdueCampaigns,
  pastGraceCampaigns,
  planNextOccurrence,
  startCampaign,
} from "./scheduling.js";
import {
  generateItems,
  type GenerateItemsOptions,
  type LiveGrant,
} from "./item-generation.js";
import { planAutoRevocations } from "./enforcement.js";

export interface AccessReviewRuntimeOptions {
  readonly systemActorUserId: string;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly requireGracePeriod?: boolean;
}

export class AccessReviewRuntime {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  private readonly systemActorUserId: string;
  private readonly requireGracePeriod: boolean;

  constructor(options: AccessReviewRuntimeOptions) {
    this.systemActorUserId = options.systemActorUserId;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new RandomIdGenerator();
    this.requireGracePeriod = options.requireGracePeriod ?? false;
  }

  dueCampaigns(
    campaigns: readonly AccessReviewCampaign[],
    now: Date = this.clock.now(),
  ): readonly AccessReviewCampaign[] {
    return dueCampaigns(campaigns, now);
  }

  overdueCampaigns(
    campaigns: readonly AccessReviewCampaign[],
    now: Date = this.clock.now(),
  ): readonly AccessReviewCampaign[] {
    return overdueCampaigns(campaigns, now);
  }

  pastGraceCampaigns(
    campaigns: readonly AccessReviewCampaign[],
    now: Date = this.clock.now(),
  ): readonly AccessReviewCampaign[] {
    return pastGraceCampaigns(campaigns, now);
  }

  startCampaign(
    campaign: AccessReviewCampaign,
    now: Date = this.clock.now(),
  ): AccessReviewCampaign {
    return startCampaign(campaign, now);
  }

  planNextOccurrence(
    campaign: AccessReviewCampaign,
    now: Date = this.clock.now(),
  ): AccessReviewCampaign | null {
    return planNextOccurrence(campaign, now, this.ids);
  }

  generateItems(
    campaign: AccessReviewCampaign,
    grants: readonly LiveGrant[],
    principals: readonly PrincipalUnderReview[],
    opts?: Pick<GenerateItemsOptions, "assignReviewers">,
  ): readonly AccessReviewItem[] {
    return generateItems(campaign, grants, principals, {
      ids: this.ids,
      now: this.clock.now(),
      assignReviewers: opts?.assignReviewers,
    });
  }

  overdueItems(
    items: readonly AccessReviewItem[],
    now: Date = this.clock.now(),
  ): readonly AccessReviewItem[] {
    return items.filter((item) => isItemOverdue(item, now));
  }

  planAutoRevocations(
    items: readonly AccessReviewItem[],
    campaign: AccessReviewCampaign,
    now: Date = this.clock.now(),
  ): readonly AccessReviewDecision[] {
    return planAutoRevocations(items, campaign, {
      ids: this.ids,
      now,
      systemActorUserId: this.systemActorUserId,
      requireGracePeriod: this.requireGracePeriod,
    });
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

export interface AccessReviewSource {
  activeCampaigns():
    | readonly AccessReviewCampaign[]
    | Promise<readonly AccessReviewCampaign[]>;
  itemsForCampaign(
    campaign: AccessReviewCampaign,
  ): readonly AccessReviewItem[] | Promise<readonly AccessReviewItem[]>;
}

export interface TickReport {
  readonly at: string;
  readonly startedCampaigns: readonly AccessReviewCampaign[];
  readonly overdueItems: readonly AccessReviewItem[];
  readonly autoRevocations: readonly AccessReviewDecision[];
}

export interface CampaignSchedulerOptions {
  readonly runtime: AccessReviewRuntime;
  readonly source: AccessReviewSource;
  readonly intervalMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onTick?: (report: TickReport) => void;
  readonly onError?: (err: unknown) => void;
}

export class CampaignScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: CampaignSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    void this.tickOnce();
    this.handle = this.scheduler().setInterval(
      () => void this.tickOnce(),
      this.opts.intervalMs,
    );
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async tickOnce(): Promise<TickReport | null> {
    try {
      const report = await this.runTick();
      this.opts.onTick?.(report);
      return report;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  private async runTick(): Promise<TickReport> {
    const { runtime, source } = this.opts;
    const now = runtime.clock.now();
    const campaigns = await source.activeCampaigns();
    const started = runtime.dueCampaigns(campaigns, now).map((c) =>
      runtime.startCampaign(c, now),
    );
    const startedIds = new Set(started.map((c) => c.id));
    const inProgress: AccessReviewCampaign[] = [
      ...campaigns.filter(
        (c) => c.status === "in_progress" && !startedIds.has(c.id),
      ),
      ...started,
    ];

    const overdueItems: AccessReviewItem[] = [];
    const autoRevocations: AccessReviewDecision[] = [];
    for (const campaign of inProgress) {
      const items = await source.itemsForCampaign(campaign);
      overdueItems.push(...runtime.overdueItems(items, now));
      autoRevocations.push(...runtime.planAutoRevocations(items, campaign, now));
    }

    return {
      at: now.toISOString(),
      startedCampaigns: started,
      overdueItems,
      autoRevocations,
    };
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
