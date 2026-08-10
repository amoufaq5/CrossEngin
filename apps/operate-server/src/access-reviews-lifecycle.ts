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

export const AccessReviewsConfigSchema = z
  .object({
    systemActorUserId: z.string().uuid(),
    intervalMs: z.number().int().positive().default(3_600_000),
    assignReviewers: z.boolean().default(true),
    campaigns: z.array(AccessReviewCampaignSchema).min(1),
    grants: z.array(LiveGrantSchema).default([]),
    principals: z.array(PrincipalUnderReviewSchema).default([]),
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

  constructor(
    private readonly runtime: PersistentAccessReviewRuntime,
    private readonly config: AccessReviewsConfig,
    private readonly opts: AccessReviewsLifecycleOptions = {},
  ) {}

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
    let generatedItems = 0;

    for (const configCampaign of this.config.campaigns) {
      const current =
        (await this.runtime.campaignStore.getByCampaignId(
          configCampaign.tenantId,
          configCampaign.id,
        )) ?? configCampaign;

      if (isDueToStart(current, now)) {
        const started = await this.runtime.startCampaign(current, now);
        const items = await this.runtime.generateItems(
          started,
          this.config.grants,
          this.config.principals,
          { assignReviewers: this.config.assignReviewers },
        );
        startedCampaigns.push(started.id);
        generatedItems += items.length;
      } else if (current.status === "in_progress") {
        const items = await this.runtime.itemStore.listByCampaign(current.tenantId, current.id);
        const decisions = await this.runtime.planAutoRevocations(items, current, now);
        for (const decision of decisions) autoRevocations.push(decision.id);
      }
    }

    return {
      at: now.toISOString(),
      startedCampaigns,
      generatedItems,
      autoRevocations,
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
