import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session";
import { UPSTREAM_BASE_URL } from "@/lib/upstream";

// Server-side proxy: the browser only ever talks to this Next app, so there are no CORS
// concerns, and this is the one place a session cookie becomes the API's credential — the
// browser holds an `httpOnly` cookie it cannot read and the API only ever sees a bearer
// token. There is deliberately no shared API key here any more: it made every browser that
// could reach the domain the same principal, which in the shipped stack is a `platform_admin`
// who can provision and delete tenants.
//
// Config via env: OPERATE_API_URL (see lib/upstream.ts).

export const dynamic = "force-dynamic";

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const token = (req.cookies.get(SESSION_COOKIE)?.value ?? "").trim();
  if (token === "") {
    // Refused here rather than forwarded: with no session there is no credential to send, and
    // calling upstream would be asking the API to answer as nobody. A JSON 401 and never a
    // redirect — every caller is a `fetch`, which follows redirects, so a redirect would hand
    // the client a 200 carrying the login page's HTML to parse as JSON.
    return NextResponse.json(
      { error: "unauthenticated", detail: "No session cookie on this request." },
      { status: 401 },
    );
  }

  const search = req.nextUrl.search;
  const url = `${UPSTREAM_BASE_URL}/${path.join("/")}${search}`;

  // An allowlist, built from nothing the browser sent except the content type. In particular
  // the incoming `Cookie` header is not forwarded: the cookie is this app's, and the API has
  // no reader for one.
  //
  // And deliberately no `x-tenant-id`. The token carries an authoritative `tenant_id` claim,
  // and the API cross-checks a supplied header against it by raw string equality with no case
  // normalisation — so a UUID differing only in hex case would be a 401 on every request.
  // Adding that header later looks harmless; it is not.
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(url, { method, headers, body, cache: "no-store" });
  } catch (err) {
    return Response.json(
      {
        error: "upstream_unreachable",
        detail: String(err),
        hint: `Is operate-server running at ${UPSTREAM_BASE_URL}?`,
      },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

interface Ctx {
  params: { path: string[] };
}

export const GET = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const POST = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const PATCH = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const PUT = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
export const DELETE = (req: NextRequest, { params }: Ctx) => proxy(req, params.path);
