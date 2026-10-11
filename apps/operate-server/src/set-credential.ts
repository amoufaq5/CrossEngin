import { hashPassword, parseCredentialPepper } from "@crossengin/crypto";
import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";

import { CREDENTIAL_PEPPER_VAR } from "./credential-auth-env.js";
import { PostgresCredentialStore } from "./credential-store.js";

/**
 * `operate-server set-credential` -- how a deployment's first password gets set.
 *
 * It is a subcommand and not a route because there is **no mail channel**: 14 of the 18 modelled
 * notification providers have no client, and even the four that do are configured per deployment
 * rather than per fresh install -- so the usual "we emailed you a link" bootstrap has nothing to
 * send with. An operator with shell access to the box is the only principal that exists before the
 * first password does.
 *
 * ## The two rules it inherits
 *
 * The password arrives in the **environment** (`OPERATE_NEW_PASSWORD`), never argv: argv is
 * readable by anyone who can run `ps`, which is ADR-0301 and the same rule that put
 * `COLUMN_ENCRYPTION_SECRET` and the api-key specs there.
 *
 * The user id is typed **twice** (`--user` and `--confirm-user`), following `rekey`'s
 * `--confirm-tenant`: this overwrites a credential, so naming the wrong user locks a real person
 * out and hands their account to whoever typed the password. There is deliberately no `--yes`,
 * because a flag meaning "I meant it" can be pasted from a runbook without reading the id, which
 * is the thing being confirmed.
 */

export const NEW_PASSWORD_VAR = "OPERATE_NEW_PASSWORD";

export interface SetCredentialOptions {
  readonly userId: string | null;
  readonly confirmUserId: string | null;
  readonly schema: string | null;
  readonly format: "human" | "json";
  readonly help: boolean;
}

export const SET_CREDENTIAL_OUTCOMES = [
  "set",
  "user_unknown",
  "password_absent",
  "pepper_absent",
  "pepper_refused",
] as const;
export type SetCredentialOutcome = (typeof SET_CREDENTIAL_OUTCOMES)[number];

/** Only one outcome changed anything. A map, so a sixth member is a compile error here. */
export const SET_CREDENTIAL_SUCCEEDED: Readonly<
  Record<"set", true> & Record<Exclude<SetCredentialOutcome, "set">, false>
> = Object.freeze({
  set: true,
  user_unknown: false,
  password_absent: false,
  pepper_absent: false,
  pepper_refused: false,
});

export interface SetCredentialReport {
  readonly outcome: SetCredentialOutcome;
  readonly userId: string;
  readonly detail: string;
  readonly ok: boolean;
}

export async function runSetCredential(
  options: SetCredentialOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SetCredentialReport> {
  const userId = options.userId ?? "";
  const pepper = (env[CREDENTIAL_PEPPER_VAR] ?? "").trim();
  if (pepper === "") {
    return refused("pepper_absent", userId, `${CREDENTIAL_PEPPER_VAR} is unset or empty`);
  }
  try {
    parseCredentialPepper(pepper);
  } catch (err) {
    return refused("pepper_refused", userId, (err as Error).message);
  }
  // Not trimmed. A trailing space is part of a password, and silently removing it would set a
  // credential the operator cannot type back.
  const password = env[NEW_PASSWORD_VAR] ?? "";
  if (password === "") {
    return refused(
      "password_absent",
      userId,
      `${NEW_PASSWORD_VAR} is unset or empty (it is read from the environment, never argv)`,
    );
  }

  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const store = new PostgresCredentialStore(conn, options.schema !== null ? { schema: options.schema } : {});
    // Hashed under the deployment's current parameters, which is why there is no `--scrypt-n`:
    // a credential set under weaker parameters than the deployment serves would verify
    // (`verifyPassword` reads the hash's own) and quietly be the weakest thing in the system.
    const encoded = await hashPassword(password, pepper);
    const matched = await store.setCredential(userId, encoded);
    if (!matched) {
      return refused(
        "user_unknown",
        userId,
        `no meta.users row with id ${userId}; provision one with --platform-user-routes first`,
      );
    }
    return {
      outcome: "set",
      userId,
      detail: "credential set; any lock on this account was cleared",
      ok: true,
    };
  } finally {
    await conn.close();
  }
}

function refused(
  outcome: Exclude<SetCredentialOutcome, "set">,
  userId: string,
  detail: string,
): SetCredentialReport {
  return { outcome, userId, detail, ok: SET_CREDENTIAL_SUCCEEDED[outcome] };
}

/** Never prints the password, the pepper or the hash -- only which user and what happened. */
export function formatSetCredentialReport(report: SetCredentialReport): string {
  const head = report.ok ? "set-credential: ok" : `set-credential: refused ${report.outcome}`;
  return `${head}\n  user:   ${report.userId}\n  detail: ${report.detail}`;
}

export const setCredentialHelpText = `operate-server set-credential — set a user's login password

Usage:
  operate-server set-credential --user <uuid> --confirm-user <uuid> [options]

The password is read from ${NEW_PASSWORD_VAR} in the environment and never from argv, because
argv is readable by anyone who can run 'ps' (ADR-0301). ${CREDENTIAL_PEPPER_VAR} must be set to
the same value the server runs with, or the credential will not verify.

This is the bootstrap path: there is no mail channel in a fresh deployment, so an operator with
shell access is the only principal that exists before the first password does.

Options:
  --user <uuid>          The meta.users row to set a password on
  --confirm-user <uuid>  The same id again. Required: this overwrites a credential, so naming the
                         wrong user locks a real person out and hands their account to whoever
                         typed the password. There is no --yes, because a flag meaning "I meant
                         it" can be pasted from a runbook without reading the id
  --schema <name>        Meta-schema name (default meta)
  --format human|json    Output format (default human)

Exit: 0 when the credential was set; 1 when refused; 2 on a usage error.
`;
