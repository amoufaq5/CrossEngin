import { NextRequest, NextResponse } from "next/server";
import { apiTarget, limitedBody, sameOrigin, sealSession, SESSION_COOKIE, SESSION_SECONDS } from "../../../lib/session";
export const runtime = "nodejs";
export async function POST(req: NextRequest): Promise<Response> {
  if (!sameOrigin(req)) return Response.json({ error: "origin_denied" }, { status: 403 });
  try {
    const input = JSON.parse(new TextDecoder().decode(await limitedBody(req, 4096))) as Record<string, unknown>;
    const credential = input.credential;
    if (typeof credential !== "string" || credential.length < 16 || credential.length > 2500 || /\s/.test(credential)) return Response.json({ error: "invalid_credential" }, { status: 400 });
    // Verification uses a permission-bearing endpoint, never a public health check.
    const checked = await fetch(`${apiTarget()}/v1/meta/schema`, {
      headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
      cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!checked.ok) return Response.json({ error: "sign_in_failed" }, { status: 401 });
    const payload = await checked.json() as { viewer?: { primaryRole?: string } };
    if (!payload.viewer?.primaryRole || payload.viewer.primaryRole === "anonymous") return Response.json({ error: "sign_in_failed" }, { status: 401 });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, sealSession(credential), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: SESSION_SECONDS });
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (err) { return Response.json({ error: err instanceof RangeError ? "payload_too_large" : "sign_in_unavailable" }, { status: err instanceof RangeError ? 413 : 503 }); }
}
export async function DELETE(req: NextRequest): Promise<Response> {
  if (!sameOrigin(req)) return new Response(null, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
