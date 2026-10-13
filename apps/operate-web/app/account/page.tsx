"use client";

import Link from "next/link";
import { useState } from "react";

import { Topbar } from "@/components/Topbar";
import { roleLabel, useSchema, viewerRoles } from "@/lib/schema";
import { redirectToLogin } from "@/lib/unauthorized";
import type { PasswordChangeResult } from "@/lib/users";

/**
 * The server enforces this and owns it (`MAX_PASSWORD_LENGTH` in `credential-routes.ts`); this app
 * has no import path to that constant, so the number is restated — `platform/users/[id]` holds the
 * other copy for the same reason. The input is bounded here only to spare a round trip, and there
 * is deliberately **no strength floor** on either side.
 */
const MAX_PASSWORD_LENGTH = 1024;

type ChangeOutcome =
  | { readonly kind: "changed"; readonly result: PasswordChangeResult }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly code: string | null;
      readonly detail: string;
    };

/**
 * Narrowed rather than cast, and the reason is one field: the panel below renders *two opposite
 * sentences* off `sessionsRevoked`, and a body that omits it reads as `false` — "your other
 * sessions are still valid" — which is the right sentence today and silently the wrong one for a
 * deployment that ever starts revoking. A cast would make that a claim about the server on no
 * evidence; the predicate makes the absence an error instead. The rest of this app reads a body
 * through `postJson<T>`, whose type parameter *is* such a cast — tolerable where a missing field
 * renders as a blank, and not here.
 */
function isPasswordChangeResult(value: object): value is PasswordChangeResult {
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.credentialChanged === "boolean" &&
    typeof doc.sessionsRevoked === "boolean" &&
    typeof doc.detail === "string"
  );
}

/**
 * `POST /v1/account/password`, read for its `error` code rather than for its status.
 *
 * This deliberately does not go through `lib/users.ts`'s `changeOwnPassword`, and the reason is the
 * one refusal this page exists to show: **401 is three different facts on this path.** The
 * middleware and the `/api` proxy answer `{error: "unauthenticated"}` when there is no session
 * cookie; the route answers `{error: "current_password_wrong"}` when the session is perfectly good
 * and a *second* authentication failed — which is the distinction `credential-routes.ts` draws in
 * its own words ("what failed is a second authentication and not an authorisation").
 * `throwProblem` reacts to the status alone and keeps `detail` over `error`, so through it a
 * mistyped current password starts a full document load to `/login`, which `middleware.ts` bounces
 * straight back here because the cookie is still valid: a page flash, three cleared inputs, and
 * nothing said. The code is the discriminator and `throwProblem` is the one reader that discards it.
 *
 * A genuine 401 still reaches the shared `redirectToLogin`, so this is a second reader of the body
 * and not a second copy of the reaction.
 */
async function postPasswordChange(
  currentPassword: string,
  newPassword: string,
): Promise<ChangeOutcome> {
  const res = await fetch("/api/v1/account/password", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Left null: a non-JSON body falls to the status-derived sentence below.
  }

  if (res.ok) {
    if (parsed === null || typeof parsed !== "object" || !isPasswordChangeResult(parsed)) {
      throw new Error(`The server answered ${res.status} with a body this page could not read.`);
    }
    return { kind: "changed", result: parsed };
  }

  const doc = (parsed !== null && typeof parsed === "object" ? parsed : {}) as {
    error?: unknown;
    detail?: unknown;
  };
  const code = typeof doc.error === "string" ? doc.error : null;
  const detail =
    typeof doc.detail === "string" && doc.detail.trim() !== ""
      ? doc.detail
      : text.trim() !== ""
        ? text
        : `Request failed (${res.status}).`;

  if (res.status === 401 && code !== "current_password_wrong") {
    redirectToLogin();
  }
  return { kind: "refused", status: res.status, code, detail };
}

/**
 * The sentence a refusal gets where this page can say something the server's `detail` cannot: the
 * remedy, and who holds it. Anything unnamed falls back to that `detail`, which is already a
 * sentence — so this is the set for which a remedy exists rather than a translation of the enum.
 */
const REFUSAL_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  current_password_wrong: "The current password did not match. Nothing was changed.",
  no_current_credential:
    "This account has no password yet, so there is none to change — an operator has to set the " +
    "first one before you can change it yourself.",
  not_a_person:
    "This is a service credential (an API key) rather than a person, so it has no password to " +
    "change. A key is replaced by the deployment that issued it.",
  unrecordable:
    "The change could not be recorded, so it was not made: a password change has to be auditable " +
    "before it lands. Nothing changed — try again.",
  invalid_request: "The server rejected the request. Check both passwords and try again.",
});

function refusalMessage(status: number, code: string | null, detail: string): string {
  const named = code === null ? undefined : REFUSAL_SENTENCE[code];
  if (named !== undefined) return named;
  // A 404 from the gateway's matcher rather than from the route: without `--credential-login` (or
  // on `--store memory`, which that flag refuses) the route is not mounted at all, and the remedy
  // is a deployment flag rather than anything the viewer can do. The users console separates the
  // two 404s the same way.
  if (status === 404 && detail.startsWith("no route for ")) {
    return (
      "This deployment serves no password-change route, so there is nothing to change here. It " +
      "arrives with --credential-login on the API."
    );
  }
  return detail;
}

export default function AccountPage() {
  const { schema, loading, error: schemaError } = useSchema();
  const viewer = schema?.viewer;
  const roles = viewerRoles(schema);
  const secondaryRoles =
    viewer === undefined ? [] : roles.filter((r) => r !== viewer.primaryRole);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [changing, setChanging] = useState(false);
  const [result, setResult] = useState<PasswordChangeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filled = current !== "" && next !== "" && confirm !== "";

  async function submit(): Promise<void> {
    setError(null);
    setResult(null);
    // The server takes two fields, so the third is ours alone to check — and checking it here is
    // what keeps a typo in the confirmation from spending a failed attempt against the lockout.
    if (next !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }
    setChanging(true);
    try {
      const outcome = await postPasswordChange(current, next);
      if (outcome.kind === "refused") {
        setError(refusalMessage(outcome.status, outcome.code, outcome.detail));
        return;
      }
      setResult(outcome.result);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChanging(false);
    }
  }

  return (
    <>
      <Topbar
        title="Your account"
        subtitle={viewer === undefined ? undefined : roleLabel(schema, viewer.primaryRole)}
      />
      <div className="px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/" className="text-sm text-ink-muted hover:text-ink">
            ← Dashboard
          </Link>
        </div>

        <div className="rounded-xl border border-line bg-white p-6">
          <h2 className="text-sm font-bold tracking-tight text-ink">Signed in as</h2>
          {loading ? (
            <p className="mt-2 text-sm text-ink-muted">Loading…</p>
          ) : viewer === undefined ? (
            <p className="mt-2 text-sm text-ink-muted">
              {schemaError ??
                "This deployment’s schema carries no viewer, so the role you signed in with cannot be named here."}
            </p>
          ) : (
            <>
              <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
                <div>
                  <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                    Primary role
                  </dt>
                  <dd>
                    <span className="text-ink">{roleLabel(schema, viewer.primaryRole)}</span>{" "}
                    <span className="font-mono text-sm text-ink-muted">{viewer.primaryRole}</span>
                  </dd>
                </div>
                <div>
                  <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                    Other roles
                  </dt>
                  <dd>
                    {secondaryRoles.length === 0 ? (
                      <span className="text-ink-muted">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {secondaryRoles.map((r) => (
                          <span key={r} className="chip">
                            {roleLabel(schema, r)}
                          </span>
                        ))}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="mt-5 text-xs text-ink-faint">
                Your name and email are not served by <span className="font-mono">UiSchema</span>,
                whose viewer carries a primary role and a role list and no identity — so this page
                can show the role you signed in with and not the person holding it.
              </p>
            </>
          )}
        </div>

        <div className="mt-5 rounded-xl border border-line bg-white p-6">
          <h2 className="text-sm font-bold tracking-tight text-ink">Change password</h2>
          <p className="mt-1 text-sm text-ink-muted">
            This changes <span className="font-medium text-ink">your own</span> password, and the
            current one is what authorises it — so it needs no grant and names no user. An operator
            setting someone else’s uses the other route, which cannot be aimed at the caller.
          </p>

          {result && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              <p className="font-medium">Password changed.</p>
              {/* The server's own sentence, verbatim: it says the existing sessions remain valid,
                  which is the opposite of what a reader assumes a password change does. Rendered
                  rather than paraphrased, and the line below reads the field rather than restating
                  it, so a deployment that ever does revoke sessions says so here without an edit. */}
              <p className="mt-1 text-xs">{result.detail}</p>
              <p className="mt-1 text-xs">
                {result.sessionsRevoked
                  ? "Existing sessions were revoked."
                  : "Existing sessions were not revoked — including any you have open elsewhere. Each stays valid until it expires."}
              </p>
            </div>
          )}
          {error && (
            <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
              {error}
            </div>
          )}

          <div className="mt-4 max-w-md space-y-4">
            <div>
              <label className="label" htmlFor="current-password">
                Current password
              </label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                className="field"
                maxLength={MAX_PASSWORD_LENGTH}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                disabled={changing}
              />
            </div>
            <div>
              <label className="label" htmlFor="new-password">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                className="field"
                maxLength={MAX_PASSWORD_LENGTH}
                value={next}
                onChange={(e) => setNext(e.target.value)}
                disabled={changing}
              />
              <p className="mt-1 text-xs text-ink-faint">
                Any passphrase, up to {MAX_PASSWORD_LENGTH} characters. There is no strength floor.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">
                New password again
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                className="field"
                maxLength={MAX_PASSWORD_LENGTH}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={changing}
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => void submit()}
              disabled={changing || !filled}
              className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {changing ? "Changing…" : "Change password"}
            </button>
            <span className="text-xs text-ink-faint">
              Recorded before it lands, with who and never the value.
            </span>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-line bg-surface-soft p-4 text-sm text-ink-muted">
          There is no “forgot password” here, because this deployment has no mail channel to send a
          reset through. If you cannot sign in, an operator sets a new one from the{" "}
          <Link href="/platform/users" className="font-medium text-ink hover:underline">
            user console
          </Link>{" "}
          or with <span className="font-mono text-xs">operate-server set-credential</span> on the
          API host.
        </div>
      </div>
    </>
  );
}
