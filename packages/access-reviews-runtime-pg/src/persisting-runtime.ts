import type {
  AccessReviewCampaign,
  AccessReviewDecision,
  AccessReviewItem,
  PrincipalUnderReview,
} from "@crossengin/access-reviews";
import {
  AccessReviewRuntime,
  type AccessReviewRuntimeOptions,
  type GenerateItemsOptions,
  type LiveGrant,
} from "@crossengin/access-reviews-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

import { PostgresAccessReviewCampaignStore } from "./campaign-store.js";
import { PostgresAccessReviewDecisionStore } from "./decision-store.js";
import { CampaignUuidResolver, ItemUuidResolver } from "./id-mapping.js";
import { PostgresAccessReviewItemStore } from "./item-store.js";

export interface PersistentAccessReviewRuntimeParts {
  readonly runtime: AccessReviewRuntime;
  readonly campaignStore: PostgresAccessReviewCampaignStore;
  readonly itemStore: PostgresAccessReviewItemStore;
  readonly decisionStore: PostgresAccessReviewDecisionStore;
  readonly campaignResolver: CampaignUuidResolver;
  readonly itemResolver: ItemUuidResolver;
}

export class PersistentAccessReviewRuntime {
  readonly runtime: AccessReviewRuntime;
  readonly campaignStore: PostgresAccessReviewCampaignStore;
  readonly itemStore: PostgresAccessReviewItemStore;
  readonly decisionStore: PostgresAccessReviewDecisionStore;
  readonly campaignResolver: CampaignUuidResolver;
  readonly itemResolver: ItemUuidResolver;

  constructor(parts: PersistentAccessReviewRuntimeParts) {
    this.runtime = parts.runtime;
    this.campaignStore = parts.campaignStore;
    this.itemStore = parts.itemStore;
    this.decisionStore = parts.decisionStore;
    this.campaignResolver = parts.campaignResolver;
    this.itemResolver = parts.itemResolver;
  }

  async startCampaign(
    campaign: AccessReviewCampaign,
    now?: Date,
  ): Promise<AccessReviewCampaign> {
    const started = this.runtime.startCampaign(campaign, now ?? this.runtime.clock.now());
    await this.campaignStore.upsert(started);
    return started;
  }

  async persistCampaign(campaign: AccessReviewCampaign): Promise<AccessReviewCampaign> {
    await this.campaignStore.upsert(campaign);
    return campaign;
  }

  async generateItems(
    campaign: AccessReviewCampaign,
    grants: readonly LiveGrant[],
    principals: readonly PrincipalUnderReview[],
    opts?: Pick<GenerateItemsOptions, "assignReviewers">,
  ): Promise<readonly AccessReviewItem[]> {
    await this.campaignStore.upsert(campaign);
    const items = this.runtime.generateItems(campaign, grants, principals, opts);
    for (const item of items) {
      await this.itemStore.upsert(item);
    }
    return items;
  }

  async planAutoRevocations(
    items: readonly AccessReviewItem[],
    campaign: AccessReviewCampaign,
    now?: Date,
  ): Promise<readonly AccessReviewDecision[]> {
    const decisions = this.runtime.planAutoRevocations(
      items,
      campaign,
      now ?? this.runtime.clock.now(),
    );
    for (const decision of decisions) {
      await this.decisionStore.record(decision);
    }
    return decisions;
  }
}

export interface BuildPersistentAccessReviewRuntimeOptions
  extends AccessReviewRuntimeOptions {
  readonly runtime?: AccessReviewRuntime;
}

export function buildPersistentAccessReviewRuntime(
  conn: PgConnection,
  opts: BuildPersistentAccessReviewRuntimeOptions,
): PersistentAccessReviewRuntime {
  const runtime = opts.runtime ?? new AccessReviewRuntime(opts);
  const campaignResolver = new CampaignUuidResolver();
  const itemResolver = new ItemUuidResolver();
  const campaignStore = new PostgresAccessReviewCampaignStore(conn, campaignResolver);
  const itemStore = new PostgresAccessReviewItemStore(conn, campaignResolver, itemResolver);
  const decisionStore = new PostgresAccessReviewDecisionStore(
    conn,
    campaignResolver,
    itemResolver,
  );
  return new PersistentAccessReviewRuntime({
    runtime,
    campaignStore,
    itemStore,
    decisionStore,
    campaignResolver,
    itemResolver,
  });
}
