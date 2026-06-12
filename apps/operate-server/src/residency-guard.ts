import {
  buildProfileFromTemplate,
  isRegionAllowed,
  selectPrimaryRegion,
  RegionSchema,
  type Region,
  type ResidencyProfile,
} from "@crossengin/residency";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import type { OperateDispatcher } from "./tenant-dispatcher.js";

/** The residency profile templates an operator can bind a tenant to (excludes `custom`). */
const RESIDENCY_TEMPLATES = ["eu-only", "us-only", "me-only", "unrestricted"] as const;
type ResidencyTemplate = (typeof RESIDENCY_TEMPLATES)[number];

/** A deterministic establishment timestamp for an operator-declared residency binding. */
const RESIDENCY_BINDING_ESTABLISHED_AT = "2026-01-01T00:00:00.000Z";

export interface TenantResidencySpec {
  readonly tenantId: string;
  readonly profile: ResidencyProfile;
}

/** Parses a `--tenant-residency <tenantId>:<template>` spec into a bound profile. */
export function parseTenantResidencySpec(raw: string): TenantResidencySpec {
  const sep = raw.lastIndexOf(":");
  if (sep <= 0) throw new Error(`invalid --tenant-residency '${raw}' (expected tenantId:template)`);
  const tenantId = raw.slice(0, sep);
  const template = raw.slice(sep + 1);
  if (!(RESIDENCY_TEMPLATES as readonly string[]).includes(template)) {
    throw new Error(`invalid residency template '${template}' (one of ${RESIDENCY_TEMPLATES.join(", ")})`);
  }
  return {
    tenantId,
    profile: buildProfileFromTemplate(template as ResidencyTemplate, { establishedAt: RESIDENCY_BINDING_ESTABLISHED_AT }),
  };
}

/** Validates a `--region` value against the known regions. */
export function parseRegion(raw: string): Region {
  const result = RegionSchema.safeParse(raw);
  if (!result.success) throw new Error(`invalid --region '${raw}'`);
  return result.data;
}

function misdirectedResponse(served: Region, required: Region, tenantId: string): RawHttpResponse {
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: "https://crossengin.io/problems/misdirected-region",
      title: "Misdirected region",
      status: 421,
      detail: `tenant is residency-bound and cannot be served from region '${served}'; route to '${required}'`,
      extensions: { servedRegion: served, requiredRegion: required, tenantId },
    }),
  );
  return {
    status: 421,
    headers: {
      "content-type": "application/problem+json",
      "content-length": body.byteLength.toString(),
      "x-crossengin-required-region": required,
    },
    body,
  };
}

export interface ResidencyGuardOptions {
  /** The region this operate-server instance serves. */
  readonly region: Region;
  /** The wrapped dispatcher (base server / TenantDispatcher). */
  readonly inner: OperateDispatcher;
  /** Pre-resolves a request's tenant (the same resolver the marketplace dispatcher uses). */
  readonly tenantOf: (raw: RawHttpRequest) => string | null;
  /** Tenant → residency profile bindings. */
  readonly profiles: ReadonlyMap<string, ResidencyProfile>;
}

/**
 * A dispatcher wrapper that enforces **data residency** at the serving edge: a
 * request whose pre-resolved tenant is residency-bound to a region this instance
 * cannot serve is short-circuited with a `421 Misdirected Request` naming the
 * region it should be routed to (the profile's primary), before the gateway
 * pipeline runs. Requests for unbound tenants — or tenants this instance's region
 * *is* allowed to serve — pass through unchanged. The pre-resolution is the same
 * credential→tenant map lookup the per-tenant dispatcher uses (no crypto); the
 * inner gateway still runs the full auth + RBAC.
 */
export class ResidencyGuard implements OperateDispatcher {
  private readonly region: Region;
  private readonly inner: OperateDispatcher;
  private readonly tenantOf: (raw: RawHttpRequest) => string | null;
  private readonly profiles: ReadonlyMap<string, ResidencyProfile>;

  constructor(opts: ResidencyGuardOptions) {
    this.region = opts.region;
    this.inner = opts.inner;
    this.tenantOf = opts.tenantOf;
    this.profiles = opts.profiles;
  }

  async dispatchWithMatch(
    raw: RawHttpRequest,
    body: Uint8Array | null,
  ): Promise<{ readonly response: RawHttpResponse; readonly matchedOperationId: string | null }> {
    const tenantId = this.tenantOf(raw);
    if (tenantId !== null) {
      const profile = this.profiles.get(tenantId);
      if (profile !== undefined && !isRegionAllowed(profile, this.region).compatible) {
        return { response: misdirectedResponse(this.region, selectPrimaryRegion(profile), tenantId), matchedOperationId: null };
      }
    }
    return this.inner.dispatchWithMatch(raw, body);
  }
}
