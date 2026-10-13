"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/Badge";
import { Topbar } from "@/components/Topbar";
import { formatCell, titleCase } from "@/lib/format";
import {
  listUsers,
  PlatformError,
  provisionUser,
  USER_STATUS_TRANSITIONS,
  USER_STATUSES,
  type PlatformUser,
  type UserStatus,
} from "@/lib/users";

/**
 * Derived from `USER_STATUSES` rather than written out beside it. The tenants list keeps a
 * hand-written copy of the same thing and it went stale: `pending_deletion` was missing, so a
 * tenant awaiting erasure was unfindable — the one state in which an operator most wants to find a
 * row. A fourth user status cannot do that here.
 */
const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  ...USER_STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
];

/**
 * Read off the transition map rather than naming `deleted`, which is what the detail page's action
 * buttons already do — so a status that later loses its last outgoing edge is marked here without
 * this page being edited.
 *
 * The footnote beside the marker also says a password cannot be set for such a status, and the
 * server decides *that* from its own `CREDENTIAL_WRITE_BY_STATUS` rather than from this map. The
 * two agree because that map's stated rule **is** terminality — a password set where nothing can
 * reactivate the user could never be used — so a future terminal status admitting a credential
 * write would have to contradict its own reason, and that sentence would then need its own source.
 */
const TERMINAL_STATUSES: ReadonlySet<UserStatus> = new Set(
  USER_STATUSES.filter((s) => USER_STATUS_TRANSITIONS[s].length === 0),
);

/** `users_phone_e164_check`, so a typo is refused here rather than as a 23514 at the insert. */
const PHONE_E164_RE = /^\+[1-9][0-9]{6,14}$/;

/**
 * Deliberately laxer than the server's `z.string().email()`, so it can never refuse an address the
 * registry would accept — the server stays authoritative. It exists at all because the provision
 * route's 400 carries `parsed.error.issues`, an array rather than a sentence, so `throwProblem`
 * falls through to the raw body and an operator would be shown a zod dump.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PAGE_LIMIT = 50;

/**
 * A 404 on *this* route cannot mean "no such user": the path carries no id. It means the route
 * family was never mounted, which is a deployment flag and not something to retry.
 */
function describeListFailure(e: unknown): { readonly unmounted: boolean; readonly message: string } {
  if (e instanceof PlatformError) {
    if (e.status === 404) {
      return {
        unmounted: true,
        message: "This deployment does not serve the user registry.",
      };
    }
    if (e.status === 403) {
      return {
        unmounted: false,
        message:
          "Your role does not grant the user registry. It is gated separately from tenant " +
          "administration, so a platform admin is not automatically a registry admin " +
          "(--platform-user-role).",
      };
    }
  }
  return { unmounted: false, message: e instanceof Error ? e.message : String(e) };
}

/**
 * No 422 branch: `unknown_principal` is only reachable when the body carries a membership, and this
 * form sends none. A branch that cannot fire would read as coverage it does not provide.
 */
function describeProvisionFailure(e: unknown): string {
  if (!(e instanceof PlatformError)) return e instanceof Error ? e.message : String(e);
  switch (e.status) {
    case 409:
      return (
        "A user already holds that email address. Addresses are folded to lower case, so one " +
        "differing only in case is the same identity."
      );
    case 400:
      // The server's detail is a zod issue array, so it is described rather than shown.
      return (
        "The registry rejected these details. Check the email address, and that a phone number " +
        "is E.164 — a + then 7 to 15 digits."
      );
    case 403:
      return "Your role does not grant provisioning (--platform-user-role).";
    case 404:
      return "This deployment does not serve the user registry (--platform-user-routes).";
    case 503:
      return (
        "Provisioning could not be recorded, so it was refused rather than performed unaudited. " +
        "This is retryable."
      );
    default:
      return e.message;
  }
}

export default function PlatformUsersPage() {
  const [users, setUsers] = useState<ReadonlyArray<PlatformUser>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("all");
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unmounted, setUnmounted] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; phone?: string }>({});
  // The whole record and not a rendered sentence: the id is what an operator needs next, so it has
  // to stay on screen as selectable text rather than flash past in a toast.
  const [provisioned, setProvisioned] = useState<PlatformUser | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    setUnmounted(false);
    listUsers({ status, limit: PAGE_LIMIT })
      .then((page) => {
        setUsers(page.data);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        const d = describeListFailure(e);
        setUnmounted(d.unmounted);
        setError(d.message);
      })
      .finally(() => setBusy(false));
  }, [status]);

  useEffect(() => load(), [load]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    listUsers({ status, limit: PAGE_LIMIT, cursor: nextCursor })
      .then((page) => {
        setUsers((prev) => [...prev, ...page.data]);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => setError(describeListFailure(e).message))
      .finally(() => setLoadingMore(false));
  }, [status, nextCursor]);

  async function submit() {
    const mail = email.trim();
    const name = displayName.trim();
    const tel = phone.trim();
    const errs: { email?: string; phone?: string } = {};
    if (mail === "") errs.email = "An email address is required";
    else if (!EMAIL_RE.test(mail)) errs.email = "That does not look like an email address";
    if (tel !== "" && !PHONE_E164_RE.test(tel)) errs.phone = "E.164: a + then 7 to 15 digits";
    if (errs.email !== undefined || errs.phone !== undefined) {
      setFieldErrors(errs);
      setFormError("Please fix the highlighted fields.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    try {
      // Built up rather than passed with `undefined` holes: the server parses the body `.strict()`,
      // so the shape is worth being explicit about.
      const user: { email: string; displayName?: string; phoneE164?: string } = { email: mail };
      if (name !== "") user.displayName = name;
      if (tel !== "") user.phoneE164 = tel;
      const created = await provisionUser({ user });
      setProvisioned(created);
      setEmail("");
      setDisplayName("");
      setPhone("");
      setFormOpen(false);
      load();
    } catch (e) {
      setFormError(describeProvisionFailure(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Topbar title="Users" subtitle="Platform identity registry · super-admin" />
      <div className="px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/platform" className="text-sm text-ink-muted hover:text-ink">
            ← Platform
          </Link>
        </div>

        {provisioned && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <p className="font-medium">Provisioned {provisioned.email}.</p>
                <p className="mt-1.5">
                  Principal id{" "}
                  <span className="select-all font-mono text-sm">{provisioned.id}</span>
                </p>
                <p className="mt-1.5 text-xs">
                  This is the id an <span className="font-mono">--api-key</span>{" "}
                  <span className="font-mono">key:role:tenant:principal</span> spec names, the id a
                  password is set against, and the id Grant membership asks for on a tenant&apos;s
                  page. It is shown again whenever it is needed — on this user&apos;s own page
                  under <span className="font-medium">User ID</span>, and in a tenant&apos;s members
                  table — so it is here to save a hop, not to be copied down.
                </p>
              </div>
              <button
                onClick={() => setProvisioned(null)}
                className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="Filter by status"
            className="flex items-center gap-1 rounded-lg border border-line bg-white p-1"
          >
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatus(f.value)}
                aria-pressed={status === f.value}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  status === f.value
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:bg-surface-soft hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft"
          >
            Refresh
          </button>
          <button
            onClick={() => {
              setFormOpen((open) => !open);
              setFormError(null);
              setFieldErrors({});
            }}
            aria-expanded={formOpen}
            disabled={unmounted}
            className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {formOpen ? "Cancel" : "Provision a user"}
          </button>
        </div>

        {formOpen && (
          <div className="mb-5 rounded-xl border border-line bg-white p-5">
            <p className="mb-4 text-xs text-ink-faint">
              Creates a <span className="font-mono">meta.users</span> row. Access inside a tenant is
              a separate grant, made from that tenant&apos;s page. A password is set afterwards, from
              this user&apos;s own page.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <label htmlFor="user-email" className="label">
                  Email <span className="text-brand-600">*</span>
                </label>
                <input
                  id="user-email"
                  type="email"
                  className="field"
                  placeholder="ada@example.com"
                  value={email}
                  disabled={submitting}
                  aria-invalid={fieldErrors.email !== undefined}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setFieldErrors((p) => ({ ...p, email: undefined }));
                  }}
                />
                {fieldErrors.email ? (
                  <p className="mt-1 text-xs text-brand-600">{fieldErrors.email}</p>
                ) : (
                  <p className="mt-1 text-xs text-ink-faint">
                    The identity. Folded to lower case before it is stored.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="user-display-name" className="label">
                  Display name
                </label>
                <input
                  id="user-display-name"
                  className="field"
                  placeholder="Ada Lovelace"
                  value={displayName}
                  disabled={submitting}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <p className="mt-1 text-xs text-ink-faint">Optional.</p>
              </div>
              <div>
                <label htmlFor="user-phone" className="label">
                  Phone
                </label>
                <input
                  id="user-phone"
                  className="field"
                  placeholder="+441632960123"
                  value={phone}
                  disabled={submitting}
                  aria-invalid={fieldErrors.phone !== undefined}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setFieldErrors((p) => ({ ...p, phone: undefined }));
                  }}
                />
                {fieldErrors.phone ? (
                  <p className="mt-1 text-xs text-brand-600">{fieldErrors.phone}</p>
                ) : (
                  <p className="mt-1 text-xs text-ink-faint">Optional. E.164, so a leading +.</p>
                )}
              </div>
            </div>

            {formError && <p className="mt-4 text-sm text-brand-600">{formError}</p>}

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => void submit()}
                disabled={submitting}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {submitting ? "Provisioning…" : "Provision"}
              </button>
              <button
                onClick={() => {
                  setFormOpen(false);
                  setFormError(null);
                  setFieldErrors({});
                }}
                disabled={submitting}
                className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {error}
            {unmounted && (
              <span>
                {" "}
                Start <span className="font-mono">operate-server</span> with{" "}
                <span className="font-mono">--platform-user-routes</span> and{" "}
                <span className="font-mono">--platform-user-role</span>.
              </span>
            )}
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface-soft text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Email</th>
                <th className="px-4 py-2.5 font-semibold">Display name</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Last login</th>
                <th className="px-4 py-2.5 font-semibold">Created</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {busy && users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
                    Loading…
                  </td>
                </tr>
              )}
              {!busy && users.length === 0 && error === null && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center">
                    {status === "all" ? (
                      <>
                        <p className="text-sm font-medium text-ink-muted">No users yet.</p>
                        <p className="mx-auto mt-1.5 max-w-lg text-xs text-ink-faint">
                          Provisioning one is how the principal id in an{" "}
                          <span className="font-mono">--api-key key:role:tenant:principal</span>{" "}
                          spec gets a row. Until it has one, the writes that reference it — opening
                          a notification, publishing a workflow definition, running an access
                          review — are refused by a foreign key.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-ink-faint">
                        No users with status &ldquo;{status}&rdquo;.
                      </p>
                    )}
                  </td>
                </tr>
              )}
              {users.map((u) => (
                <tr key={u.id} className="transition hover:bg-surface-soft/60">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/platform/users/${encodeURIComponent(u.id)}`}
                      className="text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      {u.email}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-ink">{u.displayName ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Badge value={u.status} />
                      {TERMINAL_STATUSES.has(u.status) && (
                        <span className="text-xs text-ink-faint">terminal</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">
                    {formatCell(u.lastLoginAt, "date")}
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">{formatCell(u.createdAt, "date")}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/platform/users/${encodeURIComponent(u.id)}`}
                      className="text-sm font-medium text-brand-600 hover:text-brand-700"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <p className="text-xs text-ink-faint">
            {users.length} shown
            {nextCursor !== null ? " · more available" : ""}
          </p>
          {nextCursor !== null && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>

        {/* A legend, so it is shown only when a marked row is on screen rather than explaining a
            marker nobody can see. */}
        {users.some((u) => TERMINAL_STATUSES.has(u.status)) && (
          <p className="mt-4 max-w-2xl text-xs text-ink-faint">
            A status marked <span className="text-ink-muted">terminal</span> has no transition out
            of it: nothing reactivates that identity, and because a password set for it could never
            be used to log in, setting one is refused. The row stays either way — 97 catalogued
            columns reference <span className="font-mono">meta.users</span>, so retiring is how a
            spent identity is said rather than a deletion.
          </p>
        )}

        <p className="mt-4 max-w-2xl text-xs text-ink-faint">
          There is no email filter: the registry list reads{" "}
          <span className="font-mono">status</span> alone, so a search box here could only sift the
          rows already loaded and would look like it had searched the rest. Page through, or open a
          known user by id.
        </p>
      </div>
    </>
  );
}
