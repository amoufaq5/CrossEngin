import { readFileSync, readdirSync } from "node:fs";
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
const README = resolve(here, "../../../deploy/README.md");
const ORACLE = resolve(here, "../../../deploy/ORACLE.md");

/**
 * The two markdown documents an operator follows, read as text for the compose file's reason: they
 * are not typechecked, not linted and imported by nothing, so what they *tell an operator to run*
 * is outside all twelve workspace rules and every other test.
 *
 * Both, and never one: the register's P0.9 entry was graded against `ORACLE.md` while the live
 * defect was in `README.md`'s abridgement of it, and the cross-reference assertions below only mean
 * anything if both ends are in hand.
 */
function deployDoc(path: string): string {
  const src = readFileSync(path, "utf8");
  expect(src.length, `${path} is empty`).toBeGreaterThan(1000);
  return src;
}

/**
 * Every markdown document under `deploy/`, read from the directory rather than named.
 *
 * The set was a hardcoded pair and that was ADR-0288's shape one level out: a maximally defective
 * `pg_dump` added to `deploy/VERCEL-SUPABASE.md` passed every assertion below, and that is the
 * document a backup section would be added to, because it is the managed-cloud path and the only
 * one of the three with no occurrence of *backup*, *dump*, *restore*, *PITR* or *snapshot*. The
 * floor is what makes the read a fence rather than a convenience: a `readdirSync` that stopped
 * matching would hand every assertion an empty population, which is the silent direction.
 */
function deployMarkdown(): readonly { readonly doc: string; readonly src: string }[] {
  const dir = resolve(here, "../../../deploy");
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort();
  expect(names.length, "deploy/ no longer holds the markdown documents this fence reads").toBeGreaterThanOrEqual(3);
  return names.map((doc) => ({ doc, src: deployDoc(resolve(dir, doc)) }));
}

/** A shell comment, whether it is the whole line or trails a command. */
function stripShellComment(line: string): string {
  return line.replace(/^\s*#.*$/, "").replace(/\s#.*$/, "");
}

/**
 * Every `pg_dump` invocation in the deploy documents, as the whole shell command it sits in, with
 * the shell text it is embedded in so a `$var` in it can be resolved.
 *
 * The unit is the *command* and not the line, because `ORACLE.md`'s is a continuation of a pipe and
 * the arguments that matter (`-T`, the redirect target) can be on either side of a `\`. Lines are
 * joined on a trailing backslash first.
 *
 * **A command is discriminated by its content and never by its formatting**, and the first spelling
 * of this helper got that exactly backwards. It stripped markdown code spans and justified it with
 * a convention — *a command name in prose is always inside backticks and in a command it never
 * is* — which this repository's own pre-image refutes: the sharpest single defect in `deploy/`,
 * `docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`, shipped as a
 * one-line code span. So the three assertions written to catch it — no `-T`, an unset variable, a
 * constant redirect target — were unexamined against the defect in the form it actually had, and
 * only the population count noticed. A fence resting on a formatting convention is a fence the next
 * author can satisfy by changing the formatting.
 *
 * So the candidates are every line of every fenced `bash`/`sh` block **plus** every inline code
 * span outside those fences (disjoint by construction, since the fenced regions are removed before
 * the span scan), and a candidate is an *invocation* rather than a *mention* iff it names `pg_dump`
 * and then goes on to say something — a flag, a pipe or a redirect. Measured over the three
 * documents: the four prose mentions are each the bare token and nothing else, and the three
 * commands each carry at least `-U` and a `>`. A prose span that named a flag would read as a
 * command and fire the fence on correct text; that is the visible direction rather than the silent
 * one, and it is measured at zero occurrences today.
 *
 * Comments go first, whole-line and trailing, and that is a second discriminator rather than a
 * tidy-up: the script's own comments quote `pg_dump` while explaining the rule, and
 * `# 3. and pg_dump reached the end` — written while adding the third verification step — reads as
 * an invocation with no `-T`, no `-U` and a constant redirect target, so **four** assertions fire
 * at once on correct text. The trailing form is scoped to a `#` preceded by whitespace, so
 * `${#var}` and a markdown anchor like `ORACLE.md#13-back-up` are untouched; a `#` inside a quoted
 * string on a `pg_dump` line would be mangled and is measured at zero occurrences.
 *
 * Deliberately NOT anchored on `^docker`, which was the first spelling: `sudo docker … pg_dump` is
 * measured at zero occurrences in `deploy/` today, so that anchor was correct and would have been
 * silently blind to the first one added. The population assertion is the backstop either way — a
 * shape this misses changes the count and fails by name.
 */
const PG_DUMP_INVOCATION = /\bpg_dump\b[^\n]*?(?:\s-{1,2}[A-Za-z]|[|>])/;

function pgDumpCommands(): readonly {
  readonly doc: string;
  readonly cmd: string;
  readonly scope: string;
}[] {
  const out: { doc: string; cmd: string; scope: string }[] = [];
  for (const { doc, src } of deployMarkdown()) {
    const joined = src.replace(/\\\n\s*/g, " ");
    const push = (raw: string, scope: string): void => {
      const cmd = stripShellComment(raw).trim();
      if (!PG_DUMP_INVOCATION.test(cmd)) return;
      out.push({ doc, cmd, scope });
    };
    for (const m of joined.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
      const block = m[1] ?? "";
      for (const line of block.split("\n")) push(line, block);
    }
    const outsideFences = joined.replace(/```[\s\S]*?```/g, "\n");
    for (const m of outsideFences.matchAll(/`([^`\n]*)`/g)) push(m[1] ?? "", m[1] ?? "");
  }
  return out;
}

/**
 * A redirect target with its `$var`s replaced by what the surrounding shell assigns them.
 *
 * The uniqueness assertion below used to accept `target.includes("$tmp")` as proof, which
 * whitelists the variable *name* and says nothing about its value: rewriting the unattended cron
 * script to a constant `out="…/crossengin-latest.sql.gz"` passed all 33 tests — the one invocation
 * this increment says destroys data on its own, and a constant `$out` additionally makes the
 * `-mtime +14` sweep meaningless, because there is only ever one file for it to age.
 *
 * Resolution is transitive because the real script is (`tmp="$out.partial"`, `out="…$(date …)…"`),
 * bounded at four passes so a self-referential assignment cannot spin, and scoped to the shell text
 * the command sits in rather than the whole document, so an assignment in an unrelated block cannot
 * supply a value. A `$var` with no assignment in scope is left as it is, which fails the assertion
 * — the honest direction, since an unresolvable name is exactly as unexamined as before.
 */
function resolveShellVars(target: string, scope: string): string {
  const assignments = new Map<string, string>();
  for (const m of scope.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm)) {
    if (!assignments.has(m[1] ?? "")) assignments.set(m[1] ?? "", (m[2] ?? "").trim());
  }
  let out = target;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) =>
      assignments.has(name) ? (assignments.get(name) ?? whole) : whole,
    );
    if (next === out) break;
    out = next;
  }
  // Quotes come off last, because substituting an assignment's right-hand side verbatim nests
  // them: `tmp="$out.partial"` over an already-quoted `out="…"` resolves to `"""…".partial""`, and
  // both tests below are about the *path*, where quoting carries no information.
  return out.replace(/["']/g, "");
}

/** Every fenced ```bash / ```sh block in a document, as its body text. */
function shellBlocks(src: string): readonly string[] {
  return [...src.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/**
 * Whether a document contains a cron line an operator could run — a `crontab` invocation or a
 * five-field schedule — inside a shell block.
 *
 * Not `src.includes("crontab")`, and the difference is the whole point. Found by mutation: the
 * prose added to README to *point at* ORACLE.md's section lists "the script, the crontab line, the
 * retention sweep and the verification" as what the abridgement dropped, so the word is present in
 * a sentence whose subject is another document's cron line. A fence on the word was satisfied by
 * its own explanation and the dangling reference went back in undetected.
 *
 * Scoped to fenced blocks for that reason: a cron line is something you run, so the artifact is a
 * command and not a noun phrase.
 */
function hasRunnableCronLine(src: string): boolean {
  return shellBlocks(src).some(
    (b) => /\bcrontab\b/.test(b) || /^\s*[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+\S/m.test(b),
  );
}

/**
 * The anchors a GitHub-rendered heading yields, for the cross-reference fence below.
 *
 * Mirrors GitHub's slug rule rather than guessing: lowercase, drop everything that is not a word
 * character, a space or a hyphen, then spaces to hyphens. `## 13. Back up` is `13-back-up` — the
 * `.` is dropped rather than becoming a hyphen, which is the one step a hand-written anchor gets
 * wrong.
 */
function headingAnchors(src: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  for (const m of src.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const text = m[1] ?? "";
    anchors.add(
      text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
  }
  return anchors;
}

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

describe("the documented backup commands", () => {
  // The only fence over what `deploy/`'s prose tells an operator to *run*, and it exists because
  // the three commands it covers were each wrong in a way that destroys data rather than merely
  // failing: a redirect the shell truncates before `pg_dump` starts, a pipe whose producer can die
  // and still exit 0, and a retention sweep that ran either way.
  //
  // Every assertion here is over the real documents rather than a fixture, so each carries a
  // non-vacuity floor: a scanner that stopped matching would report zero violations, which is the
  // shape of fence this repository has shipped several of.
  const commands = pgDumpCommands();

  it("finds every invocation there is, so the assertions below are not vacuous", () => {
    // Measured: ORACLE.md's scheduled script — inside a `<<'SH'` heredoc, itself inside a fenced
    // block — then README's day-2 bullet and README's Oracle step 9. Sorted by document name, so
    // ORACLE comes first. An exact count rather than a floor: three is the whole population, so a
    // fourth is a new command somebody added without reading this block, and a second is one of
    // these three having been deleted or reworded past the matcher.
    expect(commands.map((c) => c.doc)).toEqual(["ORACLE.md", "README.md", "README.md"]);
    // And the mentions really are excluded by content: four of them across the three documents,
    // each the bare token. A count rather than a list, because the prose will be reworded.
    const mentions = deployMarkdown().reduce(
      (n, { src }) => n + [...src.matchAll(/`pg_dump`/g)].length,
      0,
    );
    expect(mentions, "the prose no longer names pg_dump, so the content discriminator is untested").toBeGreaterThanOrEqual(3);
  });

  it("passes -T to every one, because a TTY corrupts the byte stream", () => {
    // `docker compose exec` without `-T` allocates a TTY, which injects CR into the stream, so a
    // dump that completes may still not restore. README's day-2 bullet was the one that lacked it
    // while both siblings had it — the asymmetry is what identified it.
    for (const { doc, cmd } of commands) {
      expect(cmd, `${doc}: pg_dump without -T`).toMatch(/\bexec\s+-T\b/);
    }
  });

  it("names the role and database through something the operator's shell can resolve", () => {
    // The earlier form read `-U "$POSTGRES_USER" "$POSTGRES_DB"`, expanded by the *operator's*
    // shell, where both are unset: they live only in `deploy/.env` and no documented step sources
    // it (measured: zero `set -a` / `source`/`export POSTGRES` in any of the three documents). The
    // `db` service's own `environment:` carries POSTGRES_USER/PASSWORD/DB — initdb's variables —
    // and not the `*pg-env` anchor's PGUSER/PGDATABASE, so the fallback is not inside the
    // container either.
    //
    // **One predicate for both documents, and the first spelling was two.** It asserted the
    // *literal* `crossengin`, which refuses the remedy README's own idiom prescribes: :131's
    // extension repair reads the value out of `.env` with a `grep`, and README carries a whole
    // `role "…" does not exist` bullet about an operator who changed `POSTGRES_USER` — so a literal
    // is a remedy that fails for exactly the population most likely to need a backup. The rule is
    // therefore *not a bare variable*, which admits the `.env` lookup and the literal alike, and
    // the scheduled script keeps the literal for a reason stated where it is: it is a file authored
    // once for one VM, not a line an interactive shell expands.
    //
    // `$(…)` is stripped before the test, which its sibling below already did and this one did not:
    // without that, `/pg_dump\s+([^>|]*)/` truncates the argument list at the `|` inside
    // `cut -d= -f2-` and the `$` it then sees is the one it just cut in half. `${BRACE}` is in the
    // pattern because the first spelling required a letter straight after the `$` and so passed the
    // brace form of the same defect.
    for (const { doc, cmd } of commands) {
      const argsOf = (text: string): string => /pg_dump\s+([^>|]*)/.exec(text)?.[1] ?? "";
      const args = argsOf(cmd.replace(/\$\([^)]*\)/g, ""));
      expect(args, `${doc}: pg_dump argument list is unreadable`).toContain("-U");
      expect(args, `${doc}: pg_dump names its role or database through a bare shell variable`).not.toMatch(
        /\$\{?[A-Za-z_]/,
      );
      // Non-vacuity, and the floor rather than the form: the role has to be named *somehow* — the
      // literal, or a lookup of the variable `.env` holds. A command naming neither would satisfy
      // the refusal above by saying nothing at all.
      expect(argsOf(cmd), `${doc}: pg_dump names neither the crossengin role nor POSTGRES_USER`).toMatch(
        /crossengin|POSTGRES_USER=/,
      );
    }
  });

  it("redirects to a name that cannot collide with the previous backup", () => {
    // The sharpest single defect in `deploy/`: `> backup.sql` is a constant, and the shell
    // truncates a redirect target to zero bytes *before* `pg_dump` runs — so re-running the
    // documented command destroyed the previous backup before the new one was known to have
    // succeeded, and the command then failed for the unset-variable reason above.
    //
    // The fence is on the *target*, and a command substitution in it is what makes the name unique.
    // `$(date +%F)` is deliberately not enough and is why README's Oracle step moved to
    // `+%F-%H%M`: a per-day name still truncates today's dump on a second run the same day, which
    // is the same defect with a 24-hour window instead of an unbounded one.
    for (const { doc, cmd, scope } of commands) {
      // Everything after the last `>` to the end of the command, and not `(\S+)`: a `$(date …)`
      // contains a space, so a non-whitespace capture reads the target as the fragment
      // `"crossengin-$(date` and then fails the `+%F-%H%M` assertion on a command that satisfies
      // it. This fence fired on correct text before it worked — the safe direction, and still a
      // scanner that was measuring something other than what its message claimed.
      const written = cmd.slice(cmd.lastIndexOf(">") + 1).trim();
      expect(written, `${doc}: pg_dump does not redirect anywhere`).not.toBe("");
      // Resolved, never whitelisted by name: `$tmp` used to pass on the strength of being a
      // variable, so a constant `out=`/`tmp=` in the unattended script passed every test here.
      const target = resolveShellVars(written, scope);
      expect(target, `${doc}: pg_dump redirects to a constant name (${written} → ${target})`).toContain(
        "$(date",
      );
      expect(target, `${doc}: a per-day name still truncates on a second run that day`).toMatch(
        /\+%F-%H%M/,
      );
      // And out of the Docker build context, which is the repository root (`context: ..`), so a
      // dump written into `deploy/` is baked into every later `up -d --build` and into any image
      // the operator pushes — a plaintext dump holding `meta.users`' credential hashes. The two
      // README commands are run from `deploy/`; the scheduled script `cd`s there to reach
      // `docker compose` and writes to an absolute path outside the tree.
      expect(target, `${doc}: pg_dump writes into the Docker build context (${target})`).toMatch(
        /^(?:\$HOME|~|\/)/,
      );
    }
  });
});

describe("the scheduled backup script", () => {
  // ORACLE.md's `dump.sh` is the one piped, unattended invocation, and it is the member of this
  // class that destroys data on its own rather than on an operator's second keystroke.
  const src = deployDoc(ORACLE);
  /**
   * The heredoc body with full-line `#` comments stripped — and the stripping is the assertion
   * rather than tidiness.
   *
   * Found by mutation: the script's own comments *quote* `gunzip -t`, because they explain what the
   * old form left behind, so removing the real `gunzip -t "$tmp"` line left every assertion below
   * passing against the prose that describes it. That is the hazard the drain-absence fence in this
   * same file names in so many words — a text fence that reads commentary as code either fires on
   * correct code or is "fixed" by deleting the explanation — reproduced here by the author who had
   * just read it. The ordering assertions were worse than merely vacuous: the comment sits above
   * the `mv`, so they held for the wrong reason.
   *
   * Whole-line *and* trailing comments, through the same `stripShellComment` the command scan uses.
   * The first spelling took whole-line only and then asserted `not.toContain("#")` over the
   * result — so an ordinary trailing comment, which is the single most likely future edit to this
   * script, failed **three** tests under a message blaming the stripper. A fence an author satisfies
   * by deleting the explanation is ADR-0382's hook, and that was it in miniature. The `+%F-%H%M` in
   * the filename survives because the trailing form needs whitespace before the `#`.
   */
  const script = (): string => {
    const m = /cat > ~\/backups\/dump\.sh <<'SH'\n([\s\S]*?)\nSH\n/.exec(src);
    expect(m, "ORACLE.md no longer ships a dump.sh heredoc").not.toBeNull();
    const body = (m?.[1] ?? "")
      .split("\n")
      .map(stripShellComment)
      .filter((line) => line.trim() !== "")
      .join("\n");
    // Non-vacuity for the strip itself: a regex that stopped matching would hand every assertion
    // below an empty string, which `toContain` fails on but the `indexOf` orderings do not.
    expect(body.length, "the dump.sh body stripped to nothing").toBeGreaterThan(100);
    return body;
  };

  it("sets pipefail, because pg_dump is the non-final element of a pipe", () => {
    // Measured, on the form this section used to ship: under `set -eu`,
    // `( echo x; exit 2 ) | gzip > f` exits **0** and `gunzip -t f` calls the result valid. So a
    // dump that dies mid-stream yields a valid gzip of a partial dump, `set -e` never fires and
    // cron is silent. `pipefail` is the only thing that makes the producer's exit status reach the
    // pipeline's.
    // One pattern and not an alternation: `-o` is the option that matters and `set -euo pipefail`
    // is `[a-z]*` before it, so `set -o pipefail` needs no second branch. An alternation here
    // would be two spellings of one rule, which is the thing this directory keeps converging.
    expect(script()).toMatch(/^\s*set\s+-[a-z]*o\s+pipefail\b/m);
  });

  it("verifies the dump before it moves it into place", () => {
    // `gunzip -t` reads the whole stream and checks the CRC, which is what catches a gzip that is
    // itself incomplete — gzip killed mid-write, a full disk, a file truncated after it was
    // written — and which `pipefail` cannot see, because gzip is the pipe's *final* element and so
    // its own exit status is the pipeline's either way.
    //
    // It is deliberately NOT what catches "a pg_dump that exits 0 having written a short answer",
    // which this comment used to claim and which is measured false: `( printf 'CREATE TABLE t();';
    // exit 0 ) | gzip` is a *complete* gzip of a partial dump and `gunzip -t` exits **0** on it.
    // Neither this nor `pipefail` sees that one; the verification block's third step does, by
    // asking whether `pg_dump` wrote its terminating line. The same class as the thing this fence
    // is about, committed inside the increment that cites it.
    //
    // The temporary name plus one rename is what buys the invariant the comment in the script
    // states: the backup directory holds verified dumps and nothing else.
    const body = script();
    expect(body).toContain("gunzip -t");
    expect(body).toMatch(/\.partial/);
    expect(body).toMatch(/\bmv\b/);
    // Ordering, which is the whole of it: a verify after the rename would publish the bad file and
    // then complain about it.
    expect(body.indexOf("gunzip -t")).toBeLessThan(body.lastIndexOf("mv "));
  });

  it("gates the retention sweep on the dump having succeeded", () => {
    // Measured on the old form: ONE failing run, against a directory holding one dump older than
    // the retention window, exits 0, prunes the good dump, and leaves a `gunzip -t`-valid gzip of
    // a one-line partial in its place. The gate is `set -e` plus ordering — the `find` is the last
    // statement, so nothing reaches it unless the dump and the verify both passed.
    const body = script();
    const prune = body.search(/find\s+\S+\s+-name[^\n]*-delete/);
    expect(prune, "the script no longer prunes, so this assertion is vacuous").toBeGreaterThan(0);
    // Presence before ordering: `indexOf` answers -1 for an absent needle and -1 is less than any
    // offset, so each of these used to pass when the thing it orders had been deleted outright. It
    // survived only because a sibling test caught the absence — one assertion standing in for
    // another, which is how both come to be deleted together.
    expect(body, "the script no longer verifies, so the ordering below is vacuous").toContain("gunzip -t");
    expect(body, "the script no longer renames, so the ordering below is vacuous").toMatch(/\bmv\b/);
    expect(body.indexOf("gunzip -t"), "the prune is not gated on the verify").toBeLessThan(prune);
    expect(body.lastIndexOf("mv "), "the prune is not gated on the rename").toBeLessThan(prune);
    // And `set -e` is what turns "later in the file" into "unreachable on failure". Without it the
    // ordering above is decoration.
    expect(body).toMatch(/set -[a-z]*e/);
  });

  it("checks the whole stream in the verification block, not only a prefix", () => {
    // The one occurrence of the word "restore" in all of `deploy/` labelled a check that could not
    // fail for the failure mode the script above produces: `gunzip -c … | head -40` prints the
    // preamble of a dump truncated at any later byte, and `head` closes the pipe before `gunzip`
    // reaches the trailing CRC. Measured: a gzip with its last 30 bytes removed prints three lines
    // and exits 0 that way, and answers `unexpected end of file` with exit 1 under `gunzip -t`.
    //
    // Read from the fenced blocks that follow the script rather than from the prose, and asserted
    // as an ORDER: `head` is kept deliberately (it answers "is this SQL or an error page"), so the
    // fence is that the whole-stream check comes first.
    const blocks = shellBlocks(src).filter((b) => b.includes("gunzip"));
    expect(blocks.length, "ORACLE.md ships no gunzip verification block").toBeGreaterThan(0);
    const verify = blocks.find((b) => !b.includes("dump.sh"));
    expect(verify, "ORACLE.md's gunzip block is only the script").toBeDefined();
    const body = verify ?? "";
    expect(body).toContain("gunzip -t");
    expect(body.indexOf("gunzip -t"), "the prefix read comes before the whole-stream check").toBeLessThan(
      body.indexOf("head"),
    );
  });
});

describe("the cross-document reference README's abridgement needs", () => {
  // README:781-938 is an abridgement of ORACLE.md's walkthrough, and the abridgement dropped the
  // script, the crontab line, the retention sweep and the restore check while keeping a sentence
  // that said "that cron line". Four missing antecedents. The fix points at ORACLE.md's heading
  // rather than copying the script in, on the rule this repository reached for
  // `ManifestSectionChange.reachNote`: a copy removed cannot drift where a copy fenced can.
  const readme = deployDoc(README);
  const oracle = deployDoc(ORACLE);

  it("names no cron line it does not contain", () => {
    // The dangling reference. `that cron line` is deictic — it resolves only against something in
    // the same document — so README may use it only if README holds a runnable cron line, which it
    // does not and which is why the sentence was dropped rather than reworded.
    if (/\bthat cron line\b/.test(readme)) {
      expect(hasRunnableCronLine(readme), "README says 'that cron line' and holds none").toBe(true);
    }
    // Non-vacuity, in both directions. The predicate above holds trivially for a README with no
    // such phrase, so assert the pointer that replaced it is still there — and assert the
    // predicate itself is discriminating, by checking it answers `true` for the document that does
    // hold the cron line. A one-sided predicate that answered `false` for everything would make
    // the guard above unfalsifiable.
    // Both pointers and not "at least one": README has two places that tell an operator to take a
    // dump — the day-2 bullet and Oracle step 9 — and each needs the onward reference, because
    // each is a place somebody stops reading. A `toContain` here was satisfied by either, so
    // deleting one passed (found by mutation).
    expect(
      [...readme.matchAll(/ORACLE\.md#13-back-up/g)].length,
      "one of README's two backup sections stopped pointing at the scheduled form",
    ).toBe(2);
    expect(hasRunnableCronLine(oracle), "ORACLE.md's cron line stopped being detectable").toBe(
      true,
    );
    expect(hasRunnableCronLine(readme), "README gained a cron line of its own").toBe(false);
  });

  it("points at a heading ORACLE.md actually has", () => {
    // The fence that stops this cross-reference becoming the next dangling one. Anchors are derived
    // from ORACLE.md's own headings by GitHub's slug rule, so renaming `## 13. Back up` fails here
    // rather than silently producing a link that scrolls nowhere.
    const anchors = headingAnchors(oracle);
    expect(anchors.size, "no headings were parsed out of ORACLE.md").toBeGreaterThan(10);
    const referenced = [...readme.matchAll(/ORACLE\.md#([\w-]+)/g)].map((m) => m[1] ?? "");
    expect(referenced.length, "README references no ORACLE.md anchor").toBeGreaterThan(0);
    for (const anchor of referenced) {
      expect(anchors.has(anchor), `README links to ORACLE.md#${anchor}, which has no heading`).toBe(
        true,
      );
    }
  });

  it("dangles no intra-document anchor either", () => {
    // Free, and measured before it was written: of README's 10 same-document anchors, 9 resolved
    // and the one that did not was the one this increment had just added — so the rule costs
    // nothing on the existing tree and caught its author on its first run. Both documents, because
    // ORACLE.md has 0 today and the floor below is what notices if it gains a broken one.
    for (const [name, src] of [
      ["README.md", readme],
      ["ORACLE.md", oracle],
    ] as const) {
      const anchors = headingAnchors(src);
      expect(anchors.size, `no headings were parsed out of ${name}`).toBeGreaterThan(10);
      // Same-document links only: `](#x)`. A cross-document one is `](./OTHER.md#x)` and is
      // checked above against the other file's headings.
      for (const m of src.matchAll(/\]\(#([\w-]+)\)/g)) {
        const anchor = m[1] ?? "";
        expect(anchors.has(anchor), `${name} links to #${anchor}, which has no heading`).toBe(true);
      }
    }
    // Non-vacuity: a matcher that stopped finding links would pass over an empty set. README is
    // the document that has them, so the floor is on README.
    expect(
      [...readme.matchAll(/\]\(#([\w-]+)\)/g)].length,
      "README's intra-document anchors stopped being found",
    ).toBeGreaterThan(5);
  });

  it("names no database role or database through a bare shell variable", () => {
    // The generalisation of the `pg_dump` assertion above to the whole class, because fixing three
    // dump commands and leaving a `psql` with the identical defect is a count reduction inside a
    // defect class rather than progress against it (ADR-0366's rule).
    //
    // Found by grepping for the pattern after the dumps were fixed: README's `CREATE EXTENSION`
    // repair read `-U "$POSTGRES_USER" -d "$POSTGRES_DB"` while the *working* idiom —
    // `$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)` — sat 38 lines above it. Two spellings in one
    // document, and the one that could not work was the later one.
    //
    // A `$(…)` command substitution that reads `.env` is the permitted form and a bare `$VAR` is
    // not, which is the whole distinction: nothing in either document sources `.env` into a shell,
    // so a bare variable is empty by construction.
    let examined = 0;
    for (const [name, src] of [
      ["README.md", readme],
      ["ORACLE.md", oracle],
    ] as const) {
      for (const block of shellBlocks(src)) {
        for (const line of block.replace(/\\\n\s*/g, " ").split("\n")) {
          if (!/\b(psql|pg_dump|pg_restore)\b/.test(line)) continue;
          examined += 1;
          const args = line.replace(/\$\([^)]*\)/g, "«subst»");
          expect(args, `${name}: names its role or database through a bare shell variable`).not.toMatch(
            /-[Ud]\s*"?\$[A-Za-z_]/,
          );
        }
      }
    }
    expect(examined, "no psql/pg_dump lines were examined").toBeGreaterThanOrEqual(4);
  });

  it("keeps the manifest-section denominator at seventeen and the table count at sixteen", () => {
    // Two stale manifest denominators (ADR-0388 corrected 16 → 17) beside a *correct* sixteen —
    // `PLATFORM_RECORD_TABLES`, a different set entirely. The trap is that a global replace fixes
    // the two and breaks the one, so the fence is on the phrasing and not on the digit: the word
    // `sixteen` may appear in README only where it is about tables.
    for (const m of readme.matchAll(/^.*\bsixteen\b.*$/gm)) {
      expect(m[0], "a `sixteen` in README that is not about the protected tables").toMatch(
        /tables/,
      );
    }
    // Non-vacuity in both directions: the true sixteen is still there, and the manifest sections
    // are now counted at seventeen in both places that count them.
    expect(readme).toMatch(/Fifteen of the sixteen tables/);
    expect([...readme.matchAll(/manifest's \*\*seventeen\*\* sections/g)].length).toBe(2);
  });
});
