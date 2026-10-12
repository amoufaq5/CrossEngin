import {
  isItemOverdue,
  type AccessReviewCampaign,
  type AccessReviewDecision,
  type AccessReviewItem,
  type PrincipalUnderReview,
} from "@crossengin/access-reviews";
import { SystemClock, RandomIdGenerator, type Clock, type IdGenerator } from "./clock.js";
import {
  completeCampaign,
  dueCampaigns,
  isCampaignCompletable,
  overdueCampaigns,
  pastGraceCampaigns,
  planNextOccurrence,
  startCampaign,
} from "./scheduling.js";
import {
  compileCampaignEvidence,
  sealCompiledEvidence,
  type CompileCampaignEvidenceInput,
  type CompiledEvidence,
} from "./evidence-compilation.js";
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

  isCampaignCompletable(
    campaign: AccessReviewCampaign,
    items: readonly AccessReviewItem[],
  ): boolean {
    return isCampaignCompletable(campaign, items);
  }

  completeCampaign(
    campaign: AccessReviewCampaign,
    items: readonly AccessReviewItem[],
    now: Date = this.clock.now(),
  ): AccessReviewCampaign {
    return completeCampaign(campaign, items, now);
  }

  /**
   * Compiles and seals a pack in one call, which is the only order the two may be used in: the
   * digest commits to the compiled figures, so a seal over anything but the record just compiled
   * would be a digest over figures nobody holds.
   */
  compileAndSealEvidence(
    input: Omit<CompileCampaignEvidenceInput, "now"> & {
      readonly now?: Date;
      readonly storageUri?: string;
    },
  ): CompiledEvidence {
    const now = input.now ?? this.clock.now();
    const compiled = compileCampaignEvidence({ ...input, now });
    return sealCompiledEvidence({
      compiled,
      now,
      ...(input.storageUri !== undefined ? { storageUri: input.storageUri } : {}),
    });
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

/*
 * `CampaignScheduler` lived here and is gone, as a duplicate rather than as a gap.
 *
 * `apps/operate-server/src/access-reviews-lifecycle.ts` holds `AccessReviewCampaignScheduler`,
 * which is wired under `--access-reviews-config` and is the scheduler this subsystem actually runs.
 * The two were not two implementations of one thing: this one's `AccessReviewSource` had
 * `activeCampaigns()` and `itemsForCampaign()` and **no write method of any kind**, so every tick
 * called `startCampaign` and `planAutoRevocations`, handed the results to an `onTick` sink, and
 * discarded them. Nothing was persisted, so the next tick re-read the same `scheduled` campaign
 * from the source and started it again — forever — minting fresh `ard_` decision ids each pass for
 * revocations that never landed. It could not be fixed by wiring it; its contract had no seam to
 * write through. The app's version drives `PersistentAccessReviewRuntime`, which persists the
 * start, the generated items and each decision, closes a completed campaign and seals its evidence
 * pack.
 *
 * `AccessReviewRuntime` below is the shared part and is reached through
 * `buildPersistentAccessReviewRuntime`, so nothing here was orphaned by the removal.
 */
