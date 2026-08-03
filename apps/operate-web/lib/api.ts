// Client-side API helper. All requests go to this Next app's /api proxy,
// which forwards to operate-server with auth. Same-origin, so no CORS.

import type { AgingResponse } from "@/lib/aging";
import type { TenantEntitlement, TenantUsage } from "@/lib/entitlement";
import { reportSubscriptionProblem } from "@/lib/subscription";
import type { WhtReconciliation } from "@/lib/wht";

export interface ListResult {
  readonly data: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor: string | null;
}

function apiPath(slug: string, suffix = ""): string {
  return `/api/v1/${slug}${suffix}`;
}

// Detect the serving API's subscription-entitlement gate. A 402 carries a
// problem+json body { subscriptionStatus, reason, detail }; surface it via the
// pub/sub so the global banner can explain it. Clear the banner on any success.
async function checkResponse(res: Response): Promise<void> {
  if (res.ok) {
    reportSubscriptionProblem(null);
    return;
  }
  if (res.status === 402) {
    try {
      const body = (await res.clone().json()) as {
        subscriptionStatus?: string | null;
        reason?: string;
        detail?: string;
      };
      reportSubscriptionProblem({
        status: body.subscriptionStatus ?? null,
        reason: body.reason ?? "not_entitled",
        detail: body.detail,
      });
    } catch {
      reportSubscriptionProblem({ status: null, reason: "not_entitled" });
    }
  }
}

export async function listRecords(slug: string, query = ""): Promise<ListResult> {
  const res = await fetch(apiPath(slug, query), { headers: { accept: "application/json" } });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  const json = (await res.json()) as unknown;
  if (Array.isArray(json)) {
    return { data: json as Array<Record<string, unknown>>, nextCursor: null };
  }
  const obj = json as { data?: Array<Record<string, unknown>>; page?: { nextCursor?: string | null } };
  return { data: obj.data ?? [], nextCursor: obj.page?.nextCursor ?? null };
}

/** Lists the m2m-associated records of a record: `GET /v1/<ownerSlug>/<id>/<relatedSlug>`. */
export async function listAssociations(
  ownerSlug: string,
  id: string,
  relatedSlug: string,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const suffix = `/${encodeURIComponent(id)}/${relatedSlug}`;
  const res = await fetch(apiPath(ownerSlug, suffix), { headers: { accept: "application/json" } });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return json.data ?? [];
}

export async function createRecord(
  slug: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(apiPath(slug), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function getRecord(slug: string, id: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiPath(slug, `/${encodeURIComponent(id)}`), {
    headers: { accept: "application/json" },
  });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function updateRecord(
  slug: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(apiPath(slug, `/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function deleteRecord(slug: string, id: string): Promise<void> {
  const res = await fetch(apiPath(slug, `/${encodeURIComponent(id)}`), { method: "DELETE" });
  await checkResponse(res);
  if (!res.ok && res.status !== 204) throw new Error(`${res.status}: ${await safeText(res)}`);
}

export async function runTransition(
  slug: string,
  id: string,
  transition: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(apiPath(slug, `/${encodeURIComponent(id)}/${encodeURIComponent(transition)}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const res = await fetch("/api/v1/admin/settings", { headers: { accept: "application/json" } });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function putSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("/api/v1/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function fetchAging(asOf?: string): Promise<AgingResponse> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  const res = await fetch(`/api/v1/meta/aging${query}`, { headers: { accept: "application/json" } });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as AgingResponse;
}

export async function fetchEntitlement(): Promise<TenantEntitlement> {
  const res = await fetch("/api/v1/meta/entitlement", { headers: { accept: "application/json" } });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as TenantEntitlement;
}

export async function fetchUsage(): Promise<TenantUsage> {
  const res = await fetch("/api/v1/meta/usage", { headers: { accept: "application/json" } });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as TenantUsage;
}

export async function createBillingPortalSession(): Promise<{ url: string }> {
  const res = await fetch("/api/v1/meta/billing-portal", {
    method: "POST",
    headers: { accept: "application/json" },
  });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as { url: string };
}

export async function fetchWhtReconciliation(from?: string, to?: string): Promise<WhtReconciliation> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();
  const res = await fetch(`/api/v1/meta/wht-reconciliation${query ? `?${query}` : ""}`, {
    headers: { accept: "application/json" },
  });
  await checkResponse(res);
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as WhtReconciliation;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}
