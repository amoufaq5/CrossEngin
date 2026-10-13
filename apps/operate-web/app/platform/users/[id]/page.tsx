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
  type UserStatus,
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
 * A 404 the gateway's route matcher produced, rather than one a handler produced.
 *
 * `throwProblem` collapses an RFC 9457 document to its `detail`, so a handler's `error` key never
 * reaches the page — what is left is `runtime.ts`'s own `no route for <method> <path>` detail, and
 * it is the discriminator worth having: a 404 because a flag was not passed has a deployment remedy,
 * while a 404 because the row is not there has none. A message matching neither falls to the
 * handler reading, which is the only other 404 either route emits.
 *
 * **Both readers on this page share it**, and the second one is why it is not named for the
 * credential route any more: `load()` asks for the user and gets this same matcher 404 when
 * `--platform-user-routes` is absent, while the panel gets it when `--credential-admin-role` is. One
 * predicate, two flags — the sentence naming the flag belongs to each reader, because the fact that
 * no route answered is all this can establish.
 */
function routeNotMounted(message: string): boolean {
  return message.startsWith("no route for ");
}

/**
 * One `note` serves both arms because it answers one question — what this status means for setting a
 * password — and the presence of the form is what says whether it is a refusal or a caveat.
 */
interface CredentialWriteRule {
  readonly operatorMay: boolean;
  readonly note: string | null;
}

/**
 * Mirrors `CREDENTIAL_WRITE_BY_STATUS` in `credential-routes.ts`, the operator half only — this is
 * the operator panel, and the self route has `/account`.
 *
 * Total over `UserStatus`, so a fourth status is a compile error here rather than a form that
 * renders for it and a 403 when it is submitted. The split is the server's and is read off the
 * transition map rather than off a status name: `deleted` has no outgoing transition, so a password
 * set there could never be used by anybody and the route refuses `user_not_active`; `suspended`
 * transitions back to `active`, so the write lands and the login stays refused until a reactivation.
 *
 * The note is shown **before** anything is typed, which is the whole of why it is here: a caveat an
 * operator reads after the 200 has already surprised them.
 */
const CREDENTIAL_WRITE_BY_STATUS: Readonly<Record<UserStatus, CredentialWriteRule>> = Object.freeze(
  {
    active: { operatorMay: true, note: null },
    suspended: {
      operatorMay: true,
      note:
        "This user is suspended. The password will be set and logging in stays refused until they " +
        "are reactivated — so this prepares a credential rather than restoring access. Reactivate " +
        "from the actions above when that is what you want.",
    },
    deleted: {
      operatorMay: false,
      note:
        "This user is retired, and retired is terminal — nothing moves out of it, so a password set " +
        "now could never be used by anybody. The server refuses it for that reason, which is why " +
        "there is no form here. Provision a new identity instead.",
    },
  },
);

/**
 * Looked up rather than indexed, because the row's status is a `UserStatus` by annotation and a bare
 * string on the wire: `lib/users.ts` reads the body through a type parameter, so a status a later
 * server writes arrives here named and unrecognised. An unrecognised one takes the refusing arm,
 * which is the arm `asUserStatus` takes on the server for the same reason — offering a form the
 * route would refuse is the defect this gate exists to close, and it does not stop being one because
 * the status is new.
 */
function credentialWriteFor(status: string): CredentialWriteRule {
  const rule: CredentialWriteRule | undefined = Object.hasOwn(CREDENTIAL_WRITE_BY_STATUS, status)
    ? CREDENTIAL_WRITE_BY_STATUS[status as UserStatus]
    : undefined;
  return (
    rule ?? {
      operatorMay: false,
      note:
        `This user's status is "${status}", which this console has no rule for — a newer server ` +
        "wrote it. Nothing is offered here rather than a form whose outcome cannot be stated.",
    }
  );
}

/**
 * A refusal split into the server's own sentence and what this page adds to it.
 *
 * Two tiers rather than one spliced string, because `throwProblem` keeps `detail` over `error`: the
 * server's sentence is the only thing that says *which* refusal this is wherever a status carries
 * several, so it has to stay the lead rather than being paraphrased away. `help` is for the remedy a
 * `detail` cannot carry — a deployment flag, or which of this console's pages holds the other act —
 * and is null where the detail is already the whole answer.
 */
interface CredentialRefusal {
  readonly message: string;
  readonly help: string | null;
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
  // Which 404 the read answered, and not a boolean: "no row" and "no route" have different remedies
  // and only one of them is about this id.
  const [absent, setAbsent] = useState<"row" | "route" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acting, setActing] = useState<UserAction | null>(null);

  const [password, setPassword] = useState("");
  // Deliberately NOT seeded from `id`. The server refuses a mismatch by name precisely so a human
  // reads the id they are about to overwrite a credential for — prefilling it from the same route
  // param would confirm nothing.
  const [confirmId, setConfirmId] = useState("");
  const [settingPassword, setSettingPassword] = useState(false);
  const [credResult, setCredResult] = useState<CredentialSetResult | null>(null);
  const [credError, setCredError] = useState<CredentialRefusal | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    setAbsent(null);
    getUser(id)
      .then((u) => setUser(u))
      .catch((e: unknown) => {
        // The two 404s, through the predicate the credential panel below also reads. Mapping both
        // to "no user found for this id" told an operator their id was wrong on a deployment that
        // simply does not mount the read — a deployment flag reported as a missing row.
        if (e instanceof PlatformError && e.status === 404) {
          setAbsent(routeNotMounted(e.message) ? "route" : "row");
        } else setError(e instanceof Error ? e.message : String(e));
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
        setCredError({
          message: routeNotMounted(e.message)
            ? "This deployment serves no credential route: --credential-admin-role was not " +
              "granted, so the route is not mounted at all rather than mounted and refusing. " +
              "Grant it to use this panel; until then `operate-server set-credential` from a " +
              "shell on the API container is the path."
            : "There is no meta.users row with this id — which is not the same as retired, since " +
              "a retired identity keeps its row. The page loaded one, so it went away in " +
              "between. Reload to see where it stands.",
          help: null,
        });
      } else if (e instanceof PlatformError && e.status === 429) {
        // A 429 is the server asking the caller back rather than refusing the act, and the two
        // things that answer it here want different waits: a rate limit in front of the route, or
        // `account_locked`, which the login writes and lets lapse. This route does not read that
        // lock today — it clears it on success — so the help names both and lets the server's own
        // sentence say which, rather than asserting a lockout an operator would sit and wait out.
        setCredError({
          message: e.message,
          help:
            "Nothing was written. The line above says what to wait for: a rate limit in front of " +
            "this route, or a lock on the account from failed sign-in attempts, which lapses on " +
            "its own. Neither needs a change here — retry in a moment.",
        });
      } else if (e instanceof PlatformError && e.status === 403) {
        // Three refusals share this status — no role in --credential-admin-role, an id naming the
        // caller's own account, and a status that no longer admits a password — and the collapsed
        // problem document carries no `error` key to tell them apart. So the server's sentence
        // leads and the help carries all three remedies rather than guessing: naming one would be
        // a remedy that cannot work for two readers in three.
        setCredError({
          message: e.message,
          help:
            "Nothing was written. Three refusals share this status: the session holds no role in " +
            "--credential-admin-role; the id names the account you are signed in as, which " +
            "changes its own password at /account because that route proves possession; or this " +
            "user's status no longer admits one — reload to see where it stands. The line above " +
            "says which.",
        });
      } else if (e instanceof PlatformError && e.status === 503) {
        setCredError({
          message: e.message,
          help:
            "Nothing was written — a credential may not change while the change cannot be " +
            "recorded, so this is worth retrying.",
        });
      } else {
        setCredError({ message: e instanceof Error ? e.message : String(e), help: null });
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
  const credentialWrite = user === null ? null : credentialWriteFor(user.status);
  // `=== true` and not a truthiness test: the null row and a status the rule refuses both have to
  // disable the submit, and only one of them is a status at all.
  const canSubmitPassword =
    credentialWrite?.operatorMay === true && password !== "" && confirmId.trim() !== "" && !writing;

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
        ) : absent !== null ? (
          <div className="rounded-xl border border-line bg-surface-soft px-4 py-10 text-center text-sm text-ink-muted">
            {absent === "route"
              ? "This deployment serves no platform user routes: --platform-user-routes was not " +
                "passed, so the read this page needs is not mounted at all rather than mounted " +
                "and refusing. Nothing here is about this id until it is."
              : "No user found for this id."}
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
                        <span className="font-mono text-sm text-ink">
                          {formatCell(user[f.key])}
                        </span>
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

              {/* Standing context, so it is read before anything is typed, and above the two
                  transient banners for that reason. */}
              {credentialWrite !== null && credentialWrite.note !== null && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {credentialWrite.note}
                </div>
              )}

              {credResult &&
                /* Amber and not emerald when the login is still refused, because the colour is
                   itself a claim: a success-green banner over a password the login will not accept
                   is a reassuring answer about a credential that does not work yet. Both facts are
                   read off the response and never off the row above — the write re-read the row, so
                   a suspension that landed in another tab is a fact only this answer carries. */
                (credResult.loginBlocked ? (
                  <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <p className="font-semibold">
                      Password set for {user.email}, and logging in is still refused.
                      {credResult.lockCleared
                        ? " Any failed-attempt lock on this account was cleared."
                        : ""}
                    </p>
                    <p className="mt-1 text-xs">{credResult.detail}</p>
                    <p className="mt-1 text-xs">
                      The write saw this user as{" "}
                      <span className="font-medium">{credResult.subjectStatus}</span> — the row as
                      it stood at that moment, and not as this page loaded it. Reactivate from the
                      actions above before the password is any use.
                    </p>
                  </div>
                ) : (
                  <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    <p className="font-medium">
                      Password set for {user.email}.
                      {credResult.lockCleared
                        ? " Any failed-attempt lock on this account was cleared."
                        : ""}
                    </p>
                    <p className="mt-1 text-xs">{credResult.detail}</p>
                  </div>
                ))}
              {credError && (
                <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">
                  <p>{credError.message}</p>
                  {credError.help !== null && <p className="mt-1 text-xs">{credError.help}</p>}
                </div>
              )}

              {/* The form exists exactly where the route would accept it. Rendering it for a status
                  the server refuses is how an operator comes to type a password and an id for a
                  credential that could never be used — the note above says why instead, which is
                  the Actions block's own rule (offer a thing when the transition is legal) read one
                  panel over. */}
              {credentialWrite !== null && credentialWrite.operatorMay && (
                <>
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
                        Bounded in length and with no strength floor. Hand it over out of band; it
                        is never shown again here.
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
                        Typed, not copied in for you: naming the wrong user locks a real person out
                        and hands their account to whoever chose the password.
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
                </>
              )}
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
