// The response headers every page of this app carries, read by next.config.mjs. Plain ESM rather
// than TypeScript because next.config.mjs imports it, and import-free so it can be tested from
// outside this app (packages/testing/src/operate-web.test.ts).

/**
 * The page Content-Security-Policy, measured against the built app rather than assumed.
 *
 * Every page loads its scripts, its one stylesheet and its fonts from `/_next/static` (next/font
 * self-hosts Inter at build time), fetches only `/api` on this origin, and renders no image.
 *
 * `script-src 'unsafe-inline'` is the cost of being nonce-less, and it is stated rather than hidden:
 * every built page carries 7 inline `<script>` tags (the app router's RSC payload), whose contents
 * vary per page and per build, so neither a hash list nor `'self'` alone admits them. A nonce would,
 * and needs every page rendered per request — 15 of this app's pages are prerendered static HTML
 * today. So this policy does not stop an inline script injected into the DOM; what it does stop is
 * every **other** step an injection needs — loading script or a frame from elsewhere (`'self'`),
 * exfiltrating over `fetch`/XHR/beacon/`<img>` (`connect-src`/`img-src 'self'`), posting a form
 * away (`form-action`), re-basing relative URLs (`base-uri`), plugins (`object-src`), and being
 * framed (`frame-ancestors`). `style-src 'unsafe-inline'` because Next's not-found page and any
 * React `style=` rendered on the server are attributes in the HTML.
 *
 * Development adds `'unsafe-eval'` (React Refresh) and `ws:` (the HMR socket), and nothing else.
 */
export function contentSecurityPolicy({ development }) {
  const directives = [
    ["default-src", "'self'"],
    ["script-src", "'self'", "'unsafe-inline'", ...(development ? ["'unsafe-eval'"] : [])],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'"],
    ["font-src", "'self'"],
    ["connect-src", "'self'", ...(development ? ["ws:"] : [])],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/**
 * Every response this app serves, pages and its own `/api` handlers alike.
 *
 * `Referrer-Policy: same-origin` and not the browser default, because the login URL carries
 * `?next=` — a path inside the console — and a page's URL can carry a record id, neither of which
 * is anybody else's business. HSTS only in production, and with no `includeSubDomains`: whether a
 * sibling host is HTTPS-only is not this app's decision to make for the whole domain.
 */
export function securityHeaders({ development }) {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy({ development }) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ];
  if (!development) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  return headers;
}
