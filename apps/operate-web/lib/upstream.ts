// The API's base URL, in one place.
//
// Two server-side modules call operate-server directly — the `/api/[...path]` proxy and the
// login handler — and a second spelling of this expression is exactly the shape that lets one
// of them point somewhere the other does not. Server-only: `OPERATE_API_URL` is not
// `NEXT_PUBLIC_`-prefixed, so it is undefined in the client bundle and the default would be
// silently substituted there.

export const UPSTREAM_BASE_URL: string = (process.env.OPERATE_API_URL ?? "http://localhost:8787").replace(
  /\/+$/,
  "",
);
