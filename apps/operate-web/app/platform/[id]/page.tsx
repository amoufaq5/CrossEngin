"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Badge } from "@/components/Badge";
import { RoleWarnings } from "@/components/RoleWarnings";
import { Topbar } from "@/components/Topbar";
import { formatCell, titleCase } from "@/lib/format";
import {
  getTenant,
  PlatformError,
  setTenantStatus,
  type Tenant,
  type TenantAction,
} from "@/lib/platform";
import {
  grantMembership,
  listMembers,
  MEMBERSHIP_ACTION_TARGET,
  MEMBERSHIP_STATUS_TRANSITIONS,
  MEMBERSHIP_STATUSES,
  setMembershipStatus,
  type GrantMembershipBody,
  type Membership,
  type MembershipAction,
  type MembershipStatus,
  type RoleWarnings as RoleWarningsValue,
} from "@/lib/users";

const FIELDS: ReadonlyArray<{ key: keyof Tenant; label: string; kind?: "date" }> = [
  { key: "slug", label: "Slug" },
  { key: "name", label: "Name" },
  { key: "tier", label: "Tier" },
  { key: "region", label: "Region" },
  { key: "schemaName", label: "Schema name" },
  { key: "searchLocale", label: "Search locale" },
  { key: "id", label: "Tenant ID" },
  { key: "createdAt", label: "Created", kind: "date" },
  { key: "updatedAt", label: "Updated", kind: "date" },
];

// A total map, so a third `MembershipAction` is a compile error here rather than a row with a
// button that says nothing. The order is separate because it is a presentation choice.
const MEMBERSHIP_ACTION_LABELS: Readonly<
  Record<MembershipAction, { readonly idle: string; readonly busy: string; readonly done: string }>
> = Object.freeze({
  activate: { idle: "Activate", busy: "Activating…", done: "activated" },
  revoke: { idle: "Revoke", busy: "Revoking…", done: "revoked" },
});

const MEMBERSHIP_ACTION_ORDER: ReadonlyArray<MembershipAction> = ["activate", "revoke"];

/**
 * Read off the transition map rather than decided here, which is what keeps `revoked -> active`
 * offered: revoking is not terminal, because the unique key is `(user_id, tenant_id)` so there is
 * one row per membership and restoring re-grants that same row rather than making a second.
 */
function actionsFor(status: MembershipStatus): ReadonlyArray<MembershipAction> {
  return MEMBERSHIP_ACTION_ORDER.filter((a) =>
    MEMBERSHIP_STATUS_TRANSITIONS[status].includes(MEMBERSHIP_ACTION_TARGET[a]),
  );
}

const MEMBER_PAGE_LIMIT = 50;

/**
 * Deliberately laxer than the server's `z.string().uuid()`, so it can never refuse an id the grant
 * route would accept — the server stays authoritative. It exists at all because that route's 400
 * carries `parsed.error.issues`, an array rather than a sentence, so `throwProblem` falls through
 * to the raw body and an operator who mistyped an id would be shown a zod dump.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guarded by the enum rather than cast, so a tampered option value cannot reach the body. */
function asMembershipStatus(value: string): MembershipStatus | "" {
  return (MEMBERSHIP_STATUSES as readonly string[]).includes(value)
    ? (value as MembershipStatus)
    : "";
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A 404 listing members cannot mean "no such membership" — the path names no user. It means the
 * route family was never mounted, which is a deployment flag and not something to retry.
 */
function describeMemberListFailure(e: unknown): {
  readonly unmounted: boolean;
  readonly message: string;
} {
  if (e instanceof PlatformError) {
    if (e.status === 404) {
      return { unmounted: true, message: "This deployment does not serve the user registry." };
    }
    if (e.status === 403) {
      return {
        unmounted: false,
        message:
          "Your role does not grant the user registry. It is gated separately from tenant " +
          "administration, so the grant that let you open this tenant does not reach its members " +
          "(--platform-user-role).",
      };
    }
  }
  return { unmounted: false, message: messageOf(e) };
}

/**
 * No `illegal_transition` branch: a grant creates a row rather than moving one, so that 409 is not
 * reachable here. The duplicate is, and it is the one worth naming — the unique key is
 * `(user_id, tenant_id)`, so re-granting an existing membership is a conflict and not a second row.
 */
function describeGrantFailure(e: unknown): string {
  if (!(e instanceof PlatformError)) return messageOf(e);
  switch (e.status) {
    case 409:
      return (
        "This user already holds a membership in this tenant — there is one row per user per " +
        "tenant, so a second grant is a conflict rather than a second role. Change the existing " +
        "row instead; a revoked membership is restored with Activate."
      );
    case 422:
      return (
        "The registry has never heard of that id. A membership is the join between a user and a " +
        "tenant, so this means no meta.users row holds the id you pasted (or this tenant's own " +
        "row has gone away). Provision the user first, from /platform/users."
      );
    case 400:
      // The server's detail is a zod issue array, so it is described rather than shown.
      return (
        "The registry rejected these details. The user id must be a uuid, and a role must not be " +
        "empty."
      );
    case 403:
      return "Your role does not grant membership administration (--platform-user-role).";
    case 404:
      return "This deployment does not serve the user registry (--platform-user-routes).";
    case 503:
      return (
        "The grant could not be recorded, so it was refused rather than performed unaudited. " +
        "Nothing was written, and this is retryable."
      );
    default:
      return e.message;
  }
}

/**
 * The server answers two different 409s here — `illegal_transition` when the move was never legal
 * from the stored status, and `status_changed` when the row moved between its read and its write
 * — and they are deliberately **not** split. Buttons are offered only where the transition allows
 * one, so either 409 says the same thing: the status on screen is not the stored one. Two sentences
 * claiming different remedies would be inventing a distinction the operator cannot act on.
 */
function describeMembershipActionFailure(e: unknown, action: MembershipAction): string {
  if (!(e instanceof PlatformError)) return messageOf(e);
  switch (e.status) {
    case 409:
      return (
        "This membership is no longer in the state shown here, so the change was refused rather " +
        `than applied from a state it is not legal from (${e.message}). Refresh the members list.`
      );
    case 404:
      // All ten registry routes mount together, so a row cannot be clickable unless this one is
      // mounted: the only remaining reading is that the membership itself went away.
      return "This membership no longer exists. Refresh the members list.";
    case 403:
      return (
        "Refused: this session holds no role in --platform-user-role, which is the grant " +
        `${action} needs.`
      );
    case 503:
      return (
        "The change could not be recorded, so it was refused rather than applied unaudited. " +
        "Nothing was written, and this is retryable."
      );
    default:
      return e.message;
  }
}

export default function TenantDetailPage({ params }: { params: { id: string } }): ReactElement {
  const { id } = params;
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Which 404 the read answered, and not a boolean: "no row" and "no route" send an operator to
  // different places, and only one of them is about this id. Without --platform-admin-role the
  // gateway's matcher answers its own 404 for every tenant, which a boolean renders as "no tenant
  // found" — a sentence about the id, for a cause the id has nothing to do with. The users console
  // draws the same distinction with the same predicate (`routeNotMounted` there).
  const [absent, setAbsent] = useState<"row" | "route" | null>(null);
  const [acting, setActing] = useState<TenantAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Required by the server and recorded in the tenant's permanent lifecycle trail, so there is no
  // default: every action button stays disabled until an operator has typed one.
  const [reason, setReason] = useState("");

  const [members, setMembers] = useState<ReadonlyArray<Membership>>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [membersBusy, setMembersBusy] = useState(false);
  const [loadingMoreMembers, setLoadingMoreMembers] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [registryUnmounted, setRegistryUnmounted] = useState(false);
  const [memberNotice, setMemberNotice] = useState<string | null>(null);
  // Beside the notice rather than inside its sentence, because the two say different things: the
  // notice is about the write, a warning is about the roles it accepted, and `Activate`/`Revoke`
  // name no role at all. `[]` is the empty state and renders nothing, so it is also what the two
  // actions reset it to — a grant's warnings left standing under "Membership revoked." would be
  // about a role that action never touched.
  const [grantWarnings, setGrantWarnings] = useState<RoleWarningsValue>([]);
  // Keyed `userId:action`, so only the clicked button shows its own progress.
  const [memberActing, setMemberActing] = useState<string | null>(null);

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantPrimaryRole, setGrantPrimaryRole] = useState("");
  const [grantSecondary, setGrantSecondary] = useState("");
  // No default. `invited` promises access and `active` grants it, and only an active membership
  // resolves as a notification recipient — so the choice is the operator's to make, not a value
  // applied to their silence.
  const [grantStatus, setGrantStatus] = useState<MembershipStatus | "">("");
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantFieldErrors, setGrantFieldErrors] = useState<{
    userId?: string;
    primaryRole?: string;
    status?: string;
  }>({});

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    setAbsent(null);
    getTenant(id)
      .then((t) => setTenant(t))
      .catch((e: unknown) => {
        if (e instanceof PlatformError && e.status === 404) {
          // `throwProblem` keeps `detail` over `error`, so the gateway's own
          // `no route for <method> <path>` is what arrives when nothing is mounted.
          setAbsent(e.message.startsWith("no route for ") ? "route" : "row");
        }
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  }, [id]);

  useEffect(() => load(), [load]);

  const loadMembers = useCallback(() => {
    setMembersBusy(true);
    setMembersError(null);
    setRegistryUnmounted(false);
    listMembers(id, { limit: MEMBER_PAGE_LIMIT })
      .then((page) => {
        setMembers(page.data);
        setMemberCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        const d = describeMemberListFailure(e);
        setRegistryUnmounted(d.unmounted);
        setMembersError(d.message);
      })
      .finally(() => setMembersBusy(false));
  }, [id]);

  // Gated on the tenant having loaded, so a 404 for the tenant is not followed by a second failure
  // about its members. A boolean rather than `tenant` itself: the record's identity changes on
  // every lifecycle action, and re-reading the members list is not part of suspending a tenant.
  const tenantLoaded = tenant !== null;
  useEffect(() => {
    if (!tenantLoaded) return;
    loadMembers();
  }, [tenantLoaded, loadMembers]);

  const loadMoreMembers = useCallback(() => {
    if (memberCursor === null) return;
    setLoadingMoreMembers(true);
    listMembers(id, { limit: MEMBER_PAGE_LIMIT, cursor: memberCursor })
      .then((page) => {
        setMembers((prev) => [...prev, ...page.data]);
        setMemberCursor(page.nextCursor);
      })
      .catch((e: unknown) => setMembersError(describeMemberListFailure(e).message))
      .finally(() => setLoadingMoreMembers(false));
  }, [id, memberCursor]);

  async function runMemberAction(member: Membership, action: MembershipAction): Promise<void> {
    setMemberActing(`${member.userId}:${action}`);
    setMembersError(null);
    setMemberNotice(null);
    setGrantWarnings([]);
    try {
      const updated = await setMembershipStatus(id, member.userId, action);
      // Replaced in place rather than reloading: `(userId, tenantId)` is the natural key and this
      // panel is scoped to one tenant, so a reload would only discard the pages already loaded.
      setMembers((prev) => prev.map((m) => (m.userId === updated.userId ? updated : m)));
      setMemberNotice(`Membership ${MEMBERSHIP_ACTION_LABELS[action].done}.`);
    } catch (e) {
      setMembersError(describeMembershipActionFailure(e, action));
    } finally {
      setMemberActing(null);
    }
  }

  async function submitGrant(): Promise<void> {
    const userId = grantUserId.trim();
    const primaryRole = grantPrimaryRole.trim();
    const errs: { userId?: string; primaryRole?: string; status?: string } = {};
    if (userId === "") errs.userId = "A user id is required";
    else if (!UUID_RE.test(userId)) {
      errs.userId = "That is not a uuid — copy the id from /platform/users";
    }
    if (primaryRole === "") errs.primaryRole = "A primary role is required";
    if (grantStatus === "") errs.status = "Choose whether this grants access now or only invites";
    // The unchosen status leads the disjunction so that the body below is typed by this guard
    // rather than by a second check beside it that could drift from it.
    if (grantStatus === "" || errs.userId !== undefined || errs.primaryRole !== undefined) {
      setGrantFieldErrors(errs);
      setGrantError("Please fix the highlighted fields.");
      return;
    }

    setGranting(true);
    setGrantError(null);
    setGrantFieldErrors({});
    setMemberNotice(null);
    setGrantWarnings([]);
    try {
      // Empties are dropped because the server's element schema is `z.string().min(1)`, so a
      // trailing comma would otherwise turn into a 400 carrying a zod issue array.
      const secondaryRoles = grantSecondary
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r !== "");
      const body: GrantMembershipBody =
        secondaryRoles.length === 0
          ? { userId, primaryRole, status: grantStatus }
          : { userId, primaryRole, status: grantStatus, secondaryRoles };
      const granted = await grantMembership(id, body);
      setGrantUserId("");
      setGrantPrimaryRole("");
      setGrantSecondary("");
      setGrantStatus("");
      setGrantOpen(false);
      setMemberNotice(
        `Granted ${granted.membership.primaryRole} to ${granted.membership.userId} as ` +
          `${granted.membership.status}.`,
      );
      // Beside the success notice and not instead of it: the grant landed either way, because the
      // fence reports and never refuses — under per-tenant manifests a role this deployment cannot
      // see may be one the tenant's own manifest declares.
      setGrantWarnings(granted.roleWarnings);
      loadMembers();
    } catch (e) {
      setGrantError(describeGrantFailure(e));
    } finally {
      setGranting(false);
    }
  }

  async function runAction(action: TenantAction) {
    const trimmed = reason.trim();
    if (trimmed === "") return;
    if (action === "archive") {
      if (!confirm("Archive this tenant? Its workspace becomes inaccessible until reactivated.")) return;
    }
    setActing(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await setTenantStatus(id, action, trimmed);
      setTenant(updated);
      setReason("");
      setNotice(`Tenant ${action === "reactivate" ? "reactivated" : `${action}d`}.`);
    } catch (e) {
      if (e instanceof PlatformError && e.status === 409) {
        // Illegal transition for the current status — explain rather than fail loudly.
        setError(e.message || `Cannot ${action} a tenant in its current state.`);
      } else if (e instanceof PlatformError && e.status === 404) {
        setError("This tenant no longer exists.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setActing(null);
    }
  }

  const status = tenant?.status;
  const canSuspend = status === "active";
  const canReactivate = status === "suspended";
  const canArchive = status === "active" || status === "suspended";
  const hasActions = canSuspend || canReactivate || canArchive;
  const reasonGiven = reason.trim() !== "";

  return (
    <>
      <Topbar title="Tenant" subtitle={tenant?.name ?? id} />
      <div className="px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/platform" className="text-sm text-ink-muted hover:text-ink">
            ← Platform
          </Link>
          {tenant && <Badge value={tenant.status} />}
        </div>

        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
            {error}
          </div>
        )}

        {busy && tenant === null ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : absent !== null ? (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            {absent === "route" ? (
              <>
                This deployment serves no tenant registry, so there is nothing to show here. It
                arrives with <span className="font-mono">--platform-admin</span> and{" "}
                <span className="font-mono">--platform-admin-role</span> on the API — a deployment
                flag rather than anything about this id.
              </>
            ) : (
              <>No tenant found for this id.</>
            )}
          </div>
        ) : tenant === null ? (
          <p className="text-sm text-ink-muted">Not found.</p>
        ) : (
          <>
            {hasActions && (
              <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Actions</span>
                <input
                  aria-label="Reason for this change"
                  className="field w-72"
                  maxLength={500}
                  placeholder="Reason (required, recorded permanently)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={acting !== null}
                />
                {canSuspend && (
                  <button
                    onClick={() => void runAction("suspend")}
                    disabled={acting !== null || !reasonGiven}
                    className="rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
                  >
                    {acting === "suspend" ? "Suspending…" : "Suspend"}
                  </button>
                )}
                {canReactivate && (
                  <button
                    onClick={() => void runAction("reactivate")}
                    disabled={acting !== null || !reasonGiven}
                    className="rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                  >
                    {acting === "reactivate" ? "Reactivating…" : "Reactivate"}
                  </button>
                )}
                {canArchive && (
                  <button
                    onClick={() => void runAction("archive")}
                    disabled={acting !== null || !reasonGiven}
                    className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                  >
                    {acting === "archive" ? "Archiving…" : "Archive"}
                  </button>
                )}
              </div>
            )}

            <div className="rounded-xl border border-line bg-white p-6">
              <dl className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
                {FIELDS.map((f) => (
                  <div key={f.key}>
                    <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      {f.label}
                    </dt>
                    <dd>
                      {f.key === "id" || f.key === "schemaName" ? (
                        <span className="font-mono text-sm text-ink">{String(tenant[f.key])}</span>
                      ) : (
                        <span className="text-ink">{formatCell(tenant[f.key], f.kind)}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="mt-5 rounded-xl border border-line bg-white p-6">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex-1">
                  <h2 className="text-sm font-bold tracking-tight text-ink">Members</h2>
                  <p className="mt-1 text-sm text-ink-muted">
                    Who holds access inside this tenant, and with which role. Memberships are
                    reached from the tenant because that is the scope they belong to — there is no
                    read that lists one user&rsquo;s memberships across tenants.
                  </p>
                </div>
                <button
                  onClick={loadMembers}
                  disabled={membersBusy || registryUnmounted}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
                >
                  {membersBusy ? "Loading…" : "Refresh"}
                </button>
                <button
                  onClick={() => {
                    setGrantOpen((open) => !open);
                    setGrantError(null);
                    setGrantFieldErrors({});
                  }}
                  aria-expanded={grantOpen}
                  disabled={registryUnmounted}
                  className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {grantOpen ? "Cancel" : "Grant membership"}
                </button>
              </div>

              {memberNotice && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
                  {memberNotice}
                </div>
              )}
              {/* Under the success notice and above the error slot, because it is neither: the
                  grant succeeded and the roles it accepted may still grant nothing. */}
              <RoleWarnings warnings={grantWarnings} />
              {membersError && (
                <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                  {membersError}
                  {registryUnmounted && (
                    <span>
                      {" "}
                      Start <span className="font-mono">operate-server</span> with{" "}
                      <span className="font-mono">--platform-user-routes</span> and{" "}
                      <span className="font-mono">--platform-user-role</span>.
                    </span>
                  )}
                </div>
              )}

              {grantOpen && (
                <div className="mt-4 rounded-xl border border-line bg-surface-soft p-5">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label htmlFor="grant-user-id" className="label">
                        User ID <span className="text-brand-600">*</span>
                      </label>
                      <input
                        id="grant-user-id"
                        className="field font-mono"
                        autoComplete="off"
                        placeholder="Paste from /platform/users"
                        value={grantUserId}
                        disabled={granting}
                        aria-invalid={grantFieldErrors.userId !== undefined}
                        onChange={(e) => {
                          setGrantUserId(e.target.value);
                          setGrantFieldErrors((p) => ({ ...p, userId: undefined }));
                        }}
                      />
                      {grantFieldErrors.userId ? (
                        <p className="mt-1 text-xs text-brand-600">{grantFieldErrors.userId}</p>
                      ) : (
                        <p className="mt-1 text-xs text-ink-faint">
                          The principal id of an existing user.{" "}
                          <Link
                            href="/platform/users"
                            className="font-medium text-ink hover:underline"
                          >
                            Open the registry
                          </Link>{" "}
                          to find or provision one.
                        </p>
                      )}
                    </div>
                    <div>
                      <label htmlFor="grant-status" className="label">
                        Status <span className="text-brand-600">*</span>
                      </label>
                      <select
                        id="grant-status"
                        className="field"
                        value={grantStatus}
                        disabled={granting}
                        aria-invalid={grantFieldErrors.status !== undefined}
                        onChange={(e) => {
                          setGrantStatus(asMembershipStatus(e.target.value));
                          setGrantFieldErrors((p) => ({ ...p, status: undefined }));
                        }}
                      >
                        <option value="" disabled>
                          Choose…
                        </option>
                        {MEMBERSHIP_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {titleCase(s)}
                          </option>
                        ))}
                      </select>
                      {grantFieldErrors.status ? (
                        <p className="mt-1 text-xs text-brand-600">{grantFieldErrors.status}</p>
                      ) : (
                        <p className="mt-1 text-xs text-ink-faint">
                          Nothing is preselected. <span className="font-medium">Invited</span>{" "}
                          promises access and <span className="font-medium">active</span> grants it,
                          and only an active membership resolves as a notification recipient.
                        </p>
                      )}
                    </div>
                    <div>
                      <label htmlFor="grant-primary-role" className="label">
                        Primary role <span className="text-brand-600">*</span>
                      </label>
                      <input
                        id="grant-primary-role"
                        className="field"
                        autoComplete="off"
                        placeholder="erp_admin"
                        value={grantPrimaryRole}
                        disabled={granting}
                        aria-invalid={grantFieldErrors.primaryRole !== undefined}
                        onChange={(e) => {
                          setGrantPrimaryRole(e.target.value);
                          setGrantFieldErrors((p) => ({ ...p, primaryRole: undefined }));
                        }}
                      />
                      {/*
                        The helper text below used to say "Free text, because no route serves the
                        list", and that was FALSE: `GET /v1/meta/schema` is registered with no flag
                        and returns every declared role with its label, and this app already has a
                        cached fetcher for it. What is true is narrower and is why the control is
                        still free text — that route answers for the CALLER'S tenant, and a platform
                        operator administering someone else's tenant would be offered their own
                        roles. Since an activated manifest now merges over the boot pack rather than
                        replacing it (ADR-0368), the caller's set is usually a subset of what is
                        valid here, but "usually" is not a property, and a picker that grows more
                        wrong as per-tenant manifests become more common is the wrong direction. The
                        honest fix is a platform route over the directory `membership-role-fence.ts`
                        already builds, answering for the ADMINISTERED tenant; until then the server
                        answers reactively, below.

                        This comment sits here and not inside the ternary because a parenthesised
                        ternary branch holds exactly ONE expression, so a comment plus a `<p>` there
                        is a syntax error — which `next build` caught and `tsc --noEmit` would not
                        have, since the web app is outside the vitest workspace.
                      */}
                      {grantFieldErrors.primaryRole ? (
                        <p className="mt-1 text-xs text-brand-600">
                          {grantFieldErrors.primaryRole}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs text-ink-faint">
                          Must name a role this tenant&rsquo;s manifest declares. Free text, because
                          the route that serves the list answers for <em>your</em> tenant rather
                          than this one &mdash; but the grant is checked against the right manifest,
                          and a role that is not declared comes back named below, with the ones that
                          are. An undeclared role is still accepted and stored; it grants nothing at
                          serve time.
                        </p>
                      )}
                    </div>
                    <div>
                      <label htmlFor="grant-secondary-roles" className="label">
                        Secondary roles
                      </label>
                      <input
                        id="grant-secondary-roles"
                        className="field"
                        autoComplete="off"
                        placeholder="hr_manager, erp_viewer"
                        value={grantSecondary}
                        disabled={granting}
                        onChange={(e) => setGrantSecondary(e.target.value)}
                      />
                      <p className="mt-1 text-xs text-ink-faint">
                        Optional, comma separated. The same rule applies to each.
                      </p>
                    </div>
                  </div>

                  {grantError && <p className="mt-4 text-sm text-brand-600">{grantError}</p>}

                  <div className="mt-5 flex gap-3">
                    <button
                      onClick={() => void submitGrant()}
                      disabled={granting}
                      className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                    >
                      {granting ? "Granting…" : "Grant"}
                    </button>
                    <button
                      onClick={() => {
                        setGrantOpen(false);
                        setGrantError(null);
                        setGrantFieldErrors({});
                      }}
                      disabled={granting}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-4 overflow-hidden rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-surface-soft text-left text-xs uppercase tracking-wide text-ink-faint">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">User ID</th>
                      <th className="px-4 py-2.5 font-semibold">Primary role</th>
                      <th className="px-4 py-2.5 font-semibold">Secondary roles</th>
                      <th className="px-4 py-2.5 font-semibold">Status</th>
                      <th className="px-4 py-2.5 font-semibold">Created</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {membersBusy && members.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
                          Loading…
                        </td>
                      </tr>
                    )}
                    {!membersBusy && members.length === 0 && membersError === null && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center">
                          <p className="text-sm font-medium text-ink-muted">
                            Nobody holds a membership in this tenant.
                          </p>
                          <p className="mx-auto mt-1.5 max-w-lg text-xs text-ink-faint">
                            A tenant can be provisioned and served with no members — the
                            credentials that reach it are separate — but until someone is granted
                            one, no person can sign in to it and no notification resolves an
                            audience here.
                          </p>
                        </td>
                      </tr>
                    )}
                    {members.map((m) => {
                      const available = actionsFor(m.status);
                      return (
                        <tr key={m.id} className="transition hover:bg-surface-soft/60">
                          <td className="px-4 py-2.5">
                            <Link
                              href={`/platform/users/${encodeURIComponent(m.userId)}`}
                              className="font-mono text-sm font-medium text-brand-600 hover:text-brand-700"
                            >
                              {m.userId}
                            </Link>
                          </td>
                          <td className="px-4 py-2.5 text-ink">{m.primaryRole}</td>
                          <td className="px-4 py-2.5 text-ink-muted">
                            {m.secondaryRoles.length === 0 ? "—" : m.secondaryRoles.join(", ")}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge value={m.status} />
                          </td>
                          <td className="px-4 py-2.5 text-ink-muted">
                            {formatCell(m.createdAt, "date")}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-2">
                              {available.map((a) => (
                                <button
                                  key={a}
                                  onClick={() => void runMemberAction(m, a)}
                                  disabled={memberActing !== null}
                                  className={
                                    a === "activate"
                                      ? "rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                                      : "rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
                                  }
                                >
                                  {memberActing === `${m.userId}:${a}`
                                    ? MEMBERSHIP_ACTION_LABELS[a].busy
                                    : MEMBERSHIP_ACTION_LABELS[a].idle}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <p className="text-xs text-ink-faint">
                  {members.length} shown
                  {memberCursor !== null ? " · more available" : ""}
                </p>
                {memberCursor !== null && (
                  <button
                    onClick={loadMoreMembers}
                    disabled={loadingMoreMembers}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-surface-soft disabled:opacity-60"
                  >
                    {loadingMoreMembers ? "Loading…" : "Load more"}
                  </button>
                )}
              </div>

              <p className="mt-4 max-w-2xl text-xs text-ink-faint">
                Revoking is not the end of a membership: there is one row per user per tenant, so a
                revoked membership is restored with Activate rather than granted again — and
                granting one that already exists is refused as a conflict.
              </p>
            </div>
          </>
        )}
      </div>
    </>
  );
}
