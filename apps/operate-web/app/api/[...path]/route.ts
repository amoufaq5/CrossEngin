import { NextRequest } from "next/server";

// Server-side proxy: the browser only ever talks to this Next app, so there
// are no CORS concerns and the operate-server API key stays on the server.
//
// Config via env:
//   OPERATE_API_URL  (default http://localhost:8787)
//   OPERATE_API_KEY  (default devkey)

const TARGET = (process.env.OPERATE_API_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const API_KEY = process.env.OPERATE_API_KEY ?? "devkey";

export const dynamic = "force-dynamic";

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const search = req.nextUrl.search;
  const url = `${TARGET}/${path.join("/")}${search}`;

  const headers: Record<string, string> = {
    "x-api-key": API_KEY,
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
      { error: "upstream_unreachable", detail: String(err), hint: `Is operate-server running at ${TARGET}?` },
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
