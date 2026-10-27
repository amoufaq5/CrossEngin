// The one reaction to a 401 from the API: the session is absent, or the token the cookie
// carried has expired or been rejected, so the browser goes back to the login form carrying
// where it was as the `?next=`.
//
// Every fetch in this app that can meet a 401 reaches here, and it does so through exactly six
// error paths — `checkResponse` in lib/api.ts, one `throwProblem` or `throwDesignError` each in
// lib/platform.ts, lib/design.ts, lib/reviews.ts and lib/notifications.ts, and the inline throw in
// lib/schema.ts — so one call in each is the whole coverage. Nothing is left commented as a gap.
// (`lib/users.ts` imports lib/platform.ts's `throwProblem` rather than spelling a seventh;
// `app/account/page.tsx` reads the problem body itself, because on that one path a 401 is three
// different facts and the shared reaction answers only two of them.)
//
// Deliberately no count of call sites here. This comment used to carry one and it was stale —
// a figure in a comment is volatile by construction, and the content is *which paths exist*,
// which a reader can check against the list above.

import { LOGIN_PATH, NEXT_PARAM, safeNextPath } from "@/lib/session";

let redirecting = false;

/**
 * Sends the browser to the login form.
 *
 * A FULL DOCUMENT LOAD, not `router.push`: `lib/schema.ts`, `lib/reference-cache.ts` and
 * `lib/subscription.ts` each hold a module-level cache with no invalidation, so a client-side
 * navigation would carry the expired principal's entity list, role label, resolved reference
 * labels and subscription banner across the session boundary. A document load is the only
 * invalidation those caches have.
 *
 * Idempotent within a document: a page that fires six requests and gets six 401s starts one
 * navigation, not six competing ones.
 */
export function redirectToLogin(): void {
  if (typeof window === "undefined" || redirecting) return;
  redirecting = true;
  const here = safeNextPath(`${window.location.pathname}${window.location.search}`);
  const url = here === "/" ? LOGIN_PATH : `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(here)}`;
  window.location.href = url;
}

/**
 * Starts that redirect if `res` is a 401, and reports whether it did.
 *
 * The caller still throws afterwards. The navigation is asynchronous, so the request that
 * triggered it must not resolve as a success in the meantime — and a 401 reached outside a
 * browser has to surface as an error rather than silently doing nothing.
 */
export function handleUnauthorized(res: Response): boolean {
  if (res.status !== 401) return false;
  redirectToLogin();
  return true;
}
