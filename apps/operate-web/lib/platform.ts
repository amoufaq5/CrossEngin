// PLATFORM (super-admin) API helpers. Like lib/api.ts, every request goes to
// this Next app's /api proxy, which forwards to operate-server with the server's
// x-api-key — so the browser never holds a platform credential and there are no
// CORS concerns. All paths hit /api/v1/platform/...

export type TenantStatus = "active" | "suspended" | "archived" | "deleted";

export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly tier: string;
  readonly region: string;
  readonly schemaName: string;
  readonly searchLocale: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TenantPage {
  readonly data: ReadonlyArray<Tenant>;
  readonly nextCursor: string | null;
}

export interface TenantCounts {
  readonly active: number;
  readonly suspended: number;
  readonly archived: number;
  readonly deleted: number;
  readonly total: number;
}

export type TenantAction = "suspend" | "archive" | "reactivate";

export interface CreateTenantBody {
  readonly slug: string;
  readonly name: string;
  readonly tier?: string;
  readonly region?: string;
}

/**
 * An error carrying the HTTP status + the parsed problem detail, so pages can
 * both branch on the status (e.g. a 409 duplicate slug or illegal transition)
 * and surface a human message inline.
 */
export class PlatformError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
  }
}

function apiPath(suffix = ""): string {
  return `/api/v1/platform${suffix}`;
}

/**
 * Reads a non-2xx response body and extracts the best human message from an
 * RFC 9457 problem document ({ detail | title | message }), falling back to the
 * raw text or status line. Throws a PlatformError carrying the status.
 */
async function throwProblem(res: Response): Promise<never> {
  let message = res.statusText || `Request failed (${res.status})`;
  try {
    const text = await res.text();
    if (text !== "") {
      try {
        const body = JSON.parse(text) as {
          detail?: unknown;
          title?: unknown;
          message?: unknown;
          error?: unknown;
        };
        const picked = body.detail ?? body.title ?? body.message ?? body.error;
        message = typeof picked === "string" && picked.trim() !== "" ? picked : text;
      } catch {
        message = text;
      }
    }
  } catch {
    // keep the status-line fallback
  }
  throw new PlatformError(res.status, message);
}

async function getJson<T>(suffix: string): Promise<T> {
  const res = await fetch(apiPath(suffix), { headers: { accept: "application/json" } });
  if (!res.ok) await throwProblem(res);
  return (await res.json()) as T;
}

export async function listTenants(
  params: { status?: string; limit?: number; cursor?: string } = {},
): Promise<TenantPage> {
  const p = new URLSearchParams();
  if (params.status && params.status !== "all") p.set("status", params.status);
  if (params.limit !== undefined) p.set("limit", String(params.limit));
  if (params.cursor) p.set("cursor", params.cursor);
  const qs = p.toString();
  const json = await getJson<{ data?: Tenant[]; page?: { nextCursor?: string | null } }>(
    `/tenants${qs ? `?${qs}` : ""}`,
  );
  return { data: json.data ?? [], nextCursor: json.page?.nextCursor ?? null };
}

export async function getTenant(id: string): Promise<Tenant> {
  const json = await getJson<{ tenant: Tenant }>(`/tenants/${encodeURIComponent(id)}`);
  return json.tenant;
}

export async function createTenant(body: CreateTenantBody): Promise<Tenant> {
  const res = await fetch(apiPath("/tenants"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwProblem(res);
  const json = (await res.json()) as { tenant: Tenant };
  return json.tenant;
}

export async function setTenantStatus(id: string, action: TenantAction): Promise<Tenant> {
  const res = await fetch(apiPath(`/tenants/${encodeURIComponent(id)}/${action}`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  if (!res.ok) await throwProblem(res);
  const json = (await res.json()) as { tenant: Tenant };
  return json.tenant;
}

export async function platformStats(): Promise<TenantCounts> {
  const json = await getJson<{ counts: TenantCounts }>("/stats");
  return json.counts;
}
