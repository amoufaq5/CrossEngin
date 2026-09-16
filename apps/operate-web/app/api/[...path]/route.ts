import { NextRequest } from "next/server";
import { apiTarget, limitedBody, openSession, sameOrigin, SESSION_COOKIE } from "../../../lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const session = openSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session === null) return Response.json({ error: "authentication_required" }, { status: 401 });
  const method = req.method.toUpperCase();
  if (!["GET", "HEAD"].includes(method) && !sameOrigin(req)) return Response.json({ error: "origin_denied" }, { status: 403 });
  if (path.some(p => !p || p === "." || p === ".." || /[\\/\x00]/.test(p))) return Response.json({ error: "invalid_path" }, { status: 400 });
  const headers = new Headers({ authorization: `Bearer ${session.credential}`, accept: "application/json" });
  for (const name of ["content-type", "idempotency-key", "if-match", "if-none-match", "x-api-version"]) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // No caller-supplied API key, role or tenant hint. The backend derives identity from the credential.
  try {
    const body = ["GET", "HEAD"].includes(method) ? undefined : await limitedBody(req, 10 * 1024 * 1024);
    const upstream = await fetch(`${apiTarget()}/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`, {
      method, headers, body: body === undefined ? undefined : Buffer.from(body), cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(120_000),
    });
    const responseHeaders = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "etag", "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset", "www-authenticate"]) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (err) { return Response.json({ error: err instanceof RangeError ? "payload_too_large" : "upstream_unavailable" }, { status: err instanceof RangeError ? 413 : 502 }); }
}
interface Ctx { params: { path: string[] } }
export const GET = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const POST = GET;
export const PATCH = GET;
export const PUT = GET;
export const DELETE = GET;
