import { readFile } from "node:fs/promises";

import { z } from "zod";
import {
  AccessReviewCampaignSchema,
  PrincipalUnderReviewSchema,
} from "@crossengin/access-reviews";
import { LiveGrantSchema, isDueToStart } from "@crossengin/access-reviews-runtime";
import {
  buildPersistentAccessReviewRuntime,
  type PersistentAccessReviewRuntime,
} from "@crossengin/access-reviews-runtime-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import { StaticLiveGrantSource, type LiveGrantSource } from "./live-grants.js";

export const AccessReviewsConfigSchema = z
  .object({
    systemActorUserId: z.string().uuid(),
    intervalMs: z.number().int().positive().default(3_600_000),
    assignReviewers: z.boolean().default(true),
    campaigns: z.array(AccessReviewCampaignSchema).min(1),
    grants: z.array(LiveGrantSchema).default([]),
    principals: z.array(PrincipalUnderReviewSchema).default([]),
    /**
     * Close a campaign once every item is resolved, and seal its evidence pack.
     *
     * Default **on**, because off is the status quo and the status quo is broken: nothing in the
     * workspace moved a campaign to `completed`, so a review started once, auto-revoked, and then
     * sat `in_progress` for ever — which left `planNextOccurrence` unable to plan a recurrence and
     * `meta.access_review_evidence` with no writer, so `access.periodic_review` scored
     * `not_assessed` in every certification report ever produced. The close refuses while any item
     * is unresolved, so turning it on cannot cut a review short.
     */
    closeCompletedCampaigns: z.boolean().default(true),
    /**
     * Where a sealed pack's bundle bytes live. Omitted, the pack's `storageUri` names the
     * re-derivation from `access_review_items` + `access_review_decisions` instead of a blob that
     * does not exist — see `evidenceBundleUri`.
     */
    evidenceStorageUriPrefix: z.string().min(1).max(400).optional(),
  })
  .strict();
export type AccessReviewsConfig = z.infer<typeof AccessReviewsConfigSchema>;

export function parseAccessReviewsConfig(json: unknown): AccessReviewsConfig {
  return AccessReviewsConfigSchema.parse(json);
}

export async function loadAccessReviewsConfig(path: string): Promise<AccessReviewsConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--access-reviews-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--access-reviews-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseAccessReviewsConfig(parsed);
}

export interface AccessReviewTickReport {
  readonly at: string;
  readonly startedCampaigns: readonly string[];
  readonly generatedItems: number;
  readonly autoRevocations: readonly string[];
  /** Campaigns moved to `completed` on this tick. */
  readonly closedCampaigns: readonly string[];
  /** Evidence packs sealed on this tick, by `arv_` id. */
  readonly sealedEvidence: readonly string[];
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

export interface AccessReviewsLifecycleOptions {
  readonly scheduler?: IntervalScheduler;
  readonly clock?: () => Date;
  readonly onTick?: (report: AccessReviewTickReport) => void;
  readonly onError?: (err: unknown) => void;
  readonly runtime?: PersistentAccessReviewRuntime;
  /** Where a started campaign's grants come from. Defaults to the config's static grants/principals. */
  readonly grantSource?: LiveGrantSource;
  /**
   * A close that happened and whose pack could not be sealed. Reported rather than thrown, so one
   * campaign's unsealable pack does not stop the other campaigns' tick — and the next tick retries
   * it through `ensureSealedEvidenceForCampaign`.
   */
  readonly onEvidenceError?: (err: unknown) => void;
}

/**
 * Runs the config's attestation campaigns on a schedule against the persistent
 * runtime: each tick reads each campaign's current persisted state, starts the
 * ones now due (materializing + persisting their items from the config's live
 * grants), and plans + persists auto-revocations for in-progress campaigns whose
 * items are un-attested past deadline. Mirrors `PruneScheduler`: an `unref`'d
 * timer, `onTick`/`onError` sinks.
 */
export class AccessReviewCampaignScheduler {
  private handle: IntervalHandle | null = null;
  private readonly grantSource: LiveGrantSource;

  constructor(
    private readonly runtime: PersistentAccessReviewRuntime,
    private readonly config: AccessReviewsConfig,
    private readonly opts: AccessReviewsLifecycleOptions = {},
  ) {
    this.grantSource =
      opts.grantSource ??
      new StaticLiveGrantSource({ grants: config.grants, principals: config.principals });
  }

  start(): void {
    if (this.handle !== null) return;
    void this.tickOnce();
    this.handle = this.scheduler().setInterval(() => void this.tickOnce(), this.config.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async tickOnce(): Promise<AccessReviewTickReport | null> {
    try {
      const report = await this.runTick();
      this.opts.onTick?.(report);
      return report;
    } catch (err) {
      this.opts.onError?.(err);
      return null;
    }
  }

  private async runTick(): Promise<AccessReviewTickReport> {
    const now = (this.opts.clock ?? (() => new Date()))();
    const startedCampaigns: string[] = [];
    const autoRevocations: string[] = [];
    const closedCampaigns: string[] = [];
    const sealedEvidence: string[] = [];
    let generatedItems = 0;

    for (const configCampaign of this.config.campaigns) {
      const current =
        (await this.runtime.campaignStore.getByCampaignId(
          configCampaign.tenantId,
          configCampaign.id,
        )) ?? configCampaign;

      if (isDueToStart(current, now)) {
        const started = await this.runtime.startCampaign(current, now);
        const snapshot = await this.grantSource.grantsForCampaign(started);
        const items = await this.runtime.generateItems(
          started,
          snapshot.grants,
          snapshot.principals,
          { assignReviewers: this.config.assignReviewers },
        );
        startedCampaigns.push(started.id);
        generatedItems += items.length;
      } else if (current.status === "in_progress") {
        const items = await this.runtime.itemStore.listByCampaign(current.tenantId, current.id);
        const decisions = await this.runtime.planAutoRevocations(items, current, now);
        for (const decision of decisions) autoRevocations.push(decision.id);
        // Re-read, because the auto-revocations just resolved items this list is stale about: the
        // whole point of the close is that it only fires when nothing is outstanding.
        const settled = await this.runtime.itemStore.listByCampaign(current.tenantId, current.id);
        if (
          this.config.closeCompletedCampaigns &&
          this.runtime.runtime.isCampaignCompletable(current, settled)
        ) {
          const outcome = await this.runtime.closeCampaign({
            campaign: current,
            createdBy: this.config.systemActorUserId,
            now,
            ...(this.config.evidenceStorageUriPrefix !== undefined
              ? { storageUri: `${this.config.evidenceStorageUriPrefix}${current.id}` }
              : {}),
            ...(this.opts.onEvidenceError !== undefined
              ? { onSealError: this.opts.onEvidenceError }
              : {}),
          });
          closedCampaigns.push(outcome.campaign.id);
          if (outcome.evidence !== null) sealedEvidence.push(outcome.evidence.id);
        }
      } else if (current.status === "completed" && this.config.closeCompletedCampaigns) {
        // The retry: a close whose seal failed leaves a `completed` campaign with no sealed pack,
        // and nothing else would ever look at it again.
        try {
          const ensured = await this.runtime.ensureSealedEvidenceForCampaign({
            campaign: current,
            createdBy: this.config.systemActorUserId,
            now,
            ...(this.config.evidenceStorageUriPrefix !== undefined
              ? { storageUri: `${this.config.evidenceStorageUriPrefix}${current.id}` }
              : {}),
          });
          if (ensured.outcome === "sealed") sealedEvidence.push(ensured.evidence.id);
        } catch (err) {
          this.opts.onEvidenceError?.(err);
        }
      }
    }

    return {
      at: now.toISOString(),
      startedCampaigns,
      generatedItems,
      autoRevocations,
      closedCampaigns,
      sealedEvidence,
    };
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface AccessReviewsLifecycle {
  readonly scheduler: AccessReviewCampaignScheduler;
  readonly runtime: PersistentAccessReviewRuntime;
}

export function buildAccessReviewsLifecycle(
  conn: PgConnection,
  config: AccessReviewsConfig,
  opts: AccessReviewsLifecycleOptions = {},
): AccessReviewsLifecycle {
  const runtime =
    opts.runtime ??
    buildPersistentAccessReviewRuntime(conn, { systemActorUserId: config.systemActorUserId });
  const scheduler = new AccessReviewCampaignScheduler(runtime, config, opts);
  return { scheduler, runtime };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
