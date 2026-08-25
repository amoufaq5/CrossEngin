import type { ContentCategory, DigestBatch, PriorityLevel } from "@crossengin/notifications";

import { buildDigestDispatch, type DigestMember } from "./digest-assembly.js";
import type { DigestItemRecord } from "./digest-store.js";
import type { DispatchInput } from "./notification-store.js";

export interface AssemblyDigestSource {
  dueForAssembly(tenantId: string, now: Date, limit?: number): Promise<readonly DigestBatch[]>;
  itemsFor(
    tenantId: string,
    digestId: string,
    limit?: number,
  ): Promise<readonly DigestItemRecord[]>;
  markAssembled(tenantId: string, digestId: string, at: Date): Promise<boolean>;
}

export interface AssemblyDeliverySink {
  supersedeDeferred(
    tenantId: string,
    rowId: string,
    recipientAddressSha256: string,
    at: Date,
  ): Promise<boolean>;
  reconcile(tenantId: string, rowId: string, at: Date): Promise<unknown>;
}

export interface AssemblyDispatchSink {
  record(input: DispatchInput): Promise<boolean>;
}

export interface DigestAssemblyOptions {
  readonly digests: AssemblyDigestSource;
  readonly deliveries: AssemblyDeliverySink;
  readonly dispatches: AssemblyDispatchSink;
  readonly clock?: () => Date;
  readonly batchSize?: number;
  readonly onError?: (err: unknown, tenantId: string) => void;
}

export interface AssemblyReport {
  readonly tenantId: string;
  readonly digests: number;
  readonly queued: number;
  readonly superseded: number;
  readonly empty: number;
}

export interface MultiTenantAssemblyReport {
  readonly tenants: number;
  readonly reports: readonly AssemblyReport[];
  readonly digests: number;
  readonly queued: number;
  readonly superseded: number;
}

export const DEFAULT_ASSEMBLY_BATCH_SIZE = 25;

export function memberFromItem(item: DigestItemRecord): DigestMember {
  return {
    dispatchId: item.dispatchId,
    rowId: item.dispatchRowId,
    templateId: item.templateId,
    category: item.category as ContentCategory,
    priority: item.priority as PriorityLevel,
    locale: item.locale,
    correlationId: item.correlationId,
    queuedAt: item.queuedAt,
  };
}

async function assembleOne(
  opts: DigestAssemblyOptions,
  tenantId: string,
  digest: DigestBatch,
  now: Date,
): Promise<{ queued: boolean; superseded: number; empty: boolean }> {
  const items = await opts.digests.itemsFor(tenantId, digest.id);
  if (items.length === 0) {
    // A pool that stands for nothing has nothing to render; close it so it stops coming back due.
    await opts.digests.markAssembled(tenantId, digest.id, now);
    return { queued: false, superseded: 0, empty: true };
  }

  const assembledAt = now.toISOString();
  const summary = buildDigestDispatch({
    digest,
    members: items.map(memberFromItem),
    assembledAt,
  });

  // Queue the summary BEFORE retiring the individual notices. A crash between the two leaves
  // those notices still pending — the recipient gets them separately, which is noisy but not
  // lost; the reverse order could retire them with no digest ever queued.
  const queued = await opts.dispatches.record(summary);

  let superseded = 0;
  for (const item of items) {
    if (await opts.deliveries.supersedeDeferred(
      tenantId,
      item.dispatchRowId,
      item.recipientAddressSha256,
      now,
    )) {
      superseded += 1;
    }
    await opts.deliveries.reconcile(tenantId, item.dispatchRowId, now);
  }

  await opts.digests.markAssembled(tenantId, digest.id, now);
  return { queued, superseded, empty: false };
}

export async function assembleDueDigests(
  opts: DigestAssemblyOptions,
  tenantId: string,
): Promise<AssemblyReport> {
  const now = opts.clock ?? ((): Date => new Date());
  const due = await opts.digests.dueForAssembly(
    tenantId,
    now(),
    opts.batchSize ?? DEFAULT_ASSEMBLY_BATCH_SIZE,
  );

  let queued = 0;
  let superseded = 0;
  let empty = 0;
  for (const digest of due) {
    const result = await assembleOne(opts, tenantId, digest, now());
    if (result.queued) queued += 1;
    if (result.empty) empty += 1;
    superseded += result.superseded;
  }

  return { tenantId, digests: due.length, queued, superseded, empty };
}

export async function assembleForTenants(
  opts: DigestAssemblyOptions,
  tenantIds: readonly string[],
): Promise<MultiTenantAssemblyReport> {
  const reports: AssemblyReport[] = [];
  for (const tenantId of tenantIds) {
    try {
      reports.push(await assembleDueDigests(opts, tenantId));
    } catch (err) {
      // One tenant's failure must not stop the sweep for the rest.
      opts.onError?.(err, tenantId);
    }
  }
  return {
    tenants: reports.length,
    reports,
    digests: reports.reduce((n, r) => n + r.digests, 0),
    queued: reports.reduce((n, r) => n + r.queued, 0),
    superseded: reports.reduce((n, r) => n + r.superseded, 0),
  };
}
