// PLATFORM (super-admin) API helpers. Like lib/api.ts, every request goes to
// this Next app's /api proxy, which turns the caller's session cookie into the
// API's bearer token — so the browser never holds a readable credential and there
// are no CORS concerns. All paths hit /api/v1/platform/...

import { handleUnauthorized } from "@/lib/unauthorized";

/**
 * All five, which is what the server has had since ADR-0334 added `pending_deletion`.
 *
 * This was four, and the two consequences were live rather than cosmetic: the type was simply
 * **false about the wire**, so a tenant awaiting an Article 17 erasure rendered its raw status
 * through a `TenantStatus`-typed field that said it could not exist; and the list page's filter
 * offered the four it knew, so such a tenant was **unfindable** — the one state in which an
 * operator most wants to find a tenant is the one the console could not ask for.
 *
 * `pending_deletion` deliberately carries no action in the console. `TENANT_STATUS_TRANSITIONS` has
 * no set targeting it and `CONSOLE_ACTION` has three non-null entries for that reason: a tenant
 * reaches it through the deletion-request route and leaves it the same way, so a button here would
 * be a second route to a state machine that already has one.
 */
export const TENANT_STATUSES = [
  "active",
  "suspended",
  "archived",
  "pending_deletion",
  "deleted",
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

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

/**
 * Derived from `TENANT_STATUSES` rather than hand-listed, because the hand-listed version named
 * four of the five and so had no figure for `pending_deletion` at all — the state ADR-0334 added to
 * the lifecycle and ADR-0363 made the request path enforce. The server's `TenantStatusCounts` is
 * `Readonly<Record<TenantStatus, number>> & {total}`, so it has always *sent* five, and the only
 * thing missing was a type that admitted the fifth and a tile that read it.
 */
export type TenantCounts = Readonly<Record<TenantStatus, number>> & { readonly total: number };

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
 *
 * Exported because `lib/users.ts` reads the *same* problem documents from the same API through the
 * same proxy, and its routes answer the same `{error, detail}` shape. A second copy there would be
 * the one place the two could disagree about which key carries the human message — and the
 * 401-redirect side effect is the half that must not be forgotten, since a module that omitted it
 * would leave an expired session rendering "Request failed (401)" on every panel instead of
 * sending the viewer to the login.
 */
export async function throwProblem(res: Response): Promise<never> {
  // The single error path of every request in this module and in lib/users.ts.
  handleUnauthorized(res);
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

/**
 * `reason` is required by the server (a non-empty string, max 500) and the body is parsed
 * `.strict()`, so it is sent alone. It lands in the tenant's permanent lifecycle trail as why the
 * tenant's access changed, which is why the caller must supply it rather than this helper
 * defaulting one.
 */
export async function setTenantStatus(
  id: string,
  action: TenantAction,
  reason: string,
): Promise<Tenant> {
  const res = await fetch(apiPath(`/tenants/${encodeURIComponent(id)}/${action}`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) await throwProblem(res);
  const json = (await res.json()) as { tenant: Tenant };
  return json.tenant;
}

export async function platformStats(): Promise<TenantCounts> {
  const json = await getJson<{ counts: TenantCounts }>("/stats");
  return json.counts;
}
