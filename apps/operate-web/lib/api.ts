// Client-side API helper. All requests go to this Next app's /api proxy,
// which forwards to operate-server with auth. Same-origin, so no CORS.

import type { AgingResponse } from "@/lib/aging";
import type { WhtReconciliation } from "@/lib/wht";

export interface ListResult {
  readonly data: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor: string | null;
}

function apiPath(slug: string, suffix = ""): string {
  return `/api/v1/${slug}${suffix}`;
}

export async function listRecords(slug: string, query = ""): Promise<ListResult> {
  const res = await fetch(apiPath(slug, query), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  const json = (await res.json()) as unknown;
  if (Array.isArray(json)) {
    return { data: json as Array<Record<string, unknown>>, nextCursor: null };
  }
  const obj = json as { data?: Array<Record<string, unknown>>; page?: { nextCursor?: string | null } };
  return { data: obj.data ?? [], nextCursor: obj.page?.nextCursor ?? null };
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
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function getRecord(slug: string, id: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiPath(slug, `/${encodeURIComponent(id)}`), {
    headers: { accept: "application/json" },
  });
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
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function deleteRecord(slug: string, id: string): Promise<void> {
  const res = await fetch(apiPath(slug, `/${encodeURIComponent(id)}`), { method: "DELETE" });
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
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const res = await fetch("/api/v1/admin/settings", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function putSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("/api/v1/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function fetchAging(asOf?: string): Promise<AgingResponse> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  const res = await fetch(`/api/v1/meta/aging${query}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status}: ${await safeText(res)}`);
  return (await res.json()) as AgingResponse;
}

export async function fetchWhtReconciliation(): Promise<WhtReconciliation> {
  const res = await fetch("/api/v1/meta/wht-reconciliation", { headers: { accept: "application/json" } });
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
