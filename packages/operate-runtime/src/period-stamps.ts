import type { Manifest } from "@crossengin/kernel/manifest";
import { resolvedFields } from "@crossengin/kernel/ddl";

import { lifecycleStateField } from "./list-query.js";
import type { WriteEffect } from "./write-effects.js";

/**
 * `FiscalPeriod.closed_at`: when the period was closed, written by the server (ADR-0480, ADR-0433
 * Q8).
 *
 * `erp-core` declared the field and nothing wrote it, so a closed period carried no close time, and
 * the field was client-writable — a caller could back-date a close the server never recorded. It is
 * an effect stamp now: set to the server's clock on the edge **into** a closed state, kept while the
 * period stays closed (`closed → locked` is still closed), and cleared on the edge **out of** one
 * (`reopen`), because a reopened period is not closed and a stale time would say it was. A re-close
 * stamps the new time; the reopen and both closes are on the audit trail, which is where the history
 * lives. Registered as an `EffectStamp`, so a create or update body naming it is refused
 * `field_server_owned` like every other stamp.
 */
export const CLOSED_PERIOD_STATES = ["closed", "locked"] as const;

export interface PeriodClosedAtWiring {
  readonly entity: string;
  readonly stateField: string;
  readonly field: string;
}

/** The wiring on this manifest, or `null` when there is no period, no state field or no `closed_at`. */
export function periodClosedAtWiring(manifest: Manifest): PeriodClosedAtWiring | null {
  const entity = (manifest.entities ?? []).find((e) => e.name === "FiscalPeriod");
  if (entity === undefined) return null;
  const fields = new Set(resolvedFields(entity, manifest.traits ?? []).map((f) => f.name));
  if (!fields.has("closed_at")) return null;
  const stateField = lifecycleStateField(manifest, entity.name) ?? (fields.has("status") ? "status" : null);
  if (stateField === null) return null;
  return { entity: entity.name, stateField, field: "closed_at" };
}

function isClosed(state: unknown): boolean {
  return typeof state === "string" && (CLOSED_PERIOD_STATES as readonly string[]).includes(state);
}

/**
 * Sets the stamp on entering a closed state and clears it on leaving one. Runs inside the write's
 * transaction, after the state change, so a close the transaction rolls back leaves no stamp.
 */
export function periodClosedAtStampEffect(
  config: PeriodClosedAtWiring & { readonly clock?: { now(): Date } },
): WriteEffect {
  return async (input) => {
    if (input.entity !== config.entity || input.id === null) return;
    if (input.operation !== "update" && input.operation !== "transition") return;
    const was = isClosed(input.before?.[config.stateField]);
    const is = isClosed(input.after[config.stateField]);
    if (was === is) return;
    const nowIso = (config.clock?.now() ?? new Date()).toISOString();
    if (!is && (input.before?.[config.field] ?? null) === null) return;
    await input.store.update(input.tenantId, config.entity, input.id, {
      [config.field]: is ? nowIso : null,
      updated_at: nowIso,
    });
  };
}
