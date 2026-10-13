"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Badge } from "@/components/Badge";
import { Topbar } from "@/components/Topbar";
import { formatCell } from "@/lib/format";
import {
  getUser,
  PlatformError,
  setUserCredential,
  setUserStatus,
  USER_ACTION_TARGET,
  USER_STATUS_TRANSITIONS,
  type CredentialSetResult,
  type PlatformUser,
  type UserAction,
} from "@/lib/users";

const FIELDS: ReadonlyArray<{
  readonly key: keyof PlatformUser;
  readonly label: string;
  readonly render?: "date" | "mono" | "badge";
}> = [
  { key: "email", label: "Email" },
  { key: "displayName", label: "Display name" },
  { key: "phoneE164", label: "Phone" },
  { key: "status", label: "Status", render: "badge" },
  { key: "id", label: "User ID", render: "mono" },
  { key: "createdAt", label: "Created", render: "date" },
  { key: "updatedAt", label: "Updated", render: "date" },
  { key: "lastLoginAt", label: "Last login", render: "date" },
];

// The labels are a total map, so a fourth `UserAction` is a compile error here; the order is
// separate because it is a presentation choice — the terminal one last, away from the other two.
// `done` is spelled out rather than derived from `idle`, because no suffix rule covers all three.
const ACTION_LABELS: Readonly<
  Record<UserAction, { readonly idle: string; readonly busy: string; readonly done: string }>
> = Object.freeze({
  suspend: { idle: "Suspend", busy: "Suspending…", done: "suspended" },
  reactivate: { idle: "Reactivate", busy: "Reactivating…", done: "reactivated" },
  retire: { idle: "Retire", busy: "Retiring…", done: "retired" },
});

const ACTION_ORDER: ReadonlyArray<UserAction> = ["suspend", "reactivate", "retire"];

/**
 * The server enforces this and owns it (`MAX_PASSWORD_LENGTH` in `credential-routes.ts`); this app
 * has no import path to that constant, so the number is restated and the input is bounded here only
 * to spare a round trip. There is deliberately **no strength floor** on either side.
 */
const MAX_PASSWORD_LENGTH = 1024;

/**
 * `throwProblem` collapses an RFC 9457 document to its `detail`, so this route's `error:
 * "user_unknown"` key never reaches the page — what is left is the gateway's own
 * `no route for …` detail, and it is the discriminator worth having: a 404 because no
 * `--credential-admin-role` was granted has a deployment remedy, while a 404 because the row went
 * away has none. A message matching neither falls to the second reading, which is the only other
 * 404 this route emits.
 */
function credentialRouteAbsent(message: string): boolean {
  return message.startsWith("no route for ");
}

export default function PlatformUserDetailPage({
  params,
}: {
  params: { id: string };
}): ReactElement {
  const { id } = params;
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [acting, setActing] = useState<UserAction | null>(null);

  const [password, setPassword] = useState("");
  // Deliberately NOT seeded from `id`. The server refuses a mismatch by name precisely so a human
  // reads the id they are about to overwrite a credential for — prefilling it from the same route
  // param would confirm nothing.
  const [confirmId, setConfirmId] = useState("");
  const [settingPassword, setSettingPassword] = useState(false);
  const [credResult, setCredResult] = useState<CredentialSetResult | null>(null);
  const [credError, setCredError] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    setNotFound(false);
    getUser(id)
      .then((u) => setUser(u))
      .catch((e: unknown) => {
        if (e instanceof PlatformError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  }, [id]);

  useEffect(() => load(), [load]);

  async function runAction(action: UserAction): Promise<void> {
    if (action === "retire") {
      const ok = confirm(
        "Retire this identity?\n\nRetired is terminal — nothing moves out of it.\n\nThis does not " +
          "delete the row: 97 catalogued columns reference meta.users, so a user who has acted " +
          "cannot be removed without destroying the record of what they did. Retiring is how a " +
          "spent identity is said.",
      );
      if (!ok) return;
    }
    setActing(action);
    setError(null);
    setNotice(null);
    try {
      const updated = await setUserStatus(id, action);
      setUser(updated);
      setNotice(`User ${ACTION_LABELS[action].done}.`);
    } catch (e) {
      if (e instanceof PlatformError && e.status === 404) {
        setError("This user no longer exists.");
      } else if (e instanceof PlatformError && e.status === 409) {
        setError(
          e.message ||
            `Cannot ${action} a user whose status is ${user?.status ?? "unknown"}; reload to see ` +
              "where it stands now.",
        );
      } else if (e instanceof PlatformError && e.status === 403) {
        setError(
          "Refused: this session holds no role in --platform-user-role, which is the grant these " +
            "status actions need.",
        );
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setActing(null);
    }
  }

  async function submitPassword(): Promise<void> {
    const pw = password;
    const typedId = confirmId.trim();
    if (pw === "" || typedId === "") return;
    setSettingPassword(true);
    setCredError(null);
    setCredResult(null);
    try {
      const result = await setUserCredential(id, pw, typedId);
      setCredResult(result);
      // Cleared on success and never echoed back into any field.
      setPassword("");
      setConfirmId("");
    } catch (e) {
      if (e instanceof PlatformError && e.status === 404) {
        setCredError(
          credentialRouteAbsent(e.message)
            ? "This deployment serves no credential route: --credential-admin-role was not " +
                "granted, so the route is not mounted at all rather than mounted and refusing. " +
                "Grant it to use this panel; until then `operate-server set-credential` from a " +
                "shell on the API container is the path."
            : "There is no meta.users row with this id — which is not the same as retired, since " +
                "a retired identity keeps its row. The page loaded one, so it went away in " +
                "between. Reload to see where it stands.",
        );
      } else if (e instanceof PlatformError && e.status === 403) {
        setCredError(e.message);
      } else if (e instanceof PlatformError && e.status === 503) {
        setCredError(
          `${e.message} Nothing was written — a credential may not change while the change cannot ` +
            "be recorded, so this is worth retrying.",
        );
      } else {
        setCredError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSettingPassword(false);
    }
  }

  const writing = acting !== null || settingPassword;
  const available: ReadonlyArray<UserAction> =
    user === null
      ? []
      : ACTION_ORDER.filter((a) =>
          USER_STATUS_TRANSITIONS[user.status].includes(USER_ACTION_TARGET[a]),
        );
  // Explained from the absence of offers rather than from a status name, so the sentence stays true
  // whichever status the map leaves with nothing reachable.
  const noActions = user !== null && available.length === 0;
  const canSubmitPassword = password !== "" && confirmId.trim() !== "" && !writing;

  return (
    <>
      <Topbar title="User" subtitle={user?.email ?? id} />
      <div className="px-8 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link href="/platform/users" className="text-sm text-ink-muted hover:text-ink">
            ← Users
          </Link>
          {user && <Badge value={user.status} />}
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

        {busy && user === null ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : notFound ? (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            No user found for this id.
          </div>
        ) : user === null ? (
          <p className="text-sm text-ink-muted">Not found.</p>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-4">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Actions
              </span>
              {available.map((action) => (
                <button
                  key={action}
                  onClick={() => void runAction(action)}
                  disabled={writing}
                  className={
                    action === "retire"
                      ? "ml-auto rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                      : action === "reactivate"
                        ? "rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                        : "rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
                  }
                >
                  {acting === action ? ACTION_LABELS[action].busy : ACTION_LABELS[action].idle}
                </button>
              ))}
              {noActions && (
                <span className="text-sm text-ink-muted">
                  No status change is available from here. Nothing deletes the row either way — 97
                  catalogued columns reference meta.users, so retiring is how a spent identity is
                  said.
                </span>
              )}
            </div>

            <div className="rounded-xl border border-line bg-white p-6">
              <dl className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
                {FIELDS.map((f) => (
                  <div key={f.key}>
                    <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      {f.label}
                    </dt>
                    <dd>
                      {f.render === "badge" ? (
                        <Badge value={user.status} />
                      ) : f.render === "mono" ? (
                        <span className="font-mono text-sm text-ink">{formatCell(user[f.key])}</span>
                      ) : (
                        <span className="text-ink">{formatCell(user[f.key], f.render)}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="mt-5 rounded-xl border border-line bg-white p-6">
              <h2 className="text-sm font-bold tracking-tight text-ink">Set password</h2>
              <p className="mt-1 text-sm text-ink-muted">
                This sets <span className="font-medium text-ink">this</span> user&rsquo;s password,
                not yours. It does not ask for their current one, so it cannot be aimed at the
                account you are signed in as — change your own at{" "}
                <Link href="/account" className="font-medium text-ink hover:underline">
                  /account
                </Link>
                , which proves possession instead.
              </p>

              {credResult && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  <p className="font-medium">
                    Password set for {user.email}.
                    {credResult.lockCleared
                      ? " Any failed-attempt lock on this account was cleared."
                      : ""}
                  </p>
                  <p className="mt-1 text-xs">{credResult.detail}</p>
                </div>
              )}
              {credError && (
                <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                  {credError}
                </div>
              )}

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
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
                    placeholder={`Any passphrase, up to ${MAX_PASSWORD_LENGTH} characters`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={writing}
                  />
                  <p className="mt-1 text-xs text-ink-faint">
                    Bounded in length and with no strength floor. Hand it over out of band; it is
                    never shown again here.
                  </p>
                </div>
                <div>
                  <label className="label" htmlFor="confirm-user-id">
                    Confirm User ID
                  </label>
                  <input
                    id="confirm-user-id"
                    type="text"
                    autoComplete="off"
                    className="field font-mono"
                    placeholder="Type the User ID shown above"
                    value={confirmId}
                    onChange={(e) => setConfirmId(e.target.value)}
                    disabled={writing}
                  />
                  <p className="mt-1 text-xs text-ink-faint">
                    Typed, not copied in for you: naming the wrong user locks a real person out and
                    hands their account to whoever chose the password.
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={() => void submitPassword()}
                  disabled={!canSubmitPassword}
                  className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {settingPassword ? "Setting…" : "Set password"}
                </button>
                <span className="text-xs text-ink-faint">
                  Recorded before it lands, with who and whom and never the value.
                </span>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-line bg-surface-soft p-4 text-sm text-ink-muted">
              Memberships are granted and moved from the tenant they belong to, because a membership
              is scoped to a tenant and there is no read that could list one user&rsquo;s across all
              of them —{" "}
              <Link href="/platform" className="font-medium text-ink hover:underline">
                open the tenant
              </Link>{" "}
              and manage its members there.
            </div>
          </>
        )}
      </div>
    </>
  );
}
