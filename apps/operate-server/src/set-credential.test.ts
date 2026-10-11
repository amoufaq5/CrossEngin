import { describe, expect, it } from "vitest";

import { CREDENTIAL_PEPPER_VAR } from "./credential-auth-env.js";
import {
  NEW_PASSWORD_VAR,
  SET_CREDENTIAL_OUTCOMES,
  SET_CREDENTIAL_SUCCEEDED,
  formatSetCredentialReport,
  runSetCredential,
} from "./set-credential.js";

const USER = "22222222-2222-4222-8222-222222222222";
const PEPPER = "a-deployment-pepper-with-plenty-of-distinct-bytes-0123456789";

const opts = { userId: USER, confirmUserId: USER, schema: null, format: "human" as const, help: false };

describe("SET_CREDENTIAL_SUCCEEDED", () => {
  it("is total and admits exactly one outcome", () => {
    expect(Object.keys(SET_CREDENTIAL_SUCCEEDED).sort()).toEqual([...SET_CREDENTIAL_OUTCOMES].sort());
    expect(SET_CREDENTIAL_OUTCOMES.filter((o) => SET_CREDENTIAL_SUCCEEDED[o])).toEqual(["set"]);
  });
});

describe("runSetCredential", () => {
  // Each of these refuses BEFORE a connection is opened, which is what makes them testable
  // offline -- and is also the right order: a misconfiguration should not cost a round trip, and a
  // connection failure must not mask a missing variable.

  it("refuses an absent pepper and names the variable", async () => {
    const r = await runSetCredential(opts, { [NEW_PASSWORD_VAR]: "pw" });
    expect(r.outcome).toBe("pepper_absent");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(CREDENTIAL_PEPPER_VAR);
  });

  it("refuses a weak pepper through the shared validator", async () => {
    const r = await runSetCredential(opts, {
      [CREDENTIAL_PEPPER_VAR]: "short",
      [NEW_PASSWORD_VAR]: "pw",
    });
    expect(r.outcome).toBe("pepper_refused");
    expect(r.detail).toContain("credential pepper refused");
  });

  it("refuses an absent password and says it comes from the environment", async () => {
    const r = await runSetCredential(opts, { [CREDENTIAL_PEPPER_VAR]: PEPPER });
    expect(r.outcome).toBe("password_absent");
    expect(r.detail).toContain(NEW_PASSWORD_VAR);
    expect(r.detail).toContain("never argv");
  });

  it("does not trim the password", async () => {
    // A trailing space is part of a password. Trimming would set a credential the operator cannot
    // type back, and the failure would present as "the password is wrong".
    // The observable consequence of not trimming: a password of three spaces is a password, so
    // the run proceeds to open a connection instead of refusing `password_absent`. There is no
    // PGHOST in this suite, so proceeding is exactly what the throw proves.
    await expect(
      runSetCredential(opts, {
        [CREDENTIAL_PEPPER_VAR]: PEPPER,
        [NEW_PASSWORD_VAR]: "   ",
      }),
    ).rejects.toThrow(/PGHOST/);
    // ...where the empty string refuses before any connection is attempted.
    const absent = await runSetCredential(opts, {
      [CREDENTIAL_PEPPER_VAR]: PEPPER,
      [NEW_PASSWORD_VAR]: "",
    });
    expect(absent.outcome).toBe("password_absent");
  });

  it("never prints the password, the pepper or the hash", async () => {
    for (const env of [
      { [NEW_PASSWORD_VAR]: "s3cret-password" },
      { [CREDENTIAL_PEPPER_VAR]: "short", [NEW_PASSWORD_VAR]: "s3cret-password" },
      { [CREDENTIAL_PEPPER_VAR]: PEPPER },
    ]) {
      const r = await runSetCredential(opts, env);
      const line = formatSetCredentialReport(r);
      expect(line).not.toContain("s3cret-password");
      expect(line).not.toContain(PEPPER);
      expect(r.detail).not.toContain("s3cret-password");
      expect(r.detail).not.toContain(PEPPER);
    }
  });

  it("names the user in its report, which is the one thing an operator must confirm", async () => {
    const r = await runSetCredential(opts, { [NEW_PASSWORD_VAR]: "pw" });
    expect(formatSetCredentialReport(r)).toContain(USER);
  });
});
