"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { Badge } from "@/components/Badge";
import { RoleWarnings } from "@/components/RoleWarnings";
import { Topbar } from "@/components/Topbar";
import { formatCell, titleCase } from "@/lib/format";
import {
  fetchUserCounts,
  listUsers,
  PlatformError,
  provisionUser,
  USER_STATUS_TRANSITIONS,
  USER_STATUSES,
  type PlatformUser,
  type ProvisionUserResult,
  type UserCounts,
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

export default function PlatformUsersPage(): ReactElement {
  const [users, setUsers] = useState<ReadonlyArray<PlatformUser>>([]);
  const [counts, setCounts] = useState<UserCounts | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("all");
  // Two states and not one. `emailInput` is what is being typed; `emailFilter` is what the list was
  // asked for, and only submitting moves one to the other — because the server's filter is an exact
  // match, so every incomplete address matches nothing and a per-keystroke filter would answer "no
  // such user" about an address still being entered.
  const [emailInput, setEmailInput] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
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
  // The whole result and not a rendered sentence: the id is what an operator needs next, so it has
  // to stay on screen as selectable text rather than flash past in a toast — and the role warnings
  // ride with it rather than in a second state that could outlive the record they are about.
  const [provisioned, setProvisioned] = useState<ProvisionUserResult | null>(null);

  /**
   * Which query the rows on screen are the answer to. Bumped by every `load`, captured by every
   * read, and compared before any read commits a row or a cursor.
   *
   * The cursor reset below closes one of **two** doors and this closes the other, which is why both
   * are here. A registry cursor is `base64url("o:<offset>")`, so one minted under the previous
   * filter decodes perfectly and the server honours it against the new filter's rows — a wrong page
   * under a 200 rather than the 400 the handler answers for a cursor that does not decode, which
   * this client never produces. Resetting stops a *new* "Load more" being offered at the previous
   * query's offset; it does nothing about one that was **already in flight** when the filter
   * changed, whose response appends the previous query's rows to the new query's first page and then
   * overwrites `nextCursor` with the previous query's offset — so the next click asks for a position
   * in a set this caller was never shown. Same wrong page, a different way in, and seconds wide
   * rather than one frame.
   */
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = ++generation.current;
    setBusy(true);
    setError(null);
    setUnmounted(false);
    setNextCursor(null);
    listUsers({ status, email: emailFilter, limit: PAGE_LIMIT })
      .then((page) => {
        if (generation.current !== mine) return;
        setUsers(page.data);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        const d = describeListFailure(e);
        setUnmounted(d.unmounted);
        setError(d.message);
      })
      // Guarded, unlike `loadingMore` below: several loads can overlap, and the table reads this as
      // `busy && users.length === 0` to choose between "Loading…" and the empty state — so a
      // superseded load clearing it answers "No users yet." for a query that has not come back. The
      // newest load always matches, so it is always the one that clears.
      .finally(() => {
        if (generation.current !== mine) return;
        setBusy(false);
      });
  }, [status, emailFilter]);

  useEffect(() => load(), [load]);

  // Swallowed, as the tenant console's census is: the figures are context for the list and a
  // failed read of them must not take the list down. The tiles then show "—", which is a different
  // thing on screen from a zero.
  const loadCounts = useCallback(() => {
    fetchUserCounts()
      .then((c) => setCounts(c))
      .catch(() => undefined);
  }, []);

  // Not folded into `load`: the census is unfiltered, so re-reading it on every filter change would
  // be a second request for an answer that cannot have changed.
  useEffect(() => loadCounts(), [loadCounts]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    // Captured and not bumped: this read extends the query `load` established rather than replacing
    // it, so a `load` that happens while it is in flight must invalidate it and not the reverse.
    const mine = generation.current;
    setLoadingMore(true);
    listUsers({ status, email: emailFilter, limit: PAGE_LIMIT, cursor: nextCursor })
      .then((page) => {
        if (generation.current !== mine) return;
        setUsers((prev) => [...prev, ...page.data]);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setError(describeListFailure(e).message);
      })
      // Unconditional, and that is not an oversight: the button is disabled while this is set, so
      // only one of these can be in flight and nobody else's request can clear it. Guarding it the
      // way `busy` is guarded would leave an abandoned page-two read with the button disabled for
      // the rest of the session.
      .finally(() => setLoadingMore(false));
  }, [status, emailFilter, nextCursor]);

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
      // The census moved by one, and this is the page that moved it — a stale total right after a
      // provision is visibly wrong in a way a stale total on arrival is not.
      loadCounts();
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

        {/* The per-status tiles are derived from `USER_STATUSES` for `STATUS_FILTERS`' reason one
            declaration over, and the measurement is next door rather than hypothetical: the tenant
            console writes its five tiles out and `TenantCounts` names four statuses against
            `TENANT_STATUSES`' five, so there is no `pending_deletion` tile. Identical output today —
            Total, Active, Suspended, Deleted — and the accent names `active` rather than a position,
            because what it marks is the figure that means the registry is being used. */}
        <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Total users" value={counts ? counts.total : null} accent />
          {USER_STATUSES.map((s) => (
            <Stat
              key={s}
              label={titleCase(s)}
              value={counts ? counts[s] : null}
              accent={s === "active"}
            />
          ))}
        </section>

        {provisioned && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <p className="font-medium">Provisioned {provisioned.user.email}.</p>
                <p className="mt-1.5">
                  Principal id{" "}
                  <span className="select-all font-mono text-sm">{provisioned.user.id}</span>
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

        {/* Rendered here and **dormant from this form**, which is worth stating rather than letting
            the next reader infer either way. The provision route checks roles exactly when the body
            carries a membership, and this form sends none — access inside a tenant is a separate
            grant, made from that tenant's page — so the server answers `[]` and this renders
            nothing. It is wired anyway so that a provision form which later grows a membership
            block cannot ship the check without its display, which is the forget-to-wire half of the
            class the fence was added for. The live surface is the Members panel on a tenant. */}
        {provisioned && <RoleWarnings warnings={provisioned.roleWarnings} />}

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
          <form
            // A form and not an onChange, so Enter submits: the filter is an exact address, so it
            // is only ever meaningful once the whole of one has been typed.
            onSubmit={(e) => {
              e.preventDefault();
              setEmailFilter(emailInput.trim());
            }}
            className="flex items-center gap-2"
          >
            <label htmlFor="user-email-filter" className="sr-only">
              Filter by email address
            </label>
            <input
              id="user-email-filter"
              type="email"
              className="field w-64"
              autoComplete="off"
              placeholder="Exact email address"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
            />
            <button
              type="submit"
              className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft"
            >
              Find
            </button>
            {emailFilter !== "" && (
              <button
                type="button"
                onClick={() => {
                  setEmailInput("");
                  setEmailFilter("");
                }}
                className="rounded-lg px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-soft"
              >
                Clear
              </button>
            )}
          </form>
          <button
            onClick={() => {
              load();
              loadCounts();
            }}
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
                    {/* The email filter leads, because when one is applied it is the whole cause of
                        an empty answer and it is exact: "no users with status active" over a typo'd
                        address would be a sentence about the status for a result the status had
                        nothing to do with. */}
                    {emailFilter !== "" ? (
                      <>
                        <p className="text-sm font-medium text-ink-muted">
                          No user holds <span className="font-mono">{emailFilter}</span>
                          {status === "all" ? "" : ` with status “${status}”`}.
                        </p>
                        <p className="mx-auto mt-1.5 max-w-lg text-xs text-ink-faint">
                          The match is on the whole address, not a prefix — so a partial or mistyped
                          one finds nothing rather than narrowing. Case does not matter: addresses
                          are folded to lower case before they are compared.
                        </p>
                      </>
                    ) : status === "all" ? (
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
          The email filter is applied by the registry and not to the rows on screen, so it reaches
          every user rather than only the loaded ones. It matches a{" "}
          <span className="font-medium">whole address</span>, because equality is what{" "}
          <span className="font-mono">users_email_key</span> serves: a prefix or substring search
          could not use that index and would be a scan of the table with a comparison per row. Page
          through to browse, or paste an address to go straight to one.
        </p>
      </div>
    </>
  );
}

/**
 * A sixth page-local copy, which is this tree's idiom for a stat tile rather than a lapse — the
 * tenant console, the design reviews, the launchpad, the setup wizard and the WHT report each hold
 * one, and two of those five already carry this exact signature. Nothing here can drift into a
 * wrong answer: the only decision it carries is that an unread figure renders as an em dash and
 * not as a zero, and that is the decision `counts === null` exists to make.
 */
function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | null;
  accent?: boolean;
}): ReactElement {
  return (
    <div className={`card p-4 ${accent ? "ring-1 ring-brand/20" : ""}`}>
      <div className={`text-2xl font-black ${accent ? "text-brand" : "text-ink"}`}>
        {value === null ? "—" : value.toLocaleString()}
      </div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}
