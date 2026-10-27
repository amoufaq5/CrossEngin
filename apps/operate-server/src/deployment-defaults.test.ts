import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The first fence over `deploy/`, and it exists because this increment's own class is **a default
 * that is not a default**: three capabilities were measured as unreachable on every shipped
 * deployment for no reason other than that nobody had added the flag, and nothing would notice if
 * somebody took one back out. The compose file is not typechecked, not linted and not imported by
 * anything, so a deleted line there is invisible to all twelve workspace rules and to all 20k
 * tests — which is precisely how `docker-compose.ai.yml` came to be ten flags behind the base
 * (ADR-0364's addendum).
 *
 * Read from disk as text rather than parsed as YAML: the assertions below are about *which flags an
 * operator's deployment passes*, and the list form (`- --flag` / `- value`) is what the file holds,
 * so the text is the artifact. Adding a YAML dependency to this app to read one file would also
 * make the fence a build concern.
 *
 * Each assertion carries the measurement that earned it, because a flag list with no reasons is a
 * list somebody will tidy.
 */
const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE = resolve(here, "../../../deploy/docker-compose.yml");

/** The `api` service's `command:` args, in order, with quotes stripped and comments dropped. */
function apiCommandArgs(): readonly string[] {
  const src = readFileSync(COMPOSE, "utf8");
  const api = src.indexOf("\n  api:\n");
  expect(api, `${COMPOSE} has no api service`).toBeGreaterThanOrEqual(0);
  const web = src.indexOf("\n  web:\n", api);
  expect(web, `${COMPOSE} has no web service after api`).toBeGreaterThan(api);
  const block = src.slice(api, web);
  const cmd = block.indexOf("\n    command:\n");
  expect(cmd, "the api service has no command: block").toBeGreaterThanOrEqual(0);
  const args: string[] = [];
  for (const line of block.slice(cmd + "\n    command:\n".length).split("\n")) {
    // A line that is indented less than the list items ends the block — `expose:`, `ports:`, and
    // so on. Anything that is not a list item inside it is a comment, which is most of the file.
    if (/^ {0,4}\S/.test(line) && !line.trim().startsWith("#")) break;
    const m = /^\s+- (.*)$/.exec(line);
    const captured = m?.[1];
    if (captured === undefined) continue;
    const raw = captured.trim();
    args.push(/^".*"$/.test(raw) ? raw.slice(1, -1) : raw);
  }
  return args;
}

/** The value that follows a flag, or `null` when the flag is absent or is the last argument. */
function valueAfter(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  return args[i + 1] ?? null;
}

/**
 * Every value of a REPEATABLE flag, in order. Separate from `valueAfter` rather than replacing it:
 * `valueAfter` answers for the single-valued flags and reading only the first occurrence of a
 * repeatable one is how `--ai-design-role` came to be passed half way (`cli.ts` replaces the
 * default rather than adding to it, so naming one role dropped the other).
 */
function valuesAfter(args: readonly string[], flag: string): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue;
    const v = args[i + 1];
    if (v !== undefined) out.push(v);
  }
  return out;
}

describe("the api command's shape", () => {
  const args = apiCommandArgs();

  it("parses as a flag list at all", () => {
    // Vacuity guard, and the one assertion every other one in this file depends on: a parse that
    // returned nothing would make all of them pass while reading an empty list. The floor is a
    // round number below the real count rather than the count itself, so adding a flag is not a
    // test edit — the point of this file is the flags that must be *present*, not how many there
    // are.
    expect(args.length).toBeGreaterThan(30);
    expect(args[0]).toBe("node");
    expect(args).toContain("--pack");
    expect(args).toContain("--store");
  });

  it("serves the JSONB store, which is what the other assertions here are measured against", () => {
    // Several reasons below are store-specific — the drain needs Postgres, the unique-index figure
    // is `0 of 32` on this store — so a change here invalidates them rather than merely differing.
    expect(valueAfter(args, "--store")).toBe("pg");
  });
});

describe("the default that was withdrawn and is now earned", () => {
  const args = apiCommandArgs();

  it("mounts the read-state routes, because a page can now display what they count", () => {
    // This describe used to fence the *absence*, on one stated ground: the flag "is blocked on a
    // SURFACE and not on a default decision — a notifications page plus a mark-read affordance, and
    // then this flag on the same day." That page is `/notifications`, so the argument expired rather
    // than being overruled, and the absence turned into this presence on the same day as ADR-0376
    // predicted it would.
    //
    // Without the flag `GET /v1/notifications/unread` answers `404 no route for …` and the badge
    // falls back to counting notices from the last seven days — a figure that cannot tell read from
    // unread.
    expect(args).toContain("--read-state-routes");
  });

  it("pairs the routes with at least one role, because the grant has no default", () => {
    // The pairing, and it is structural rather than stylistic: `readStateRoles` starts as `[]` in
    // `cli.ts`, so `--read-state-routes` alone mounts routes that refuse every request —
    // `[read-state] --read-state-routes is on with no --read-state-role: every request will be
    // refused`. Mounted-and-refusing is worse than absent, because the client's catch renders a
    // plausible badge either way.
    expect(valuesAfter(args, "--read-state-role").length).toBeGreaterThan(0);
  });

  it("grants the role the documented bootstrap actually hands out", () => {
    // The measurement that earned the default, read from `.env.example` rather than restated here,
    // so changing the bootstrap's role without changing this grant fails. The boot line NAMES the
    // granted roles precisely because a membership carrying a role not on it is silently back on the
    // approximation — so the grant has to cover the one login a fresh deployment has.
    const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    const m = /"primaryRole"\s*:\s*"([a-z_]+)"/.exec(env);
    expect(m, ".env.example's bootstrap grants no primaryRole").not.toBeNull();
    const bootstrapRole = m?.[1] ?? "";
    expect(bootstrapRole).not.toBe("");
    expect(valuesAfter(args, "--read-state-role")).toContain(bootstrapRole);
  });

  it("grants exactly the roles .env.example claims the command grants", () => {
    // Two roles and not one, the same shape as `--ai-design-role` on this command: `platform_admin`
    // reaches 0 of erp-core's 255 (entity, operation) pairs, so `.env.example` tells a reader to
    // name an erp-core role for somebody who is meant to USE the ERP — and that person's badge is
    // the one this surface exists for.
    //
    // Read from disk, in BOTH directions, because the first version of this test read the
    // bootstrap's role from `.env.example` (above) and then HARDCODED this one while its comment
    // said the file named it — so the half most likely to drift was the half nothing compared.
    // `.env.example` does not merely mention the role: it restates this command's own grant line
    // inside a backtick span, which is a CLAIM ABOUT THIS ARTIFACT, so the honest fence is set
    // equality against the artifact. A third role added to the compose and not to the doc fails
    // here, which is what the doc's own "A THIRD role needs another `--read-state-role` line"
    // sentence promises a reader.
    //
    // Extracted from backticked spans and never from the raw prose: that same sentence writes the
    // flag with NO value after it, so a scan over the prose would read the word "line" as a role
    // name. A span carrying the flag alone yields no pair — a structural discriminator rather than
    // a list of words to ignore.
    const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    const claimed = new Set<string>();
    for (const span of env.match(/`[^`\n]*`/g) ?? []) {
      for (const m of span.matchAll(/--read-state-role\s+([a-z][a-z0-9_]*)/g)) {
        const role = m[1];
        if (role !== undefined && role !== "") claimed.add(role);
      }
    }
    // Vacuity guard: an extraction that found nothing would otherwise demand the command grant
    // nothing, which is a failure with a misleading message rather than a pass — but it is still
    // worth naming, because the cause is a doc edit and not a compose one.
    expect(
      claimed.size,
      ".env.example no longer restates the command's --read-state-role grant",
    ).toBeGreaterThan(0);
    expect([...valuesAfter(args, "--read-state-role")].sort()).toEqual([...claimed].sort());
  });

  it("does not grant the backfill role, which is the one that gates something", () => {
    // `resolveViewer` takes the viewer from `principal.principalId` unconditionally and
    // `bodyNamesAViewer` refuses a body naming one, so the roles above gate a principal's access to
    // its *own* row — ADR-0364's argument for `/v1/account/password` needing no grant. The backfill
    // role is different in kind: it marks a whole backlog read in one call. Read from disk so the
    // distinction is checked against the code rather than restated.
    const src = readFileSync(resolve(here, "./read-state-routes.ts"), "utf8");
    expect(src).toContain("principal.principalId");
    expect(src).toContain("backfillRoles");
    expect(args).not.toContain("--read-state-backfill-role");
  });
});

describe("the two defaults this increment measured", () => {
  const args = apiCommandArgs();

  it("runs the notification drain, without which nothing is delivered on any channel", () => {
    // `DeliveryScheduler` is the only delivery path in the binary, so with no drain even `in_app`
    // is never delivered — and the warning that was supposed to say so was gated on more than one
    // channel being registered, which this stack never satisfies. Measured live: boot printed
    // `[notify] channels: in_app` and stopped. The live producer here is the design-review decision
    // notice, which `--require-design-review` (also on this command) makes real.
    expect(args).toContain("--notification-drain-ms");
    const ms = Number(valueAfter(args, "--notification-drain-ms"));
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });

  it("enforces meta.tenants.status on every request", () => {
    // ADR-0334 left this opt-in because on-by-default "would refuse requests of a deployment that
    // works today". Measured on this stack it does not: the shipped key carries `platform_admin`,
    // which grants 0 of erp-core's 255 (entity, operation) pairs, so `GET /v1/vendors` with it was
    // already a 403 and the gate only improves the diagnosis. What it *does* change is an api-key
    // naming a placeholder tenant with a real ERP role, which was served 200 over a tenant that has
    // no row.
    expect(args).toContain("--tenant-status-gate");
  });
});

describe("what the command must not carry", () => {
  const args = apiCommandArgs();

  it("passes no api-key on argv (ADR-0301)", () => {
    // The token IS the credential and argv is readable by anyone who can run `ps`. This one is
    // named rather than derived because it is the instance the repo actually shipped: the comment
    // in the `environment:` block said credentials do not travel this way while `--api-key
    // ${OPERATE_ADMIN_API_KEY}` sat nine lines below it (ADR-0357). The general rule — a fence over
    // every credential-shaped flag — needs per-flag declarations, since `--jwks-key` is a *public*
    // key and belongs on argv; see the register.
    expect(args).not.toContain("--api-key");
  });

  it("passes no secret-bearing value by interpolation", () => {
    // A `${...}` on the command line is the shape the api-key exposure took, so the fence is on the
    // shape and not on a name list. `--pack` and `--jwt-issuer` are the two legitimate ones: a pack
    // name and a public URL, neither a credential.
    const interpolated = args.filter((a) => a.includes("${"));
    const allowed = new Set(["${OPERATE_PACK:-erp-core}", "https://${DOMAIN:-localhost}/"]);
    expect(interpolated.filter((a) => !allowed.has(a))).toEqual([]);
  });
});

describe("the documented bootstrap", () => {
  it("creates the tenant before it grants a membership in one", () => {
    // Every version of `.env.example`'s walkthrough omitted this, so the membership call answered
    // `422 cannot grant a membership: meta.tenants has no row for the id this grant names` on every
    // fresh deployment and there was no documented source for the `<tenant-uuid>` it wanted. The
    // ordering is the whole assertion: the file is read top to bottom and the tenant call has to
    // come first.
    const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    const tenants = env.indexOf("/v1/platform/tenants \\");
    const members = env.indexOf("/members \\");
    expect(tenants, "the bootstrap does not create a tenant").toBeGreaterThanOrEqual(0);
    expect(members, "the bootstrap does not grant a membership").toBeGreaterThan(0);
    expect(tenants).toBeLessThan(members);
  });

  it("sets the first password over HTTP, because the shell premise expired", () => {
    // The route is authorised by the `--credential-admin-role` grant, which the compose passes, and
    // the credential that satisfies it is the bootstrap api-key — not a session. Measured: 200 with
    // `x-api-key` alone on a stack holding no password anywhere. `set-credential` stays documented
    // as the fallback, which is why this asserts the route is present rather than that the shell
    // form is absent.
    const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    expect(env).toContain("/credential \\");
    expect(env).toContain("confirmUserId");
    expect(args_credentialAdminGranted()).toBe(true);
  });
});

/** Whether the compose grants the role that authorises the operator credential route. */
function args_credentialAdminGranted(): boolean {
  return apiCommandArgs().includes("--credential-admin-role");
}

describe("the secrets .env.example ships", () => {
  const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
  const PLACEHOLDER = "REPLACE_WITH_";

  it("ships the cursor secret uncommented, because a cursor carries a classified field", () => {
    // Commented out, it was the one deploy document telling an operator to leave the disclosure
    // open — `ORACLE.md`, `README.md` and `VERCEL-SUPABASE.md` all treat it as required (ADR-0377).
    expect(env).toMatch(/^CURSOR_ENCRYPTION_SECRET=/m);
  });

  it("leaves the at-rest secret commented, because the shipped pack declares no phi field", () => {
    // The asymmetry is measured on the pack this compose serves and not chosen: resolved erp-core
    // has 0 phi/regulated fields and 1 sortable classified field. Uncommenting this one would ask
    // an operator to generate a secret nothing reads.
    expect(env).toMatch(/^#COLUMN_ENCRYPTION_SECRET=/m);
  });

  it("is safe to ship a placeholder only because an unreplaced one is refused at boot", () => {
    // This is the assertion that makes the first one above honest, and it is a cross-package read
    // for that reason. `REPLACE_WITH_32_PLUS_RANDOM_CHARS` is 33 bytes with 19 distinct values, so
    // it passes BOTH entropy floors — it is strong and it is public. Without the refusal,
    // uncommenting the cursor secret would turn a true `plaintext_disclosing` warning into a
    // confident `sealed` under a key derivable from a file in this repository: ADR-0337's
    // falsely-true control, created by the change meant to close the disclosure.
    const kd = readFileSync(
      resolve(here, "../../../packages/crypto/src/key-derivation.ts"),
      "utf8",
    );
    expect(kd).toContain('SECRET_PLACEHOLDER_PREFIX = "REPLACE_WITH_"');
    expect(kd).toContain("unreplaced_placeholder");
    // Vacuity guard: an `.env.example` that stopped using this marker would make the refusal
    // unreachable and leave both assertions above passing over a file nothing fences.
    expect(env).toContain(PLACEHOLDER);
  });

  it("names a generator beside every secret it asks for", () => {
    // The refusal prints this command, so the file and the binary have to agree about it.
    expect(env).toContain("randomBytes(32)");
  });
});

describe("the drain-absence warning's gate", () => {
  // A text fence over `node.ts`, because the branch is a `console.warn` inside `serve()` and there
  // is no seam to call: the three arms are verified live instead (a Postgres store with the drain
  // prints the interval, without it prints the warning, and `--store memory` prints neither). What
  // a test *can* hold is the shape of the condition, and the shape is the whole defect — the gate
  // was `channels.length > 1`, which is satisfiable by no shipped deployment, so the warning
  // existed and could not fire. Same idiom as `integrity-proof.test.ts`'s fence over its own
  // source.
  const src = readFileSync(resolve(here, "./node.ts"), "utf8");
  const start = src.indexOf("[notify] no delivery drain is running");
  const windowBefore = (): string => {
    expect(start, "node.ts no longer carries the drain-absence warning").toBeGreaterThanOrEqual(0);
    // The enclosing branch: everything from the preceding `if (` to the warning itself, with
    // comments stripped. Stripping is not tidiness — the comment on that branch *explains* the old
    // `channels.length > 1` gate by quoting it, so matching the raw text fails on the prose that
    // records why the gate is gone. Which is this file's own hazard: a text fence that reads
    // commentary as code either fires on correct code or, worse, is "fixed" by deleting the
    // explanation.
    const open = src.lastIndexOf("\n  if (", start);
    expect(open).toBeGreaterThanOrEqual(0);
    return src
      .slice(open, start)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  };

  it("is not gated on how many channels are registered", () => {
    // `in_app` is registered unconditionally, so any channel-count condition is a condition about
    // whether a *provider* was configured — and the drain is the only delivery path for `in_app`
    // too, which makes the shipped single-channel case the instance of the rule rather than an
    // exception to it.
    expect(windowBefore()).not.toContain("channels.length");
    expect(windowBefore()).not.toContain("report.channels");
  });

  it("is gated on the store, which is the one configuration where it names no remedy", () => {
    // On `--store memory` the flag is refused at parse, no notification store is built and no
    // dispatch can be enqueued — so there is nothing to warn about (ADR-0334's `missing` versus
    // `not applicable`).
    expect(windowBefore()).toContain("conn !== undefined");
  });

  it("says that in_app is included, because that is the clause an operator disbelieves", () => {
    const line = src.slice(start, start + 400);
    expect(line).toContain("in_app");
    expect(line).toContain("--notification-drain-ms");
  });
});
