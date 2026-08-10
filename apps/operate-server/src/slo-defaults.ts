import type { Manifest } from "@crossengin/kernel";
import type { AlertPolicy } from "@crossengin/observability";
import { manifestRouteSpecs } from "@crossengin/operate-runtime";

import { SloConfigSchema, type SloConfig } from "./slo-config.js";

/** Actions whose surface is a read (availability + latency tuned looser/tighter accordingly). */
const READ_ACTIONS: ReadonlySet<string> = new Set(["list", "read", "get"]);

export const DEFAULT_SLO_SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/**
 * A placeholder alert policy so `--slo-defaults` enforces with zero extra config.
 * A deployment that actually pages should supply a real policy via `--slo-config`;
 * this routes the severities the burn/latency engines emit to a default channel.
 */
export const DEFAULT_SLO_ALERT_POLICY: AlertPolicy = {
  id: "operate-default",
  routes: [
    { severity: "P1", channels: [{ kind: "pagerduty_phone", serviceKey: "operate-default-oncall" }] },
    { severity: "P2", channels: [{ kind: "slack", channel: "#slo-alerts" }] },
    { severity: "P3", channels: [{ kind: "slack", channel: "#slo-alerts" }] },
  ],
};

export interface SloDefaultsOptions {
  readonly systemActorUserId?: string;
  readonly alertPolicy?: AlertPolicy;
  readonly evaluateIntervalMs?: number;
  readonly window?: string;
  readonly readAvailability?: number;
  readonly writeAvailability?: number;
  readonly readP95?: string;
  readonly writeP95?: string;
  readonly includeLatency?: boolean;
  readonly tenantId?: string | null;
}

/**
 * Derives a full `SloConfig` from a resolved manifest: one availability SLO (and,
 * by default, one latency SLO) per entity operation surface, with read vs. write
 * targets — so a pack ships with sensible defaults and an operator can run
 * `operate-server --pack … --slo-defaults` without hand-writing a config. The
 * surface is the operation's operationId (matching the gateway's
 * `routeOperationId`); the SLO id is a kebab slug of it.
 */
export function deriveSloConfig(manifest: Manifest, opts: SloDefaultsOptions = {}): SloConfig {
  const window = opts.window ?? "30d";
  const readAvailability = opts.readAvailability ?? 0.999;
  const writeAvailability = opts.writeAvailability ?? 0.995;
  const readP95 = opts.readP95 ?? "200ms";
  const writeP95 = opts.writeP95 ?? "500ms";
  const includeLatency = opts.includeLatency ?? true;

  const availability: unknown[] = [];
  const latency: unknown[] = [];
  const seen = new Set<string>();

  for (const spec of manifestRouteSpecs(manifest)) {
    if (seen.has(spec.operationId)) continue;
    seen.add(spec.operationId);
    const isRead = READ_ACTIONS.has(spec.action);
    const idBase = sloSlug(spec.operationId);
    const tenantPart = opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {};
    availability.push({
      slo: {
        id: `${idBase}-availability`,
        surface: spec.operationId,
        targets: [
          { kind: "availability", target: isRead ? readAvailability : writeAvailability, window },
        ],
      },
      category: "availability",
      ...tenantPart,
    });
    if (includeLatency) {
      latency.push({
        slo: {
          id: `${idBase}-latency`,
          surface: spec.operationId,
          targets: [
            { kind: "latency", endpointClass: isRead ? "read" : "write", p95: isRead ? readP95 : writeP95, window },
          ],
        },
        ...tenantPart,
      });
    }
  }

  if (availability.length === 0) {
    throw new Error("deriveSloConfig: manifest declares no entity operations to enforce");
  }

  return SloConfigSchema.parse({
    alertPolicy: opts.alertPolicy ?? DEFAULT_SLO_ALERT_POLICY,
    systemActorUserId: opts.systemActorUserId ?? DEFAULT_SLO_SYSTEM_ACTOR,
    ...(opts.evaluateIntervalMs !== undefined ? { evaluateIntervalMs: opts.evaluateIntervalMs } : {}),
    availability,
    latency,
  });
}

/** A gateway operationId (`salesOrder.create`) → a valid kebab SLO id slug (`salesorder-create`). */
export function sloSlug(operationId: string): string {
  return operationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
