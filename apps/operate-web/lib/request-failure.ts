// What a page says when a request it needed did not succeed.
//
// Seven pages used to append "Is operate-server running?" to **every** failure, so a tenant user
// opening a page their role does not reach was told the API was down. The proxy already separates
// the one case where that sentence is true — it answers its own 502 `upstream_unreachable` when the
// fetch to operate-server threw — so this reads the status and the error code each `lib/` module
// already carries, and gives the outage hint only where there is no answer from the API at all.

/** The code `app/api/[...path]/route.ts` answers with its 502 when operate-server could not be reached. */
export const UPSTREAM_UNREACHABLE = "upstream_unreachable";

/**
 * Whether a 404's detail is the gateway route matcher's own (`runtime.ts`: `no route for <method>
 * <path>`) rather than a handler's. A route that is not mounted has a deployment cause; a handler's
 * 404 is about a row. The prefix is prose, so a reworded gateway message makes this answer false and
 * the page falls back to the server's own detail — the safe direction.
 */
export function detailNamesNoRoute(detail: string): boolean {
  return detail.startsWith("no route for ");
}

/**
 * `lib/api.ts`'s non-2xx error. `message` keeps the `<status>: <body>` shape it always had, because
 * `parseValidationErrors` and several pages read that prefix; `status`, `code` and `detail` are the
 * same facts parsed once, for a reader that should not have to re-parse prose.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: string;
  constructor(status: number, body: string, message: string = `${status}: ${body}`) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    const problem = problemOf(body);
    this.code = problem.code;
    this.detail = problem.detail ?? (body.trim() !== "" ? body : `Request failed (${status})`);
  }
}

/** The `{error}` code and the best human message of an RFC 9457 / `{error, detail}` body, if it is one. */
function problemOf(text: string): { readonly code: string | null; readonly detail: string | null } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { code: null, detail: null };
  }
  if (typeof doc !== "object" || doc === null) return { code: null, detail: null };
  const code = "error" in doc && typeof doc.error === "string" && doc.error.trim() !== "" ? doc.error : null;
  const detail =
    "detail" in doc && typeof doc.detail === "string" && doc.detail.trim() !== ""
      ? doc.detail
      : "title" in doc && typeof doc.title === "string" && doc.title.trim() !== ""
        ? doc.title
        : "message" in doc && typeof doc.message === "string" && doc.message.trim() !== ""
          ? doc.message
          : code;
  return { code, detail };
}

export const REQUEST_FAILURE_KINDS = [
  "unreachable",
  "malformed_response",
  "role_refused",
  "not_served",
  "refused",
] as const;
export type RequestFailureKind = (typeof REQUEST_FAILURE_KINDS)[number];

export interface RequestFailure {
  readonly kind: RequestFailureKind;
  readonly detail: string;
}

/**
 * Reads a caught error into what is known about it. Every `lib/` error class carries a numeric
 * `status`; `ApiError`, `PlatformError`, `ReviewError` and `DesignError` also carry `code`. Read
 * structurally rather than by class so the four modules need no common base.
 *
 * - **A `SyntaxError` with no status**: a response *did* come back — every `lib/` module checks
 *   `res.ok` before `await res.json()`, so this is a 2xx (or a parseable-status error body read
 *   twice) whose body is not JSON. Telling that reader "is operate-server running?" is the wrong
 *   remedy for the one case where the server demonstrably answered, which is why it has its own
 *   kind (ADR-0478, closing ADR-0418 Q2). Checked before the outage arm and keyed on the class:
 *   `JSON.parse` and `Response.json()` throw `SyntaxError` and nothing else does, while a failed
 *   `fetch` throws `TypeError`, which stays `unreachable`.
 * - **No status** (or status 0, `setup`'s wrapper for a non-HTTP failure): no response came back,
 *   so nothing contradicts an outage. This includes a programming error, which is the cost of having
 *   no better discriminator in the browser.
 * - **502 with `upstream_unreachable`**: the proxy's own answer, the one outage it can prove. A 502
 *   with any other code (the billing portal's provider) is a refusal with its own detail.
 * - **403 with `forbidden`**: every role check reachable from these pages answers that code
 *   (`insufficient role`, `finance role required`, `admin role required`). A 403 without it — the
 *   tenant-status gate's `Workspace unavailable`, an activation's `review_required` — is not about a
 *   role, so it keeps its own detail.
 * - **404 whose detail is the matcher's**: this deployment does not mount the route.
 */
export function classifyRequestFailure(err: unknown): RequestFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SyntaxError && !("status" in err)) {
    return { kind: "malformed_response", detail: message };
  }
  if (!(err instanceof Error) || !("status" in err) || typeof err.status !== "number" || err.status === 0) {
    return { kind: "unreachable", detail: message };
  }
  const status = err.status;
  const code = "code" in err && typeof err.code === "string" ? err.code : null;
  const detail = "detail" in err && typeof err.detail === "string" ? err.detail : message;
  if (status === 502 && code === UPSTREAM_UNREACHABLE) return { kind: "unreachable", detail };
  if (status === 403 && code === "forbidden") return { kind: "role_refused", detail };
  if (status === 404 && detailNamesNoRoute(detail)) return { kind: "not_served", detail };
  return { kind: "refused", detail };
}

const SENTENCE: Readonly<Record<RequestFailureKind, (detail: string) => string>> = {
  unreachable: (detail) => `${trimEnd(detail)}. Is operate-server running?`,
  malformed_response: (detail) =>
    `the API answered, but with a body this page could not read (${trimEnd(detail)}). Reload the page; if it persists, the console and the API may be different versions.`,
  role_refused: (detail) => `your role does not grant this (${trimEnd(detail)}).`,
  not_served: () => "this deployment does not serve it.",
  refused: (detail) => `${trimEnd(detail)}.`,
};

/**
 * The clause a page renders after "Could not load …: ", ending in its own punctuation. A page with a
 * more specific arm (a role panel, a not-mounted sentence of its own) checks `classifyRequestFailure`
 * first and keeps it; this is what is left.
 */
export function requestFailureSentence(err: unknown): string {
  const failure = classifyRequestFailure(err);
  return SENTENCE[failure.kind](failure.detail);
}

function trimEnd(text: string): string {
  return text.trim().replace(/[.!?\s]+$/, "");
}
