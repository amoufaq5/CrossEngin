import type { ReactElement } from "react";

import { titleCase } from "@/lib/format";
import type { RoleWarning, RoleWarnings as RoleWarningsValue } from "@/lib/users";

/**
 * What a write said about the roles it just accepted, on the one surface whose whole purpose is
 * that the warning is seen.
 *
 * Shared by the provision form and a tenant's grant form rather than spelled twice, because the
 * thing being shared is not the layout — it is the **distinction** between the two verdicts, which
 * is exactly the pair that must not come to be rendered identically. Two copies would be the one
 * place they could drift, and the drift would be silent: both would still render a banner.
 *
 * The three states are three sentences and never two:
 *
 * - `not_declared` — the manifest was read and this name is not in it, so the grant resolves to
 *   nothing at serve time. A **fact about the role**, and the one verdict with a remedy — but only
 *   in the `primary` position; see the gate below, which is not cosmetic.
 * - `unresolved` — nothing could be read, so this says nothing whatever about the role. A fact
 *   about the **deployment**, and weaker in both colour and wording for that reason.
 * - `null` — the response carried no readable answer at all (a binary from before the fence, or a
 *   list this reader could not parse). Weakest of the three, and said rather than left silent:
 *   rendering it as "no warnings" would claim a check that did not happen (ADR-0331).
 *
 * The margin is on the root and not at the call sites, which is what makes the empty case cost
 * nothing: there is no element to space, because there is no element. Both of its neighbours carry
 * their own `mt-4`/`mb-4` in ordinary block flow, so these collapse with them to one gap rather
 * than stacking.
 */
export function RoleWarnings({ warnings }: { warnings: RoleWarningsValue }): ReactElement | null {
  // The empty list is the only silent state. `null` is not one of them — see above.
  if (warnings !== null && warnings.length === 0) return null;
  return (
    <div className="my-4 space-y-3">
      {warnings === null ? <UnreadableAnswer /> : <Verdicts warnings={warnings} />}
    </div>
  );
}

function UnreadableAnswer(): ReactElement {
  return (
    <div className="rounded-lg border border-line bg-surface-soft px-4 py-3 text-sm text-ink-muted">
      <p>
        This deployment did not say whether the roles are declared. Nothing is wrong with the write
        — it is this answer that could not be read, so the roles are unchecked rather than checked
        and clean.
      </p>
    </div>
  );
}

function Verdicts({ warnings }: { warnings: ReadonlyArray<RoleWarning> }): ReactElement {
  const undeclared = warnings.filter((w) => w.verdict === "not_declared");
  const unresolved = warnings.filter((w) => w.verdict === "unresolved");
  const primaryUndeclared = undeclared.some((w) => w.position === "primary");
  // One directory read of one tenant produces every warning in a response, so these lists are one
  // list; the union is deduplicated rather than taking the first so that nothing is dropped if that
  // ever stops being true. The `?? []` is reachable by the *type* and not by a parsed value, since
  // `readRoleWarning` refuses a `not_declared` carrying no catalog — which is what lets the empty
  // union below be read as "the manifest declares nothing" rather than as "nobody looked".
  const declared = [...new Set(undeclared.flatMap((w) => w.declaredRoles ?? []))].sort();

  return (
    <>
      {undeclared.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold text-amber-900">
            {undeclared.length === 1
              ? "One role is not declared by this tenant's manifest."
              : `${undeclared.length} roles are not declared by this tenant's manifest.`}
          </p>
          <ul className="mt-2 space-y-1">
            {undeclared.map((w) => (
              <li key={warningKey(w)} className="flex gap-2 text-xs">
                <span aria-hidden className="text-amber-500">
                  •
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-mono font-semibold">{w.role}</span>{" "}
                  <span className="text-amber-700">({titleCase(w.position)})</span> — {w.detail}
                </span>
              </li>
            ))}
          </ul>
          {/*
            Gated on the position, and that gate is the whole of this block rather than a nicety.
            The consequence genuinely differs — an undeclared *primary* role leaves the person able
            to sign in and nothing else, where an undeclared secondary fails to add anything to a
            primary that still works — and a secondary role reaches no authorization decision
            whatever it is set to, since the mint stamps the primary alone and `principalRoles`
            returns one scope. So offering the catalog beside a secondary-only warning promises that
            re-granting with a declared name buys something, which is the one thing measurement says
            it does not (ADR-0334: a remedy that cannot work is worse than none). The server's own
            `detail` withholds the names from a secondary warning for exactly that reason, while
            `declaredRoles` arrives on both — so rendering it ungated would reinstate here precisely
            what that sentence refuses to say.
          */}
          {primaryUndeclared &&
            (declared.length > 0 ? (
              <div className="mt-2">
                <p className="text-xs font-medium">
                  A primary role the manifest does not declare grants nothing: this person can sign
                  in and every request is then refused. Change the membership&rsquo;s primary role
                  to one of the names below.
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {declared.map((role) => (
                    <span key={role} className="chip font-mono">
                      {role}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              // No names to offer, so none are promised: the sentence above would point at an empty
              // list. And the thing the empty catalog denies is authorization and not acceptance —
              // the grant lands and is stored either way.
              <p className="mt-2 text-xs font-medium">
                A primary role the manifest does not declare grants nothing: this person can sign in
                and every request is then refused. This tenant&rsquo;s manifest declares no roles at
                all, so no name would have made this membership authorize anything.
              </p>
            ))}
        </div>
      )}

      {unresolved.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-soft px-4 py-3 text-sm text-ink-muted">
          <p className="font-medium text-ink">
            {unresolved.length === 1
              ? "One role could not be checked."
              : `${unresolved.length} roles could not be checked.`}
          </p>
          <ul className="mt-2 space-y-1">
            {unresolved.map((w) => (
              <li key={warningKey(w)} className="flex gap-2 text-xs">
                <span aria-hidden className="text-ink-faint">
                  •
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-mono font-semibold text-ink">{w.role}</span>{" "}
                  <span className="text-ink-faint">({titleCase(w.position)})</span> — {w.detail}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            This is a statement about the deployment and not about the role: the manifest this
            tenant is served could not be read, so the name may well be correct. The grant itself
            landed either way.
          </p>
        </div>
      )}
    </>
  );
}

/** Position and role, which is the pair a warning is about, so one role in both positions is two. */
function warningKey(w: RoleWarning): string {
  return `${w.position}:${w.role}`;
}
