"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { Badge } from "@/components/Badge";
import { Topbar } from "@/components/Topbar";
import {
  ACCESS_REQUEST_STATUSES,
  AccessRequestApproveError,
  approveAccessRequest,
  fetchAccessRequestCounts,
  generatePassword,
  listAccessRequests,
  rejectAccessRequest,
  rejectAllPendingAccessRequests,
  type AccessRequest,
  type AccessRequestCounts,
  type AccessRequestStatus,
  type ApproveAccessRequestBody,
  type ApproveAccessRequestResult,
  type ExistingUserRef,
  type StarterChartAnswer,
} from "@/lib/access-requests";
import { formatAge, formatCell, titleCase } from "@/lib/format";
import { describeStarterChart, PlatformError } from "@/lib/platform";
import { classifyRequestFailure, requestFailureSentence } from "@/lib/request-failure";

const PAGE_LIMIT = 50;

/** The server's own rules, checked here so a typo is caught before a round trip. The server decides. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,48}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PASSWORD_HANDOVER =
  "This password is shown once. Send it to the customer over a channel other than the email " +
  "address on the request, and ask them to change it at /account.";

const ATTACH_OWNER_WARNING =
  "Only attach if you have confirmed, outside this request, that the existing account belongs to this " +
  "requester. Anyone can submit a request under someone else's email.";

/**
 * One sentence per approval refusal, keyed on the server's `error` code. A code this table does not
 * name falls through to the shared request-failure sentence, which is what keeps an unknown refusal
 * from being reported as an outage.
 */
function describeApproveFailure(e: unknown): string {
  if (!(e instanceof PlatformError)) return `Approval failed: ${requestFailureSentence(e)}`;
  switch (e.code) {
    case "forbidden":
      return (
        "Approving needs three grants at once — platform-admin, platform-user and credential-admin — " +
        "because it creates a tenant, provisions a user and sets a password."
      );
    case "access_request_not_found":
      return "This request no longer exists. It may have been decided and swept; refresh the list.";
    case "not_pending":
      return "This request was decided by someone else while you were approving it. Nothing was created.";
    case "expired":
      return "This request has expired and can no longer be approved. Reject it, or ask the customer to send a new one.";
    case "slug_required":
      return "The customer named no workspace slug. Enter one.";
    case "slug_reserved":
      return "That slug is reserved. Choose another.";
    case "tenant_exists":
      return "A workspace with that slug already exists. Choose another slug. Nothing was created.";
    case "role_not_declared": {
      const roles = e instanceof AccessRequestApproveError ? e.declaredRoles : null;
      return roles !== null && roles.length > 0
        ? `That role is not one this deployment's manifest declares, so the admin could do nothing. Declared roles: ${roles.join(", ")}.`
        : "That role is not one this deployment's manifest declares, so the admin could do nothing.";
    }
    case "currency_invalid":
      return "A currency is three upper-case letters, such as USD.";
    case "password_invalid":
      return `The password was refused: ${e.message}.`;
    case "password_not_applicable":
      return "An existing user keeps their own password; an approval never replaces it.";
    case "user_not_active":
      return "That email belongs to a user who is not active. Reactivate them from Users first, or use another email.";
    case "existing_owner_unconfirmed":
      return "Attaching an existing user needs your confirmation that the account belongs to this requester. Tick the box and try again.";
    case "membership_exists":
      return "That user is already a member of the new workspace. Nothing was created.";
    case "audit_unavailable":
      return "The approval could not be recorded, so it was refused rather than performed unaudited. This is retryable.";
    case "password_work_unavailable":
      return "The server is busy deriving passwords. Try again in a moment.";
    default:
      return `Approval failed: ${requestFailureSentence(e)}`;
  }
}

function describeListFailure(e: unknown): string {
  const failure = classifyRequestFailure(e);
  if (failure.kind === "not_served") {
    return "This deployment does not serve the access-request queue (--access-request-routes).";
  }
  if (failure.kind === "role_refused") {
    return "Your role does not grant the access-request queue (--platform-admin-role).";
  }
  return `Could not load access requests: ${requestFailureSentence(e)}`;
}

function sinceNow(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : now - at;
}

/** `formatAge` answers "just now" under a minute, which " ago" would turn into "just now ago". */
function askedAgo(ms: number | null): string {
  const age = formatAge(ms);
  return age === "just now" || age === "—" ? age : `${age} ago`;
}

function untilNow(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at - now;
}

export default function AccessRequestsPage(): ReactElement {
  const [status, setStatus] = useState<AccessRequestStatus>("pending");
  const [rows, setRows] = useState<ReadonlyArray<AccessRequest>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<AccessRequestCounts | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<AccessRequest | null>(null);
  const [rejecting, setRejecting] = useState<AccessRequest | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [approved, setApproved] = useState<{ result: ApproveAccessRequestResult; password: string | null } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Which query the rows on screen answer — the users page's guard, for its reason: a "Load more"
  // in flight when the tab changes would otherwise append the previous tab's rows to this one.
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = ++generation.current;
    setBusy(true);
    setError(null);
    setNextCursor(null);
    setNow(Date.now());
    listAccessRequests({ status, limit: PAGE_LIMIT })
      .then((page) => {
        if (generation.current !== mine) return;
        setRows(page.data);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setRows([]);
        setError(describeListFailure(e));
      })
      .finally(() => {
        if (generation.current === mine) setBusy(false);
      });
  }, [status]);

  const loadCounts = useCallback(() => {
    fetchAccessRequestCounts()
      .then((c) => setCounts(c))
      .catch(() => undefined);
  }, []);

  useEffect(() => load(), [load]);
  useEffect(() => loadCounts(), [loadCounts]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    const mine = generation.current;
    setLoadingMore(true);
    listAccessRequests({ status, limit: PAGE_LIMIT, cursor: nextCursor })
      .then((page) => {
        if (generation.current !== mine) return;
        setRows((prev) => [...prev, ...page.data]);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setError(describeListFailure(e));
      })
      .finally(() => setLoadingMore(false));
  }, [status, nextCursor]);

  function refresh(): void {
    load();
    loadCounts();
  }

  return (
    <>
      <Topbar title="Access requests" subtitle="Workspaces customers have asked for · super-admin" />
      <div className="px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/platform" className="text-sm text-ink-muted hover:text-ink">
            ← Platform
          </Link>
        </div>

        {approved !== null && (
          <ApprovedBanner
            result={approved.result}
            password={approved.password}
            onDismiss={() => setApproved(null)}
          />
        )}

        {notice !== null && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            <p className="flex-1">{notice}</p>
            <button
              onClick={() => setNotice(null)}
              className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Filter by status"
            className="flex items-center gap-1 rounded-lg border border-line bg-white p-1"
          >
            {ACCESS_REQUEST_STATUSES.map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={status === s}
                onClick={() => setStatus(s)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  status === s ? "bg-brand text-white" : "text-ink-muted hover:bg-surface-soft hover:text-ink"
                }`}
              >
                {titleCase(s)}
                {counts !== null && <span className="ml-1.5 opacity-80">{counts[s]}</span>}
              </button>
            ))}
          </div>
          <button
            onClick={refresh}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft"
          >
            Refresh
          </button>
          {status === "pending" && (
            <button
              onClick={() => setBulkOpen((o) => !o)}
              aria-expanded={bulkOpen}
              disabled={counts !== null && counts.pending === 0}
              className="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50"
            >
              {bulkOpen ? "Cancel" : "Reject all pending"}
            </button>
          )}
        </div>

        {bulkOpen && status === "pending" && (
          <RejectAllPanel
            pending={counts?.pending ?? null}
            onDone={(n) => {
              setBulkOpen(false);
              setNotice(`Rejected ${n.toString()} pending request${n === 1 ? "" : "s"}.`);
              refresh();
            }}
          />
        )}

        {error !== null && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {busy && rows.length === 0 && <p className="py-8 text-center text-sm text-ink-faint">Loading…</p>}
          {!busy && rows.length === 0 && error === null && (
            <p className="py-10 text-center text-sm text-ink-faint">No {status} requests.</p>
          )}
          {rows.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-ink">{r.companyName}</span>
                    <Badge value={r.status} />
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">
                    {r.contactName} · <span className="font-mono">{r.email}</span>
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    Slug: <span className="font-mono">{r.requestedSlug ?? "— none requested"}</span> · terms v
                    {r.termsVersion} · asked {askedAgo(sinceNow(r.createdAt, now))}
                    {r.status === "pending" && <ExpiresIn expiresAt={r.expiresAt} now={now} />}
                  </p>
                  {r.message !== null && (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-soft px-3 py-2 text-sm text-ink">
                      {r.message}
                    </p>
                  )}
                  {r.status !== "pending" && (
                    <p className="mt-2 text-xs text-ink-faint">
                      Decided {formatCell(r.decidedAt, "date")}
                      {r.decisionReason !== null && <> · reason: {r.decisionReason}</>}
                      {r.approvedTenantId !== null && (
                        <>
                          {" "}·{" "}
                          <Link
                            href={`/platform/${encodeURIComponent(r.approvedTenantId)}`}
                            className="font-medium text-brand-600 hover:text-brand-700"
                          >
                            Open workspace →
                          </Link>
                        </>
                      )}
                    </p>
                  )}
                </div>
                {r.status === "pending" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setRejecting(null);
                        setApproving(approving?.id === r.id ? null : r);
                      }}
                      className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => {
                        setApproving(null);
                        setRejecting(rejecting?.id === r.id ? null : r);
                      }}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>

              {approving?.id === r.id && (
                <ApprovePanel
                  request={r}
                  onCancel={() => setApproving(null)}
                  onApproved={(result, password) => {
                    setApproving(null);
                    setApproved({ result, password });
                    refresh();
                  }}
                />
              )}
              {rejecting?.id === r.id && (
                <RejectPanel
                  request={r}
                  onCancel={() => setRejecting(null)}
                  onRejected={() => {
                    setRejecting(null);
                    setNotice(`Rejected the request from ${r.companyName}.`);
                    refresh();
                  }}
                />
              )}
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <p className="text-xs text-ink-faint">
            {rows.length} shown
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

        <p className="mt-4 max-w-2xl text-xs text-ink-faint">
          Approving creates the workspace, its first admin, that admin&apos;s membership and password,
          and the workspace&apos;s default settings in one transaction, so either all of it exists
          afterwards or none of it does. Nothing is emailed: hand the password to the customer
          yourself. A pending request that nobody decides expires, and decided requests are deleted
          after the deployment&apos;s retention period.
        </p>
      </div>
    </>
  );
}

function ExpiresIn({ expiresAt, now }: { expiresAt: string; now: number }): ReactElement {
  const left = untilNow(expiresAt, now);
  if (left === null) return <></>;
  if (left <= 0) return <span className="text-brand-700"> · expired</span>;
  const age = formatAge(left);
  return <> · expires in {age === "just now" ? "under a minute" : age}</>;
}

function ApprovedBanner({
  result,
  password,
  onDismiss,
}: {
  result: ApproveAccessRequestResult;
  password: string | null;
  onDismiss: () => void;
}): ReactElement {
  return (
    <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <p className="font-medium">
            Created workspace <span className="font-mono">{result.tenant.slug}</span> for{" "}
            <span className="font-mono">{result.user.email}</span>
            {result.attachedExistingUser ? " (an existing user, who keeps their own password)" : ""}.
          </p>
          {password !== null && result.passwordSet && (
            <>
              <p className="mt-2">
                Password: <span className="select-all font-mono">{password}</span>{" "}
                <CopyButton text={password} />
              </p>
              <p className="mt-1 text-xs">{PASSWORD_HANDOVER}</p>
            </>
          )}
          <StarterChartOutcome answer={result.starterChart} />
          <p className="mt-2 text-xs">
            The customer signs in with workspace <span className="font-mono">{result.tenant.slug}</span>.{" "}
            <Link
              href={`/platform/${encodeURIComponent(result.tenant.id)}`}
              className="font-medium text-emerald-800 underline"
            >
              Open the workspace
            </Link>
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * The chart outcome. The report itself is described by `describeStarterChart`, the same reader the
 * workspace's own panel uses, so the two say the same thing about one report. Undefined is a server
 * a build behind, which sends no field: said as unknown rather than guessed, since either guess names
 * the wrong next step.
 */
function StarterChartOutcome({ answer }: { answer: StarterChartAnswer | undefined }): ReactElement {
  if (answer === undefined) {
    return <p className="mt-2">Chart of accounts: the server did not say whether one was created.</p>;
  }
  if (answer.outcome === "not_requested") {
    return <p className="mt-2">No chart of accounts requested; the workspace starts with none.</p>;
  }
  if (answer.outcome === "failed") {
    return (
      <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
        Chart of accounts not finished ({answer.error}). The workspace is approved; accounts already created
        are kept, and Create starter chart of accounts on the workspace&apos;s page finishes it once the cause
        is fixed.
      </p>
    );
  }
  const d = describeStarterChart(answer);
  return (
    <div
      className={
        d.complete ? "mt-2" : "mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800"
      }
    >
      <p>Chart of accounts: {d.headline}</p>
      <p className="mt-1 text-xs">{d.counts}</p>
      {d.details.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {d.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
      className="ml-1 rounded-md border border-line bg-white px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-surface-soft"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ApprovePanel({
  request,
  onCancel,
  onApproved,
}: {
  request: AccessRequest;
  onCancel: () => void;
  onApproved: (result: ApproveAccessRequestResult, password: string | null) => void;
}): ReactElement {
  const [slug, setSlug] = useState(request.requestedSlug ?? "");
  const [name, setName] = useState(request.companyName);
  const [email, setEmail] = useState(request.email);
  const [role, setRole] = useState("");
  const [currency, setCurrency] = useState("");
  const [termsDays, setTermsDays] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server answered 409 `user_exists`: the operator is then asked whether to attach
  // that person instead, which resubmits with no password.
  const [existing, setExisting] = useState<ExistingUserRef | null>(null);
  // Required before an attach is sent: the request's email is whatever the requester typed, so the
  // server will not attach an existing account on the request's word alone (ADR-0464).
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [starterChart, setStarterChart] = useState(true);

  function body(attach: boolean): ApproveAccessRequestBody | string {
    const s = slug.trim();
    const n = name.trim();
    const m = email.trim();
    const r = role.trim();
    const c = currency.trim().toUpperCase();
    const d = termsDays.trim();
    if (s === "") return "Enter a workspace slug.";
    if (!SLUG_RE.test(s)) return "A slug is lower-case letters, digits and hyphens, starting with a letter (2–49 characters).";
    if (n === "") return "Enter the workspace name.";
    if (!EMAIL_RE.test(m)) return "That does not look like an email address.";
    if (/\s/.test(r)) return "A role name has no spaces.";
    if (c !== "" && !CURRENCY_RE.test(c)) return "A currency is three letters, such as USD.";
    if (d !== "" && (!/^\d{1,3}$/.test(d) || Number(d) > 365)) return "Payment terms are a whole number of days, 0 to 365.";
    if (!attach && password === "") return "Generate or enter a first password.";
    if (attach && !ownerConfirmed) return "Confirm that the existing account belongs to this requester before attaching it.";

    // Built up rather than sent with `undefined` holes: the server parses the body `.strict()`, and
    // a field equal to what the request already carries is left for the server to take from it.
    const out: {
      -readonly [K in keyof ApproveAccessRequestBody]: ApproveAccessRequestBody[K];
    } = {};
    if (s !== (request.requestedSlug ?? "")) out.slug = s;
    if (n !== request.companyName) out.name = n;
    if (m.toLowerCase() !== request.email) out.email = m;
    if (r !== "") out.primaryRole = r;
    if (c !== "") out.defaultCurrency = c;
    if (d !== "") out.paymentTermsDays = Number(d);
    if (attach) {
      out.attachExistingUser = true;
      out.confirmedExistingOwner = true;
    } else out.password = password;
    // Absent is the server's yes, and the body is strict, so only the opt-out is sent.
    if (!starterChart) out.starterChart = false;
    return out;
  }

  async function submit(attach: boolean): Promise<void> {
    const built = body(attach);
    if (typeof built === "string") {
      setError(built);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await approveAccessRequest(request.id, built);
      onApproved(result, attach ? null : password);
    } catch (e) {
      if (e instanceof AccessRequestApproveError && e.code === "user_exists" && e.existingUser !== null) {
        setExisting(e.existingUser);
        setOwnerConfirmed(false);
        setError(null);
      } else if (e instanceof PlatformError && e.code === "user_exists") {
        // The race arm: the user appeared between the check and the insert, so the server names no
        // one to attach. Reloading the panel's check is the honest next step.
        setExisting(null);
        setError("A user with that email was created while you were approving. Approve again to be offered to attach them.");
      } else {
        setError(describeApproveFailure(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-white p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label htmlFor={`ap-slug-${request.id}`} className="label">
            Workspace slug <span className="text-brand-600">*</span>
          </label>
          <input
            id={`ap-slug-${request.id}`}
            className="field font-mono"
            value={slug}
            disabled={submitting}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`ap-name-${request.id}`} className="label">
            Workspace name <span className="text-brand-600">*</span>
          </label>
          <input
            id={`ap-name-${request.id}`}
            className="field"
            maxLength={200}
            value={name}
            disabled={submitting}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`ap-email-${request.id}`} className="label">
            Admin email <span className="text-brand-600">*</span>
          </label>
          <input
            id={`ap-email-${request.id}`}
            type="email"
            className="field"
            value={email}
            disabled={submitting}
            onChange={(e) => {
              setEmail(e.target.value);
              setExisting(null);
              setOwnerConfirmed(false);
            }}
          />
        </div>
        <div>
          <label htmlFor={`ap-role-${request.id}`} className="label">
            Role
          </label>
          <input
            id={`ap-role-${request.id}`}
            className="field font-mono"
            placeholder="erp_admin"
            value={role}
            disabled={submitting}
            onChange={(e) => setRole(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">Blank uses the deployment&apos;s default (erp_admin unless configured).</p>
        </div>
        <div>
          <label htmlFor={`ap-currency-${request.id}`} className="label">
            Default currency
          </label>
          <input
            id={`ap-currency-${request.id}`}
            className="field font-mono uppercase"
            placeholder="USD"
            maxLength={3}
            value={currency}
            disabled={submitting}
            onChange={(e) => setCurrency(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">Optional. Three letters.</p>
        </div>
        <div>
          <label htmlFor={`ap-terms-${request.id}`} className="label">
            Payment terms (days)
          </label>
          <input
            id={`ap-terms-${request.id}`}
            inputMode="numeric"
            className="field"
            placeholder="30"
            value={termsDays}
            disabled={submitting}
            onChange={(e) => setTermsDays(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">Optional.</p>
        </div>
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={starterChart}
          disabled={submitting}
          onChange={(e) => setStarterChart(e.target.checked)}
        />
        <span>
          Create a starter chart of accounts
          <span className="block text-xs text-ink-faint">
            21 ledger accounts, with the workspace&apos;s finance account settings pointed at them, so its
            first invoice can post. Untick for a company bringing its own chart.
          </span>
        </span>
      </label>

      {existing === null ? (
        <div className="mt-4">
          <label htmlFor={`ap-password-${request.id}`} className="label">
            First password <span className="text-brand-600">*</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`ap-password-${request.id}`}
              className="field font-mono"
              autoComplete="off"
              spellCheck={false}
              value={password}
              disabled={submitting}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setPassword(generatePassword())}
              disabled={submitting}
              className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft disabled:opacity-60"
            >
              Generate
            </button>
            {password !== "" && <CopyButton text={password} />}
          </div>
          <p className="mt-1 text-xs text-ink-faint">{PASSWORD_HANDOVER}</p>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p>
            This email already has a user (status {existing.status}). Attach that user to the new workspace
            instead? They keep their own password, and none is set.
          </p>
          {existing.status === "active" ? (
            <>
              <p className="mt-2 font-semibold">{ATTACH_OWNER_WARNING}</p>
              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  required
                  checked={ownerConfirmed}
                  disabled={submitting}
                  onChange={(e) => setOwnerConfirmed(e.target.checked)}
                />
                <span>I have confirmed that this existing account belongs to the person who sent this request.</span>
              </label>
            </>
          ) : (
            <p className="mt-2">
              It cannot be attached: the account is {existing.status}, and only an active user can be given a
              workspace. Reactivate them from Users first, or change the email.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {existing.status === "active" && (
              <button
                onClick={() => void submit(true)}
                disabled={submitting || !ownerConfirmed}
                className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {submitting ? "Attaching…" : "Attach and approve"}
              </button>
            )}
            <button
              onClick={() => {
                setExisting(null);
                setOwnerConfirmed(false);
              }}
              disabled={submitting}
              className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
            >
              Change the email instead
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p className="mt-4 text-sm text-brand-600" role="alert">
          {error}
        </p>
      )}

      {existing === null && (
        <div className="mt-4 flex gap-3">
          <button
            onClick={() => void submit(false)}
            disabled={submitting}
            className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {submitting ? "Approving…" : "Approve and create workspace"}
          </button>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function RejectPanel({
  request,
  onCancel,
  onRejected,
}: {
  request: AccessRequest;
  onCancel: () => void;
  onRejected: () => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const r = reason.trim();
    if (r === "") {
      setError("A reason is required. It is recorded with the decision.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await rejectAccessRequest(request.id, r);
      onRejected();
    } catch (e) {
      setError(
        e instanceof PlatformError && e.code === "not_pending"
          ? "This request was already decided."
          : e instanceof PlatformError && e.code === "audit_unavailable"
            ? "The rejection could not be recorded, so it was not performed. This is retryable."
            : `Rejection failed: ${requestFailureSentence(e)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-white p-4">
      <label htmlFor={`rj-reason-${request.id}`} className="label">
        Reason <span className="text-brand-600">*</span>
      </label>
      <input
        id={`rj-reason-${request.id}`}
        className="field"
        maxLength={500}
        value={reason}
        disabled={submitting}
        onChange={(e) => setReason(e.target.value)}
      />
      <p className="mt-1 text-xs text-ink-faint">Recorded with the decision. The customer is not notified.</p>
      {error !== null && (
        <p className="mt-3 text-sm text-brand-600" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-3">
        <button
          onClick={() => void submit()}
          disabled={submitting}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {submitting ? "Rejecting…" : "Reject request"}
        </button>
        <button
          onClick={onCancel}
          disabled={submitting}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function RejectAllPanel({
  pending,
  onDone,
}: {
  pending: number | null;
  onDone: (rejected: number) => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const r = reason.trim();
    if (r === "") {
      setError("A reason is required. It is recorded with every decision.");
      return;
    }
    if (!confirmed) {
      setError("Tick the confirmation first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { rejected } = await rejectAllPendingAccessRequests(r);
      onDone(rejected);
    } catch (e) {
      setError(
        e instanceof PlatformError && e.code === "audit_unavailable"
          ? "The rejection could not be recorded, so nothing was rejected. This is retryable."
          : `Rejection failed: ${requestFailureSentence(e)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mb-5 rounded-xl border border-brand-200 bg-white p-5">
      <p className="text-sm text-ink">
        Rejects every pending request at once
        {pending !== null ? ` (${pending.toString()} at the last count)` : ""} — including any that arrive
        before you submit. Use it to clear a flood, not to decide individual requests.
      </p>
      <label htmlFor="rj-all-reason" className="label mt-4">
        Reason <span className="text-brand-600">*</span>
      </label>
      <input
        id="rj-all-reason"
        className="field"
        maxLength={500}
        value={reason}
        disabled={submitting}
        onChange={(e) => setReason(e.target.value)}
      />
      <label className="mt-3 flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I understand every pending request will be rejected.
      </label>
      {error !== null && (
        <p className="mt-3 text-sm text-brand-600" role="alert">
          {error}
        </p>
      )}
      <button
        onClick={() => void submit()}
        disabled={submitting || !confirmed}
        className="mt-4 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {submitting ? "Rejecting…" : "Reject all pending"}
      </button>
    </div>
  );
}
