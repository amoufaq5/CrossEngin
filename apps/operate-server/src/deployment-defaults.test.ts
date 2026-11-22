import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { IntegrityProofConfigSchema } from "./integrity-proof.js";

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
const CADDYFILE = resolve(here, "../../../deploy/Caddyfile");
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

describe("the tamper-evidence chain and its two passes (ADR-0406)", () => {
  const args = apiCommandArgs();
  const compose = readFileSync(COMPOSE, "utf8");

  it("passes the chain's signing key through the environment and never on argv", () => {
    // The keystone. Until this variable existed `--audit-chain-config <file>` was the ONLY route to
    // the seed, this service declares no `volumes:` key, and the file route that did exist was an
    // image layer — so no shipped deployment could anchor anything, and the two passes below had no
    // chain to witness. The variable is also the whole of what a deployment needs: measured,
    // `AuditChainConfigSchema.parse({privateKeyBase64, publicKeyBase64})` supplies every other
    // field, so there is nothing a file would add for the defaults.
    expect(compose).toContain("AUDIT_CHAIN_SIGNING_KEY: ${AUDIT_CHAIN_SIGNING_KEY:-}");
    // ADR-0301's fence, which already covers `--api-key` and extends here by one name. The seed is
    // a credential and argv is readable by anyone who can run `ps`.
    expect(args.join(" ")).not.toContain("AUDIT_CHAIN_SIGNING_KEY");
    expect(args).not.toContain("--audit-chain-config");
  });

  it("mounts both passes as booleans, because the file's documented content was a trap", () => {
    // `{}` parses for both schemas, and an empty config resolves to the PLATFORM chain alone —
    // which on a deployment passing no escalation flag is empty, and an empty scope's report is
    // discarded entirely (ADR-0399). Measured live at a 2s tick: three passes each, 0 anchors,
    // 0 verdicts, 0 log lines, while the tenant's chain held an entry. So a documented `{}` would
    // have shipped a control reporting healthy over a population it never read.
    expect(args).toContain("--checkpoints");
    expect(args).toContain("--integrity-proof");
    // And not the file flags, which are mutually exclusive with them and would need a mount.
    expect(args).not.toContain("--checkpoint-config");
    expect(args).not.toContain("--integrity-proof-config");
  });

  it("declares no `volumes:` key on api, which is why the routes above are fileless", () => {
    // The withholding, stated here because it is the measurement that justifies the two booleans
    // and the environment variable rather than a mount. A host mount is NOT unavailable — `db`,
    // `extensions` and `caddy` each mount a host path read-only in this very file — so the claim is
    // narrower and checkable: nothing in the shipped set needs a file any more. The eight other
    // file-taking flags are out of scope, so this is about the shipped set and not about the key
    // being unnecessary for ever.
    const apiBlock = compose.slice(compose.indexOf("\n  api:"), compose.indexOf("\n  web:"));
    expect(apiBlock.length).toBeGreaterThan(1000);
    // COMMENTS STRIPPED, and the first draft of this assertion failed because of it: the comment
    // two screens up in the compose file *quotes* `volumes:` while explaining why api has none, so
    // the raw read found its own justification and reported the key present. That is ADR-0390's
    // addendum class verbatim — a fence a later author satisfies, or breaks, by changing prose —
    // and the remedy is the one the ten workspace rules already use: strip comments before you
    // believe a match.
    const apiKeys = apiBlock
      .split("\n")
      .map((l) => l.replace(/#.*$/, ""))
      .join("\n");
    expect(apiKeys).not.toContain("volumes:");
    // Two floors, because this is an assertion about an ABSENCE and both ways of reading nothing
    // look identical to it. The first: the three mounts that DO exist are outside this block, so a
    // file-wide count of zero would mean the read broke rather than that api has none. The second:
    // stripping must not have eaten the block, which `--checkpoints` still being in it shows.
    expect(compose.split("volumes:").length - 1).toBeGreaterThanOrEqual(4);
    expect(apiKeys).toContain("--checkpoints");
  });

  it("the deletion capabilities route is inline, for the same reason", () => {
    // `--deletion-capabilities <file>` is the one remaining shipped-set flag that wanted a mount,
    // and `--deletion-capability k=v` is why it no longer does. Neither is passed here (the three
    // deletion surfaces are not mounted on this stack), so what is fenced is that the inline route
    // EXISTS — because the absence of the file route was the reason the register graded the file
    // half of P0.3 latent rather than closed.
    const help = readFileSync(resolve(here, "./cli.ts"), "utf8");
    expect(help).toContain("--deletion-capability");
    expect(args).not.toContain("--deletion-capabilities");
  });

  it("is reported at boot either way, including when there is no chain", () => {
    // What made the vacuity invisible: of 28 bracketed boot lines a live boot printed before this
    // increment, the only one naming any of the three surfaces was `[audit-chain] registered
    // sealing key …` — a side effect of a registry write, not a survey. So the lines are part of
    // the change rather than a follow-up.
    const node = readFileSync(resolve(here, "./node.ts"), "utf8");
    expect(node).toContain("formatAuditChain");
    expect(node).toContain("formatChainScopes");
    expect(node).toContain("COVERAGE_REACHES_A_TENANT");
  });

  it("README's replica paragraph rests on facts this fence holds, not on prose", () => {
    // Two sentences in README's Day-2 bullet were measured FALSE by a refutation that landed ~100
    // minutes after ADR-0407 shipped, and both were outside every fence: `deployment-defaults.test.ts`
    // reads this document for its *backup commands* and its *cross-references* and never for the
    // replica paragraph, so a claim about scheduler concurrency sat in shipped operator
    // documentation with nothing standing over it.
    //
    // (1) "the three mechanisms named above are all request-path mechanisms that no scheduler goes
    // through" is false for two of the three. Every chain append takes a per-scope
    // `pg_advisory_xact_lock` — already fenced where it lives, at
    // packages/forensics-pg/src/chain-log-store.test.ts:607, so it is cited here rather than
    // duplicated — and the integrity pass's verdict recorder goes through that append; and every
    // scheduler store read goes through a tenant or platform scope, which is the premise of
    // ADR-0399's and ADR-0400's whole argument. The sentence was offered as the REASON duplicated
    // scheduled work is unsafe, and the true reason is narrower: neither mechanism guards a whole
    // **pass**. The lock serialises one append, not one verification. So what is fenced is the
    // qualifier, because that is the clause whose loss restores the false claim.
    const readme = deployDoc(README);
    expect(readme).toContain("pg_advisory_xact_lock");
    expect(readme).toMatch(/guards? a whole\s+\*\*pass\*\*/);
    // Floor: a stripped or mis-read document would satisfy neither of the above by absence, so pin
    // that the paragraph itself is still here (ADR-0390's rule — an assertion about an absence needs
    // the positive control beside it).
    expect(readme).toContain("Scale the API:");

    // (2) "each replica still folds the whole chain" is false of the shipped default. This is the
    // measurement that sentence rests on, keyed here so a change to the default reds the test and
    // sends its author to the README paragraph rather than leaving it stale — `CI_MEASURED_STEP_SECONDS`'
    // shape (ADR-0382). What IS unconditional per pass is a whole-chain `loadChain` for the anchor
    // half, which is heap rather than the 152 µs/entry of Ed25519 verify (ADR-0371), and that
    // distinction is the whole of why an operator costing replicas off the old sentence would have
    // concluded replication unaffordable.
    expect(IntegrityProofConfigSchema.parse({}).fromCheckpoint).toBe(true);
    expect(readme).toMatch(/loads the whole chain once per pass/);
  });

  it(".env.example names the variable, with a generator and the back-it-up warning", () => {
    // A route nothing documents is a route nobody takes, and this one has a second obligation the
    // other secrets do not: losing it does not merely cost a re-login, it costs the ability to
    // prove the chain intact.
    const example = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    // UNCOMMENTED, which is the whole assertion and which the first draft of this fence got wrong:
    // `toContain("AUDIT_CHAIN_SIGNING_KEY=")` passes on `#AUDIT_CHAIN_SIGNING_KEY=…`, so commenting
    // the line out was a mutation this fence did not catch — ADR-0377's exact finding (both column
    // and cursor secrets were *named* in this file and commented out, so naming was not setting)
    // reproduced in the fence written to prevent it, and caught by the mutation check rather than
    // by reading. Anchored to the line start, so a `#` anywhere ahead of it fails.
    expect(example).toMatch(/^AUDIT_CHAIN_SIGNING_KEY=\S+$/m);
    expect(example).toContain("randomBytes(32).toString(\"base64\")");
    expect(example).toMatch(/Back it up|KEEP IT/);
  });
});

describe("the tenant-settings grant", () => {
  const args = apiCommandArgs();

  it("names a grant at all, because the hardcoded default had no flag", () => {
    // `GET`/`PUT /v1/admin/settings` were governed by `DEFAULT_ADMIN_ROLES = ["erp_admin"]` with no
    // way to change it: `BuildOperateHttpServerOptions.adminRoles` existed, was forwarded into
    // `compileOperateServer`, and `node.ts` never set it. A deployment whose administrator is named
    // anything else simply could not reach its own tenant's settings.
    expect(args).toContain("--admin-role");
  });

  it("keeps the binary's own default, so no tenant administrator is locked out by the flag", () => {
    // `cli.ts` REPLACES the default rather than adding to it (`--ai-design-role`'s lesson), so
    // naming only `platform_admin` here would have taken the page away from every `erp_admin`.
    expect(valuesAfter(args, "--admin-role")).toContain("erp_admin");
  });

  it("grants the bootstrap operator, whose 403 on its own settings is the live defect", () => {
    // The documented walkthrough grants `platform_admin` in the api-key spec AND in the membership,
    // so before this flag the operator the stack ships reached a 403 on Settings and Billing while
    // the sidebar linked to both unconditionally. Measured live.
    expect(valuesAfter(args, "--admin-role")).toContain("platform_admin");
  });

  it("grants no role the command does not grant elsewhere, so the set is auditable", () => {
    // Not an equality against a literal pair — that would have to be edited by anyone adding a
    // third administrator — but a containment: every name here is one this command already hands
    // out somewhere, so a typo'd role (which fails CLOSED, as a dead page) is caught here rather
    // than by an operator finding Settings 403.
    const elsewhere = new Set([
      ...valuesAfter(args, "--platform-admin-role"),
      ...valuesAfter(args, "--platform-user-role"),
      ...valuesAfter(args, "--credential-admin-role"),
      ...valuesAfter(args, "--read-state-role"),
      ...valuesAfter(args, "--ai-design-role"),
      ...valuesAfter(args, "--design-review-role"),
      "erp_admin",
    ]);
    const unknown = valuesAfter(args, "--admin-role").filter((r) => !elsewhere.has(r));
    expect(unknown, `these --admin-role values are granted nowhere else on this command`).toEqual(
      [],
    );
    // Non-vacuity: the comparison set is real and the flag really is repeatable here.
    expect(elsewhere.size).toBeGreaterThan(1);
    expect(valuesAfter(args, "--admin-role").length).toBeGreaterThanOrEqual(2);
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

describe("the absence request signatures are withheld on", () => {
  const args = apiCommandArgs();

  it("passes no --hmac-key, because the flag cannot be a shipped default at all", () => {
    // Not a default decision of the usual kind and not blocked on a surface either (ADR-0376's two
    // shapes): `--hmac-key keyId:role:tenant:principalId` requires a **provisioned `meta.users`
    // UUID**, and that id is minted by the server during the documented bootstrap — the same reason
    // `OPERATE_ADMIN_API_KEY`'s placeholder tenant can never name a real tenant. So a key written
    // into `docker-compose.yml` would name a principal that does not exist until an operator has
    // run four HTTP calls, and ADR-0331's finding is that such an id breaks every per-person
    // surface through a foreign key. There is nothing a shipped compose could put here.
    //
    // The secret is the other half and is withheld with it: `REQUEST_SIGNING_SECRET` with no key is
    // the `no_keys` absence, which boots and reports, so shipping the variable alone would be a
    // secret in `.env.example` for a capability nothing uses.
    expect(args.join(" ")).not.toContain("--hmac-key");
    expect(readFileSync(COMPOSE, "utf8")).not.toContain("REQUEST_SIGNING_SECRET");
  });

  it("is reported at boot either way, so the absence is not silent", () => {
    // The thing that makes withholding it honest rather than quiet: `formatRequestSigningSurvey`
    // runs on every boot and says which it is, so an operator reading the log learns that signatures
    // are not verified and why — ADR-0376's rule, where what wants confirming is that a signed
    // request would be *accepted*, which is harder to confirm by trying than a refusal is.
    const node = readFileSync(resolve(here, "./node.ts"), "utf8");
    expect(node).toContain("formatRequestSigningSurvey");
    expect(node).toContain("REQUEST_SIGNING_ABSENCE_REFUSES_BOOT");
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
    // has 0 phi/regulated fields and 4 sortable classified fields (Account.billing_email and
    // Employee.given_name / family_name / work_email, re-measured after ADR-0443's M-26) — which
    // is the cursor secret's case, not this one's. Uncommenting this one would ask an operator to
    // generate a secret nothing reads.
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

/**
 * The Caddyfile's **live** directives, with every comment line removed.
 *
 * Read this way and not as raw text because the two questions this file is asked have opposite
 * answers in the same artifact: *is mutual TLS enabled* (no, and the fence must not be satisfied by
 * the commented block that documents it) and *is enabling it documented* (yes, in exactly that
 * block). A single read gets one of them wrong, and getting the first one wrong is the dangerous
 * direction — it would report the stack as requiring client certificates when it does not.
 *
 * ADR-0390's own class, one file over: there `pgDumpCommands` stripped markdown code spans on the
 * convention that a command in prose is always in backticks, and the live defect shipped as a code
 * span. The lesson is that a fence resting on *formatting* is one the next author satisfies by
 * changing the formatting, so here the discriminator is structural — Caddy's comment syntax is a
 * leading `#`, which is unambiguous.
 */
function caddyLiveDirectives(): string {
  const src = readFileSync(CADDYFILE, "utf8");
  expect(src.length, "deploy/Caddyfile is empty").toBeGreaterThan(500);
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("deploy/Caddyfile — the edge the trust declaration is about", () => {
  const live = caddyLiveDirectives();
  const raw = readFileSync(CADDYFILE, "utf8");

  /**
   * The belt to the gateway's braces, and the one assertion here that guards a live security
   * property rather than a default.
   *
   * The two are not redundant: the gateway's check is *did my operator declare this hop
   * trustworthy*, and this one is *did a client set this header*. A deployment that later passes
   * `--trusted-edge-client-cert` turns the first off, and then this strip is the only thing between
   * a caller and a forged client certificate — so it has to be in the **live** block rather than in
   * the commented recipe, which is what this reads the stripped text to prove.
   */
  it("strips the two edge-asserted headers unconditionally", () => {
    expect(live).toContain("header_up -CrossEngin-Client-Cert-Sha256");
    expect(live).toContain("header_up -CrossEngin-Tls-Version");
  });

  /**
   * Mutual TLS is **not** enabled, and must not become a default by accident.
   *
   * `require_and_verify` refuses every client presenting no certificate — including the browser
   * UI's own proxy and every existing integration — so turning it on is a decision about who may
   * reach the API at all, not a hardening default (ADR-0338's rule read the other way: something
   * does work today).
   */
  it("does not enable client_auth", () => {
    expect(live).not.toContain("client_auth");
    expect(live).not.toContain("require_and_verify");
    // And the header is never *set* in the live block, only deleted: setting it is what makes the
    // gateway trust a value, so a `header_up X {placeholder}` here with no `client_auth` above it
    // would assert a certificate nobody verified.
    expect(live).not.toMatch(/header_up CrossEngin-Client-Cert-Sha256/);
  });

  /**
   * And enabling it **is** documented, in the one place an operator doing it will look.
   *
   * The ordering clause is the load-bearing half: passing the flag without the Caddy block is the
   * dangerous order, because the gateway then believes a header anything upstream can send and
   * cannot detect that — a header its edge set and a header a caller set are the same bytes.
   */
  it("documents how to enable it, including the order and the published-port residual", () => {
    expect(raw).toContain("client_auth");
    expect(raw).toContain("--trusted-edge-client-cert");
    expect(raw).toContain("--mtls-client");
    // The fingerprint an operator must compute, and it must be the DER one — Caddy's placeholder
    // emits the certificate's own sha256, so a PEM digest would never match.
    expect(raw).toMatch(/outform der/);
    expect(raw).toContain("{http.request.tls.client.fingerprint}");
    // The two hazards, each named rather than left to be discovered.
    expect(raw).toMatch(/dangerous order/);
    expect(raw).toMatch(/BYPASSES Caddy|bypasses Caddy/);
  });

  /**
   * The compose file does **not** declare the edge trusted, and the reason is this stack's own
   * published port rather than caution.
   *
   * `docker-compose.yml` publishes `127.0.0.1:8787` so the documented bootstrap curls work
   * (ADR-0364's addendum), and that port bypasses Caddy — so declaring the edge trusted would let
   * any process on the VM forge a fingerprint. Withheld with its reason, which is the shape
   * ADR-0376 established for a default that reads as a free win and is not.
   */
  it("is not declared trusted on the shipped compose, and the Caddyfile says why", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    expect(compose).not.toContain("--trusted-edge-client-cert");
    expect(compose).not.toContain("--mtls-client");
    // Non-vacuity: the flag exists and the compose does pass its siblings, so the absence above is
    // a withheld default and not a flag nothing could pass.
    expect(compose).toContain("--credential-login");
  });
});

describe("every secret an operator must replace is named in README's first-launch list", () => {
  /*
   * Found by adding one (ADR-0406's `AUDIT_CHAIN_SIGNING_KEY`) and having to fix README in three
   * places by hand: the secrets list is prose, so a variable added to `.env.example` and to the
   * compose is invisible to it, and an operator following README sets the ones it names and reads
   * warn lines about the one it does not. ADR-0364's addendum class, created by the default.
   *
   * Derived from `.env.example` rather than restated, because a second list is the thing that went
   * stale. The discriminator is `SECRET_PLACEHOLDER_PREFIX` — the same marker `refuseWeakSecret`
   * refuses on (ADR-0377), so what counts as a must-replace secret is the binary's own answer and
   * not this test's taste.
   */
  const SECRET_PLACEHOLDER_PREFIX = "REPLACE_WITH_";
  const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
  const readme = readFileSync(README, "utf8");

  // `?? ""` and not a non-null assertion: a group the regex cannot fail to capture is still
  // `string | undefined` to `tsc`, and an assertion here would be the annotation standing in for a
  // check that ADR-0362 is about. An empty value simply is not a placeholder.
  const mustReplace = [...env.matchAll(/^([A-Z0-9_]+)=(\S*)$/gm)]
    .filter((m) => (m[2] ?? "").startsWith(SECRET_PLACEHOLDER_PREFIX))
    .map((m) => m[1] ?? "");

  it("finds the placeholder-bearing variables at all (non-vacuity floor)", () => {
    // Without this a regex that stopped matching would make every assertion below vacuous — the
    // shape that made ADR-0390's first three fences pass on a mutated tree.
    expect(mustReplace.length).toBeGreaterThanOrEqual(5);
    expect(mustReplace).toContain("AUDIT_CHAIN_SIGNING_KEY");
    expect(mustReplace).toContain("CURSOR_ENCRYPTION_SECRET");
  });

  for (const name of mustReplace) {
    it(`README names ${name}`, () => {
      expect(readme).toContain(name);
    });
  }

  it("names them where an operator reads before the first boot, not only later", () => {
    // The two lists an operator follows: the First launch `cp .env.example .env` comment and the
    // Oracle step-8 copy of it. Both drifted, so both are fenced — the Oracle one is the abridged
    // copy that ADR-0390 found with a dangling reference, which is why it is checked separately
    // rather than trusted to follow the first.
    // The window is 1200 rather than a round guess: measured, the First launch block's closing
    // fence is 1079 characters past its `cp` line and the Oracle one's is 330, so a 700-character
    // window silently matched only the second — caught by the floor below rather than by reading.
    const launchBlocks = [...readme.matchAll(/cp \.env\.example \.env[\s\S]{0,1200}?```/g)].map(
      ([block]) => block,
    );
    expect(launchBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of launchBlocks) {
      for (const name of mustReplace) {
        // POSTGRES_PASSWORD uses a different marker and is named in both; these are the five the
        // prefix finds, and each must appear in each list.
        expect(block, `${name} missing from a first-launch list`).toContain(name);
      }
    }
  });
});

/**
 * Prose about capabilities that are NOT there, fenced against the code that makes it true.
 *
 * Every assertion below pairs a sentence in a deploy document with the fact it rests on, read from
 * the source rather than restated, so the two cannot drift apart silently: a change that makes the
 * sentence false (a JWKS route that composes with the login, an import flag, a producer of an email
 * notification, an importer of the signal bridge) reds here and sends its author to the document.
 * Each block carries a floor, because a document that stopped saying the thing would otherwise pass
 * every absence assertion by saying nothing.
 */
const REPO_README = resolve(here, "../../../README.md");

/** Fenced blocks of any language, as their bodies — a prescription is something an operator pastes. */
function fencedBlocks(src: string): readonly string[] {
  return [...src.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/** Whitespace collapsed, so a fence on a phrase survives a re-wrap of the prose. */
function flat(src: string): string {
  return src.replace(/\s+/g, " ");
}

/** The non-test `.ts` sources of this app, for the producer census. */
function appSources(): readonly { readonly name: string; readonly src: string }[] {
  return readdirSync(here)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts"))
    .map((name) => ({ name, src: readFileSync(resolve(here, name), "utf8") }));
}

describe("federated identity is not documented as a path that cannot be followed (register P1.9)", () => {
  const cli = readFileSync(resolve(here, "./cli.ts"), "utf8");
  const docs = deployMarkdown();

  it("prescribes no --jwks-url in any pasteable block, because it cannot boot beside the login", () => {
    // Both deploy guides used to paste `--jwks-url …` plus a second `--jwt-issuer`/`--jwt-audience`
    // as the "production auth" step. The shipped command passes `--credential-login`, and the CLI
    // refuses the pair by name — so the prescription was a boot failure, and the duplicated issuer
    // and audience were last-wins on argv besides.
    for (const { doc, src } of docs) {
      for (const block of fencedBlocks(src)) {
        expect(block, `${doc} prescribes --jwks-url in a pasteable block`).not.toMatch(/--jwks-url\b/);
      }
    }
    // The refusal the prose quotes is the CLI's own, so the quotation is checked against it.
    expect(cli).toContain("--credential-login and --jwks-url are mutually exclusive");
    expect(apiCommandArgs()).toContain("--credential-login");
  });

  it("names EdDSA and the exclusion wherever a JWKS flag is mentioned at all", () => {
    // EdDSA because it is what a standard IdP does not do: `verifyBearerJwt` refuses any other
    // `alg` before a key is looked up, and a remote JWKS keeps only `OKP`/`Ed25519` entries.
    // Measured live: an RS256 token answers 401 `credential_malformed`.
    const verifier = readFileSync(
      resolve(here, "../../../packages/api-gateway-runtime/src/auth.ts"),
      "utf8",
    );
    expect(verifier).toContain('jwt.header.alg !== "EdDSA"');
    const mentioning = docs.filter(({ src }) => /--jwks-(?:url|key|file|\*)/.test(src));
    // Population floor: the single-VM and managed-cloud guides both explain the flags.
    expect(mentioning.map((d) => d.doc).sort()).toEqual(
      expect.arrayContaining(["README.md", "VERCEL-SUPABASE.md"]),
    );
    for (const { doc, src } of mentioning) {
      expect(src, `${doc} mentions a JWKS flag and never says EdDSA`).toMatch(/\bEdDSA\b/);
      expect(src, `${doc} mentions a JWKS flag and not the login exclusion`).toContain(
        "--credential-login and --jwks-url are mutually exclusive",
      );
    }
  });

  it("states that tenant_id is required, and what relaxing it costs, which is the highest-stakes precondition", () => {
    // A verified token with no `tenant_id` claim used to take its tenant from `x-tenant-id`
    // (ADR-0098); measured live, an EdDSA token without the claim answered 200 in whichever tenant
    // the header named. H-03 made the claim required, with `--jwt-optional-claim tenant_id` as the
    // relaxation. This assertion used to pin the old sentence ("the caller picks the tenant"),
    // which the change made false; it is fenced now against the claim set that makes the new one
    // true, and against the old sentence coming back.
    const auth = readFileSync(
      resolve(here, "../../../packages/api-gateway-runtime/src/auth.ts"),
      "utf8",
    );
    expect(auth).toContain('tenant_id: (v) => typeof v === "string" && v.length > 0');
    const readme = flat(deployDoc(README));
    expect(readme).toContain("**`sub` and `tenant_id` are required.**");
    expect(readme).toContain("`--jwt-optional-claim tenant_id`");
    expect(readme).not.toContain("No `tenant_id` claim means the caller picks the tenant.");
  });

  it("every documented serve command carries the login, and its document the two secrets", () => {
    // The managed-cloud guide's command omitted `--credential-login` while its troubleshooting
    // sent the reader to `/login`: a form that refused every password, because the route it posts
    // to was not mounted. A serve command is a fenced `operate-server.js` invocation with `--pack`.
    let commands = 0;
    for (const { doc, src } of docs) {
      for (const block of fencedBlocks(src)) {
        const joined = block.replace(/\\\n\s*/g, " ");
        if (!/operate-server\.js\b[^\n]*--pack\b/.test(joined)) continue;
        commands += 1;
        for (const flag of ["--credential-login", "--jwt-issuer", "--jwt-audience"]) {
          expect(joined, `${doc}: a serve command without ${flag}`).toContain(flag);
        }
        expect(src, `${doc}: no CREDENTIAL_PEPPER beside its serve command`).toContain(
          "CREDENTIAL_PEPPER=",
        );
        expect(src, `${doc}: no OPERATE_TOKEN_SIGNING_KEY beside its serve command`).toContain(
          "OPERATE_TOKEN_SIGNING_KEY=",
        );
      }
    }
    expect(commands, "no deploy document carries a serve command any more").toBeGreaterThanOrEqual(1);
  });
});

describe("GDPR rights other than erasure are said to be absent (register P1.4)", () => {
  it("ORACLE.md's subject-scope section says Article 15 and Article 20 have no route", () => {
    // Before this, nothing under deploy/ mentioned Article 15, Article 20, subject access or
    // portability, while the same section discussed Article 17 at length — so an operator could
    // read the deletion story and conclude the rest of GDPR was covered too.
    const oracle = deployDoc(ORACLE);
    const start = oracle.indexOf("**`--deletion-subject-scope` is a decision");
    const end = oracle.indexOf("**`--workflow-workers`", start);
    expect(start, "ORACLE.md lost the --deletion-subject-scope section").toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = flat(oracle.slice(start, end));
    expect(section).toContain("Article 15");
    expect(section).toContain("Article 20");
    expect(section).toContain("by any route");
  });

  it("the root README no longer pairs Art. 15 with 'closed', and data-lineage really is unimported", () => {
    const readme = flat(readFileSync(REPO_README, "utf8"));
    expect(readme).not.toContain("Three compliance triangles closed");
    expect(readme).toContain("`data-lineage` (Art. 15 access — contracts only");
    // The sentence is true only while nothing depends on the package; a dependency added later
    // reds here rather than leaving the README asserting an absence that ended.
    expect(workspaceDependents("@crossengin/data-lineage")).toEqual([]);
  });
});

/**
 * Every workspace `package.json` that declares a dependency on `name`, excluding the package's own.
 * The positive control lives with each caller: a name that IS depended on must come back non-empty.
 */
function workspaceDependents(name: string): readonly string[] {
  const root = resolve(here, "../../..");
  const out: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const member of readdirSync(resolve(root, group))) {
      let pkg: string;
      try {
        pkg = readFileSync(resolve(root, group, member, "package.json"), "utf8");
      } catch {
        continue;
      }
      const parsed: unknown = JSON.parse(pkg);
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (record["name"] === name) continue;
      for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = record[key];
        if (deps !== null && typeof deps === "object" && name in deps) out.push(`${group}/${member}`);
      }
    }
  }
  return out;
}

describe("workspaceDependents reads dependencies at all", () => {
  it("finds the dependents of a package that has them (non-vacuity for the absences above)", () => {
    expect(workspaceDependents("@crossengin/kernel").length).toBeGreaterThan(5);
  });
});

describe("there is no import route, and the README says so (register P1.13)", () => {
  const readme = deployDoc(README);
  const cli = readFileSync(resolve(here, "./cli.ts"), "utf8");
  const flags = [...cli.matchAll(/arg === "(--[a-z][a-z0-9-]*)"/g)].map((m) => m[1] ?? "");
  const importFlags = flags.filter(
    (f) => /import|bulk|backfill|onboard/.test(f) && f !== "--read-state-backfill-role",
  );

  it("reads the CLI's flags at all (non-vacuity)", () => {
    // `cli.ts` is an if/else chain of `arg === "--…"`, not a table. The one excluded flag is the
    // positive control: the pattern does match a name containing `backfill`, and it is excluded
    // because it marks notices read rather than loading records.
    expect(flags.length).toBeGreaterThan(100);
    expect(flags).toContain("--read-state-backfill-role");
  });

  it("claims the absence exactly when the CLI has no import flag", () => {
    // A biconditional and not `importFlags.length === 0` alone, which would pin the absence as a
    // specification (ADR-0412): an import flag landing makes this fail and points at the README
    // sentence that must change with it.
    const claimsAbsent = flat(readme).includes("**No import, backfill or bulk route.**");
    expect(claimsAbsent).toBe(importFlags.length === 0);
    expect(claimsAbsent, "the README's non-capabilities list lost the import row").toBe(true);
    expect(workspaceDependents("@crossengin/migration")).toEqual([]);
  });

  it("ties the loading hazards to the code and the compose they describe", () => {
    const section = flat(
      readme.slice(readme.indexOf("### Loading existing records"), readme.indexOf("## Rate limiting")),
    );
    expect(section.length, "the Loading existing records section is gone").toBeGreaterThan(500);
    // The idempotency window is the runtime's default and nothing passes another.
    const runtime = readFileSync(
      resolve(here, "../../../packages/api-gateway-runtime/src/runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain("opts.idempotencyTtlSeconds ?? 86_400");
    expect(section).toContain("86,400 seconds");
    const operatorSources = appSources().filter(({ src }) => src.includes("idempotencyTtlSeconds"));
    expect(operatorSources.map((s) => s.name), "something now sets the idempotency TTL").toEqual([]);
    // The duplicate hazard is stated for the store the compose ships.
    expect(valueAfter(apiCommandArgs(), "--store")).toBe("pg");
    expect(section).toContain("not enforced on `--store pg`");
    // The bootstrap key's role is the one the hazard names.
    const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    expect(env).toMatch(/^OPERATE_ADMIN_API_KEY=[^:\n]+:platform_admin:/m);
    expect(section).toContain("It carries `platform_admin`, which grants no operation on any entity");
    // The id and write-surface refusals are the create handler's codes, not prose of their own.
    const handlers = readFileSync(resolve(here, "../../../packages/operate-runtime/src/handlers.ts"), "utf8");
    for (const code of ["id_conflict", "record_id_malformed", "field_not_declared", "field_server_owned"]) {
      expect(handlers, `the create handler no longer answers ${code}`).toContain(`"${code}"`);
      expect(section, `the loading hazards no longer name ${code}`).toContain(`\`${code}\``);
    }
    expect(section).not.toContain("not a 409");
  });
});

describe("email and SMS are not documented as delivered (register P1.14)", () => {
  const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
  const docs = [...deployMarkdown(), { doc: ".env.example", src: env }];

  it("promises no backlog delivery and shows no email/SMS channel line as the expected check", () => {
    for (const { doc, src } of docs) {
      expect(flat(src), `${doc} still promises the backlog`).not.toMatch(
        /configuring a channel later delivers the backlog rather than losing it/,
      );
      // No verbatim boot line naming email or sms as a success check: the line is changing, and a
      // configured provider registers a sender and sends nothing.
      expect(src, `${doc} quotes a [notify] channel line with email or sms`).not.toMatch(
        /\[notify\] channels:[^\n]*\b(?:email|sms)\b/,
      );
    }
  });

  it("states the drop schedule the drain actually uses", () => {
    const plan = readFileSync(resolve(here, "./delivery-plan.ts"), "utf8");
    expect(plan).toContain("DEFAULT_MAX_DELIVERY_ATTEMPTS = 5");
    expect(plan).toContain("DEFAULT_INITIAL_BACKOFF_SECONDS = 30");
    expect(flat(deployDoc(README))).toContain("30, 60, 120 and 240 seconds apart");
    expect(flat(env)).toContain("30/60/120/240 s");
  });

  it("is true only while no source here addresses a non-in_app channel", () => {
    // The README says the one producer is the design-review notice and that it is in-app. A
    // dispatch literal on another channel landing in this app reds here and sends its author to
    // that sentence. The positive control is the in-app producer itself.
    const sources = appSources();
    const inApp = sources.filter(({ src }) => /channel: "in_app"/.test(src)).map((s) => s.name);
    expect(inApp).toContain("design-notifications.ts");
    const other = sources
      .filter(({ src }) => /channel: "(?:email|sms|push_mobile|voice_call|webhook)"/.test(src))
      .map((s) => s.name);
    expect(other, "a source now addresses a non-in_app notification channel").toEqual([]);
    expect(flat(deployDoc(README))).toContain(
      "nothing in this binary *produces* an email or SMS notification",
    );
  });
});

describe("the root README does not claim the signal bridge is wired (register P1.17)", () => {
  it("says the bridge is built and never registered, while nothing imports it", () => {
    const readme = flat(readFileSync(REPO_README, "utf8"));
    // Not "M6 closed …": the sentence sits in a blockquote, so `flat` leaves a `>` between the
    // two words and that spelling matched nothing even on the text it was written to refuse
    // (found by mutation). The claim itself is the phrase.
    expect(readme).not.toMatch(/closed the HTTP-webhook → workflow-signal chain/);
    expect(readme).toContain("built and never registered");
    expect(workspaceDependents("@crossengin/workflow-signal-bridge")).toEqual([]);
  });
});

/**
 * The compose stack connects the API as a role the row-level-security policies confine.
 *
 * It connected as `POSTGRES_USER`, which the official image makes a superuser holding BYPASSRLS and
 * owning every table `migrate` creates — any one of the three makes every policy in the catalog
 * inert for the session — so tenant isolation rested on the stores' `tenant_id` predicates alone
 * (which hold; the policies are the second belt). The split lives in three files no type or rule
 * reads, so each half is fenced here as text: the compose wiring, the overlay that replaces the
 * api's connection keys, and the script's refusals.
 */
function composeService(path: string, name: string): string {
  const src = readFileSync(path, "utf8");
  const start = src.indexOf(`\n  ${name}:\n`);
  expect(start, `${path} has no ${name} service`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + name.length + 4);
  const next = /\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/.exec(rest);
  return src.slice(start, start + name.length + 4 + (next?.index ?? rest.length));
}

/** A service block with its comment lines removed, so prose naming a key cannot satisfy a fence. */
function liveLines(block: string): string {
  return block
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

describe("the API connects as a role the row-level-security policies confine", () => {
  const AI_COMPOSE = resolve(here, "../../../deploy/docker-compose.ai.yml");
  const SCRIPT = resolve(here, "../../../deploy/postgres/roles/app-role.sql");
  const api = liveLines(composeService(COMPOSE, "api"));
  const appRole = liveLines(composeService(COMPOSE, "app-role"));

  it("overrides the owner's connection with the app role, never POSTGRES_USER", () => {
    // The fallback is the owner, so an upgraded .env with neither line lands on the announced
    // opt-out instead of on a refusal that leaves `api` created and never started.
    expect(api).toMatch(/^ {6}PGUSER: \$\{POSTGRES_APP_USER:-\$\{POSTGRES_USER\}\}$/m);
    expect(api).toMatch(/^ {6}PGPASSWORD: \$\{POSTGRES_APP_PASSWORD:-\$\{POSTGRES_PASSWORD\}\}$/m);
    // The anchor still supplies PGHOST/PGDATABASE; the two keys after it are what decides the role,
    // and a later edit restoring the owner's would read as harmless next to the merge line.
    expect(api).not.toMatch(/PGUSER: \$\{POSTGRES_USER\}/);
    expect(api).not.toMatch(/PGPASSWORD: \$\{POSTGRES_PASSWORD\}/);
  });

  it("does not start until the role has been created and granted, after migrate", () => {
    expect(api).toMatch(/ {6}app-role:\n {8}condition: service_completed_successfully/);
    expect(appRole).toMatch(/ {6}migrate:\n {8}condition: service_completed_successfully/);
  });

  it("runs the role script as the owner on every up, with the password from the environment", () => {
    expect(appRole).toContain("<<: *pg-env");
    expect(appRole).not.toMatch(/PGUSER:/);
    expect(appRole).toContain("CROSSENGIN_APP_DB_USER: ${POSTGRES_APP_USER:-${POSTGRES_USER}}");
    expect(appRole).toContain("CROSSENGIN_APP_DB_PASSWORD: ${POSTGRES_APP_PASSWORD:-${POSTGRES_PASSWORD}}");
    expect(appRole).toContain("- ./postgres/roles:/roles:ro");
    expect(appRole).toContain('command: ["-v", "ON_ERROR_STOP=1", "-f", "/roles/app-role.sql"]');
    // Not from /docker-entrypoint-initdb.d, which runs once per volume and before `meta` exists.
    expect(readdirSync(resolve(here, "../../../deploy/postgres/init"))).not.toContain("app-role.sql");
    // ADR-0301: the password is not on argv, where `ps` on the host reads it.
    expect(appRole).not.toMatch(/command:.*PASSWORD/);
  });

  it("keeps the self-hosted-AI overlay on the app role, since its environment replaces these keys", () => {
    const overlay = liveLines(composeService(AI_COMPOSE, "api"));
    expect(overlay).toContain("PGUSER: ${POSTGRES_APP_USER:-${POSTGRES_USER}}");
    expect(overlay).toContain("PGPASSWORD: ${POSTGRES_APP_PASSWORD:-${POSTGRES_PASSWORD}}");
    expect(overlay).not.toMatch(/PGUSER: \$\{POSTGRES_USER\}/);
    expect(overlay).toMatch(/ {6}app-role:\n {8}condition: service_completed_successfully/);
  });

  it("ships the password as a placeholder the role script refuses", () => {
    const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    expect(env).toMatch(/^POSTGRES_APP_USER=crossengin_app$/m);
    expect(env).toMatch(/^POSTGRES_APP_PASSWORD=REPLACE_WITH_\S+$/m);
    const script = readFileSync(SCRIPT, "utf8");
    // The prefix is `SECRET_PLACEHOLDER_PREFIX`; the script spells it in SQL, so the two are pinned.
    expect(script).toContain("starts_with(:'app_password', 'REPLACE_WITH_')");
    expect(script).toContain("WHEN :'app_password' = '' THEN");
    // An empty password is what an upgraded deployment meets, and that deployment answered correctly
    // as the owner, so the refusal names the opt-out beside the new line (ADR-0338's rule).
    expect(script).toContain("keep the API on the owner as before by setting POSTGRES_APP_USER and");
    // The fallback makes a half-configured .env give the app role the owner's password; refused.
    expect(script).toContain("WHEN :'owner_password' <> '' AND :'app_password' = :'owner_password' THEN");
    expect(script).toContain("\\getenv owner_password PGPASSWORD");
  });

  it("asserts every attribute that would bypass the policies, and grants the applier's log nothing", () => {
    // Comment lines removed first: the script's prose names all three bypassing attributes, so a
    // bare `toContain` passed with the `ALTER ROLE` that removes them deleted.
    const script = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(script).toContain("'ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE%s%s%s PASSWORD %L'");
    for (const [column, attr] of [
      ["rolsuper", "NOSUPERUSER"],
      ["rolbypassrls", "NOBYPASSRLS"],
      ["rolreplication", "NOREPLICATION"],
    ] as const) {
      expect(script, attr).toContain(`CASE WHEN r.${column} THEN ' ${attr}' ELSE '' END`);
    }
    // Membership in the owner and ownership of a table are the two routes the attributes miss.
    expect(script).toContain("pg_has_role(:'app_user', current_user, 'USAGE')");
    // And asked again AFTER the attributes are re-asserted: before it, a superuser answers true for
    // every role, so the first check skips one — and a SUPERUSER member of the owner, demoted, was
    // reported ready while `row_security_active` answered false for it (measured).
    const recheck = script.indexOf(" WHERE pg_has_role(:'app_user', current_user, 'USAGE')");
    expect(recheck).toBeGreaterThan(script.indexOf("'ALTER ROLE %I WITH"));
    expect(recheck).toBeLessThan(script.indexOf("GRANT CONNECT ON DATABASE"));
    expect(script).toContain("c.relowner = (SELECT oid FROM pg_roles WHERE rolname = :'app_user')");
    expect(script).toContain("REVOKE ALL ON meta._meta_migrations FROM %I");
  });

  it("says at boot whether the policies apply, and README quotes the line the code prints", () => {
    const node = readFileSync(resolve(here, "node.ts"), "utf8");
    expect(node).toContain("await surveyServingRole(conn,");
    // `--store pg-columns` creates its entity tables at boot, so the serving role owns them; a
    // survey of `meta` alone would print "confined" over every record read bypassing its policies.
    expect(node).toContain(
      '...(options.store === "pg-columns" ? [options.schema ?? COLUMN_STORE_DEFAULT_SCHEMA] : [])',
    );
    const survey = readFileSync(resolve(here, "serving-role-survey.ts"), "utf8");
    const readme = readFileSync(README, "utf8");
    expect(readme).toContain("### The database roles");
    for (const phrase of ["is confined on all", "BYPASSES the policies on"]) {
      expect(survey, phrase).toContain(phrase);
      expect(readme, phrase).toContain(phrase);
    }
  });
});

describe("the Article 17 pipeline connects as a dedicated eraser role, not the superuser (ADR-0458)", () => {
  const AI_COMPOSE = resolve(here, "../../../deploy/docker-compose.ai.yml");
  const SCRIPT = resolve(here, "../../../deploy/postgres/roles/eraser-role.sql");
  const api = liveLines(composeService(COMPOSE, "api"));
  const eraser = liveLines(composeService(COMPOSE, "eraser-role"));
  // Comment lines removed: the script's prose names every attribute and grant it discusses, so a
  // bare `toContain` would pass with the statement deleted (the app-role fence's measured lesson).
  const script = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  it("runs the role script as the owner on every up, after app-role, with the password from the environment", () => {
    expect(eraser).toContain("<<: *pg-env");
    // Anchored at the key: `${DELETION_PGUSER:-}` contains the substring and is not an override.
    expect(eraser).not.toMatch(/^\s*PGUSER:/m);
    expect(eraser).toMatch(/ {6}app-role:\n {8}condition: service_completed_successfully/);
    expect(eraser).toContain("CROSSENGIN_ERASER_DB_USER: ${DELETION_PGUSER:-}");
    expect(eraser).toContain("CROSSENGIN_ERASER_DB_PASSWORD: ${DELETION_PGPASSWORD:-}");
    expect(eraser).toContain('command: ["-v", "ON_ERROR_STOP=1", "-f", "/roles/eraser-role.sql"]');
    expect(eraser).not.toMatch(/command:.*PASSWORD/);
    expect(readdirSync(resolve(here, "../../../deploy/postgres/init"))).not.toContain("eraser-role.sql");
  });

  it("does not start the API until the eraser role has been provisioned, in both compose files", () => {
    expect(api).toMatch(/ {6}eraser-role:\n {8}condition: service_completed_successfully/);
    const overlay = liveLines(composeService(AI_COMPOSE, "api"));
    expect(overlay).toMatch(/ {6}eraser-role:\n {8}condition: service_completed_successfully/);
    // The API still passes the deletion credential through the environment and nowhere else.
    expect(api).toContain("DELETION_PGUSER: ${DELETION_PGUSER:-}");
    expect(api).not.toMatch(/command:.*DELETION_PG/);
  });

  it("names the dedicated role in .env.example, opt-in, with a placeholder the script refuses", () => {
    const env = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
    expect(env).toMatch(/^#DELETION_PGUSER=crossengin_eraser$/m);
    expect(env).toMatch(/^#DELETION_PGPASSWORD=REPLACE_WITH_\S+$/m);
    // Opt-in: no deletion flag is on the shipped command, so an uncommented line would provision a
    // BYPASSRLS role nothing uses.
    expect(env).not.toMatch(/^DELETION_PGUSER=/m);
    expect(script).toContain("starts_with(:'eraser_password', 'REPLACE_WITH_')");
  });

  it("makes the role NOSUPERUSER and BYPASSRLS, and refuses the routes back to a superuser", () => {
    expect(script).toContain("'ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE%s%s%s PASSWORD %L'");
    expect(script).toContain("CASE WHEN r.rolsuper THEN ' NOSUPERUSER' ELSE '' END");
    expect(script).toContain("CASE WHEN r.rolbypassrls THEN '' ELSE ' BYPASSRLS' END");
    // Any membership, in either direction, read from pg_auth_members rather than pg_has_role: a
    // superuser answers pg_has_role true for every role, and a member of pg_write_all_data or of the
    // app role inherits DELETE or UPDATE that BYPASSRLS stops the fences refusing.
    expect(script).toContain("JOIN pg_roles e ON e.oid = m.member");
    expect(script).toContain("WHERE e.rolname = :'eraser_user') THEN");
    expect(script).toContain("JOIN pg_roles e ON e.oid = m.roleid");
    // Refused before the role is created or altered, so a refusal touches nothing.
    expect(script.indexOf("JOIN pg_roles e ON e.oid = m.member")).toBeLessThan(
      script.indexOf("'CREATE ROLE %I LOGIN'"),
    );
    expect(script).not.toContain("pg_has_role(");
    expect(script).toContain("WHEN :'eraser_user' = :'app_user' THEN");
  });

  it("grants exactly what the pipeline issues, recomputed from the catalog, and nothing by default", () => {
    // Recomputed, not accumulated, so a table fenced since the last run loses its DELETE.
    const begin = script.indexOf("BEGIN;");
    const commit = script.indexOf("COMMIT;");
    expect(begin).toBeGreaterThan(0);
    // lastIndexOf: the retirement block revokes the same way, for a different role, before it.
    expect(script.lastIndexOf("REVOKE ALL ON ALL TABLES IN SCHEMA meta FROM %I")).toBeGreaterThan(begin);
    expect(script.lastIndexOf("GRANT SELECT, DELETE ON %I.%I TO %I")).toBeLessThan(commit);
    expect(script).toContain("a.attname = 'tenant_id'");
    expect(script).toContain("AND pg_get_expr(p.polqual, p.polrelid) = 'false')");
    expect(script).not.toMatch(/GRANT[^;]*UPDATE/);
    // No blanket read: an earlier version granted SELECT on every meta table, meta.users included,
    // and on every future one by default. Nothing is granted by default now, and the old default is
    // revoked on every run.
    expect(script).not.toMatch(/ON ALL TABLES IN SCHEMA meta TO/);
    expect(script).not.toMatch(/IN SCHEMA meta\s+GRANT/);
    expect(script).toContain("IN SCHEMA meta REVOKE ALL ON TABLES FROM %I");
    expect(script).toContain("REVOKE ALL ON ALL SEQUENCES IN SCHEMA meta FROM %I");
    expect(script).not.toMatch(/GRANT [A-Z, ]*ON ALL SEQUENCES/);
  });

  it("keeps the named grants in step with the erasure's statutory set and the pipeline's own list", () => {
    const named = (prefix: string): string[] => {
      const at = script.indexOf(prefix);
      expect(at, prefix).toBeGreaterThan(0);
      const array = /ARRAY\[([^\]]*)\]/.exec(script.slice(at))?.[1] ?? "";
      return [...array.matchAll(/'meta\.([a-z_]+)'/g)].map((m) => m[1] ?? "").sort();
    };
    const lifecycle = readFileSync(
      resolve(here, "../../../packages/tenant-lifecycle-pg/src/shared-table-erasure.ts"),
      "utf8",
    );
    const body = (constant: string): string => {
      const start = lifecycle.indexOf(`export const ${constant}`);
      expect(start, constant).toBeGreaterThan(0);
      return lifecycle.slice(start, lifecycle.indexOf("]);", start));
    };
    const statutory = [...body("STATUTORY_RETENTION_TABLES").matchAll(/\{ table: "([a-z_]+)", obligation:/g)].map(
      (m) => m[1] ?? "",
    );
    expect(statutory.length).toBeGreaterThanOrEqual(2);
    const pipeline = [
      ...body("DELETION_PIPELINE_PRIVILEGES").matchAll(/\{ table: "([a-z_]+)", privilege: "(SELECT|INSERT)"/g),
    ];
    expect(pipeline.length).toBeGreaterThanOrEqual(5);
    const selects = pipeline.filter((m) => m[2] === "SELECT").map((m) => m[1] ?? "");
    const inserts = pipeline.filter((m) => m[2] === "INSERT").map((m) => m[1] ?? "");
    expect(named("SELECT format('GRANT SELECT ON %s TO %I'")).toEqual([...statutory, ...selects].sort());
    expect(named("SELECT format('GRANT INSERT ON %s TO %I'")).toEqual([...inserts].sort());
    // The erasure targets the catalog fences against a tenant delete (`tenantUndeletableRecord`) are
    // still the tenant's to erase, so they are granted by name. Without them every deletion was
    // refused table_privilege_missing on the six, measured live (ADR-0458). Kept in step with
    // TENANT_UNDELETABLE_TABLES in both directions, and with the readback's exclusion list.
    const retention = readFileSync(
      resolve(here, "../../../packages/testing/src/strategy/pg-record-retention.ts"),
      "utf8",
    );
    const at = retention.indexOf("export const TENANT_UNDELETABLE_TABLES");
    expect(at).toBeGreaterThan(0);
    const undeletable = [
      ...retention.slice(at, retention.indexOf("]);", at)).matchAll(/table: "([a-z_]+)"/g),
    ].map((m) => m[1] ?? "");
    expect(undeletable.length).toBeGreaterThanOrEqual(6);
    expect(named("SELECT format('GRANT SELECT, DELETE ON %s TO %I'")).toEqual([...undeletable].sort());
    const readback = /c\.relname <> ALL \(ARRAY\[([^\]]*)\]\)/.exec(script)?.[1] ?? "";
    expect([...readback.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "").sort()).toEqual(
      [...undeletable].sort(),
    );
  });

  it("retires a role it provisioned once DELETION_PGUSER stops naming it", () => {
    expect(script).toContain("\\set marker 'crossengin:eraser-role'");
    expect(script).toContain("SELECT format('COMMENT ON ROLE %I IS %L', :'eraser_user', :'marker') \\gexec");
    const retire = script.indexOf("WHERE shobj_description(r.oid, 'pg_authid') = :'marker'");
    expect(retire).toBeGreaterThan(0);
    // Before both early exits, so unsetting the variable and pointing it at the owner each retire.
    expect(retire).toBeLessThan(script.indexOf("AS eraser_unset \\gset"));
    expect(retire).toBeLessThan(script.indexOf("AS eraser_is_owner \\gset"));
    expect(script).toContain("'ALTER ROLE %I WITH NOLOGIN%s'");
    expect(script).toContain("' NOBYPASSRLS'");
    expect(script).toContain(":'marker' || ':retired'");
  });

  it("leaves ADR-0453's owner configuration working and says so, rather than refusing an upgrade", () => {
    expect(script).toContain("SELECT (:'eraser_user' = current_user) AS eraser_is_owner \\gset");
    expect(script).toContain("SELECT (:'eraser_user' = '') AS eraser_unset \\gset");
  });
});

describe("the owner builds --store pg's unique indexes before the confined API starts (ADR-0423)", () => {
  const AI_COMPOSE = resolve(here, "../../../deploy/docker-compose.ai.yml");
  const api = liveLines(composeService(COMPOSE, "api"));
  const indexes = liveLines(composeService(COMPOSE, "document-indexes"));

  it("runs as the owner, because Postgres refuses CREATE INDEX to anyone else", () => {
    // Measured on PG 16: the app role gets 42501 "must be owner of table" for CREATE INDEX, and
    // IF NOT EXISTS does not help, since the ownership check precedes the existence check.
    expect(indexes).toContain("<<: *pg-env");
    expect(indexes).not.toMatch(/PGUSER:/);
    expect(indexes).not.toContain("POSTGRES_APP_USER");
  });

  it("builds the indexes for the pack the API serves, after migrate", () => {
    expect(indexes).toContain('"document-indexes", "--pack", "${OPERATE_PACK:-erp-core}"]');
    expect(valueAfter(apiCommandArgs(), "--pack")).toBe("${OPERATE_PACK:-erp-core}");
    expect(indexes).toMatch(/ {6}migrate:\n {8}condition: service_completed_successfully/);
  });

  it("holds the API back until they exist, in both compose files", () => {
    expect(api).toMatch(/ {6}document-indexes:\n {8}condition: service_completed_successfully/);
    const overlay = liveLines(composeService(AI_COMPOSE, "api"));
    expect(overlay).toMatch(/ {6}document-indexes:\n {8}condition: service_completed_successfully/);
  });
});

describe("the image and the stack are hardened (audit M-24)", () => {
  const DOCKERFILE = resolve(here, "../../../deploy/Dockerfile");
  const PG_DOCKERFILE = resolve(here, "../../../deploy/postgres/Dockerfile");
  const AI_COMPOSE = resolve(here, "../../../deploy/docker-compose.ai.yml");
  const live = (path: string): string =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
  const dockerfile = live(DOCKERFILE);

  it("builds in two stages and runs the second as the unprivileged node user", () => {
    // Measured on the image: 1.41 GB and uid 0 before, 644 MB and uid 1000 after; /app 827 MB → 252 MB.
    const froms = [...dockerfile.matchAll(/^FROM .* AS (\w+)$/gm)].map((m) => m[1]);
    expect(froms).toEqual(["build", "runtime"]);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));
    expect(runtime).toMatch(/^USER node$/m);
    // Nothing in the runtime stage installs or builds: every command there is `node <file>`.
    expect(runtime).not.toMatch(/pnpm|corepack|npm /);
  });

  it("reinstalls only the three apps' production dependencies before copying them across", () => {
    // `--prod` alone over the existing tree left vitest, TypeScript and eslint in the virtual store,
    // and a whole-workspace `--prod` still installed them through @crossengin/testing and
    // @crossengin/config; `--filter-prod` from the three apps is what keeps both out.
    expect(dockerfile).toMatch(/rm -rf node_modules apps\/\*\/node_modules packages\/\*\/node_modules/);
    expect(dockerfile).toContain("--frozen-lockfile --prod --ignore-scripts");
    for (const app of ["operate-server", "architect-cli", "operate-web"]) {
      expect(dockerfile).toContain(`--filter-prod "@crossengin/${app}..."`);
    }
  });

  it("pins every base image and every service image to an exact release, never latest", () => {
    const images = [
      ...[...dockerfile.matchAll(/^ARG NODE_IMAGE=(\S+)$/gm)].map((m) => m[1] ?? ""),
      ...[...live(PG_DOCKERFILE).matchAll(/^ARG POSTGRES_IMAGE=(\S+)$/gm)].map((m) => m[1] ?? ""),
      ...[...live(COMPOSE).matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1] ?? ""),
      ...[...live(AI_COMPOSE).matchAll(/^\s+image: (\S+)$/gm)].map((m) => m[1] ?? ""),
    ];
    // node, postgres, caddy, and ollama twice: five references, so a floor of five keeps a broken
    // matcher from passing over nothing.
    expect(images.length).toBeGreaterThanOrEqual(5);
    for (const image of images) {
      const tag = image.split(":")[1] ?? "";
      expect(tag, image).not.toBe("latest");
      expect(tag, `${image} is not pinned to an exact release`).toMatch(/^\d+\.\d+(\.\d+)?(-[a-z]+)*$/);
    }
    // Both FROMs go through the pinned ARG, so the pin is the image and not a default nobody uses.
    expect(dockerfile.match(/^FROM \$\{NODE_IMAGE\} AS /gm)?.length).toBe(2);
    expect(live(PG_DOCKERFILE)).toMatch(/^FROM \$\{POSTGRES_IMAGE\}$/m);
  });

  it("rotates every service's logs, in both compose files", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    // The services: block only. The top-level `volumes:` names and the `x-logging` anchor's own
    // `options:` are also two-space keys, so the slice keeps them out.
    const section = compose.slice(compose.indexOf("\nservices:\n"), compose.indexOf("\nvolumes:\n"));
    const services = [...section.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)].map((m) => m[1] ?? "");
    expect(services.length).toBeGreaterThanOrEqual(9);
    for (const name of services) {
      expect(liveLines(composeService(COMPOSE, name)), name).toContain("logging: *logging");
    }
    expect(compose).toMatch(/max-size: "10m"\n\s+max-file: "5"/);
    for (const name of ["ollama", "ai-pull"]) {
      expect(liveLines(composeService(AI_COMPOSE, name)), name).toMatch(/max-size: "10m"/);
    }
  });

  it("caps the memory of every long-running service, overridably, and of no one-shot", () => {
    // Measured idle after light load: api 101 MiB, web 106 MiB, db 80 MiB, backup 2 MiB; and Node
    // sized the API's heap at 524 MiB under the 1g default, so the limit caps the heap as well.
    const compose = readFileSync(COMPOSE, "utf8");
    const section = compose.slice(compose.indexOf("\nservices:\n"), compose.indexOf("\nvolumes:\n"));
    const names = [...section.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)].map((m) => m[1] ?? "");
    const longRunning = names.filter((n) =>
      liveLines(composeService(COMPOSE, n)).includes("restart: unless-stopped"),
    );
    expect(longRunning.sort()).toEqual(["api", "backup", "caddy", "db", "web"]);
    for (const name of names) {
      const block = liveLines(composeService(COMPOSE, name));
      if (longRunning.includes(name)) {
        expect(block, name).toMatch(/mem_limit: \$\{[A-Z]+_MEMORY_LIMIT:-\d+[mg]\}/);
      } else {
        expect(block, name).not.toContain("mem_limit");
      }
    }
  });

  it("starts web without pnpm, health-checks it, and holds Caddy until both upstreams are healthy", () => {
    const web = liveLines(composeService(COMPOSE, "web"));
    expect(web).not.toContain("pnpm");
    expect(web).toContain('command: ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]');
    expect(web).toContain("http://127.0.0.1:3000/login");
    const caddy = liveLines(composeService(COMPOSE, "caddy"));
    expect(caddy).toMatch(/ {6}web:\n {8}condition: service_healthy/);
    expect(caddy).toMatch(/ {6}api:\n {8}condition: service_healthy/);
  });
});

describe("the scheduled backup service (audit H-22)", () => {
  const SCRIPT = resolve(here, "../../../deploy/postgres/backup/run-backups.sh");
  const script = readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  const backup = liveLines(composeService(COMPOSE, "backup"));

  it("runs as the owner, as the image's postgres user, into a volume, with a health check", () => {
    // The owner because the app role is RLS-confined and its dump would omit every tenant's rows.
    expect(backup).toContain("<<: *pg-env");
    expect(backup).not.toMatch(/PGUSER:/);
    expect(backup).toContain("user: postgres");
    expect(backup).toContain('entrypoint: ["crossengin-backup"]');
    expect(backup).toContain("${BACKUP_DIR:-db-backups}:/backups");
    expect(backup).toContain("/backups/.last-verified");
  });

  it("dumps without a pipe, restores before keeping, and prunes only after a verified dump", () => {
    expect(script).toContain("set -euo pipefail");
    // `-f` and no pipe, so pg_dump's own status is the status (ORACLE.md's dump.sh lesson).
    expect(script).toMatch(/pg_dump -Fc --no-password -f "\$tmp"/);
    expect(script).not.toMatch(/pg_dump[^\n]*\|/);
    const restore = script.indexOf("pg_restore --exit-on-error");
    const move = script.indexOf('mv -- "$tmp" "$out"');
    const prune = script.indexOf("-mtime +\"$retention_days\" -print -delete");
    expect(restore).toBeGreaterThan(0);
    expect(move).toBeGreaterThan(restore);
    expect(prune).toBeGreaterThan(move);
    // A restore that created nothing also exits 0, so the table count is compared.
    expect(script).toContain('[ "$want" != "$got" ]');
  });

  it("checks every step by hand, because set -e does not reach a function called as an if condition", () => {
    // Measured with a psql failing both count queries: the unchecked form compared "" with "",
    // logged "restore check passed:  tables" and kept the dump.
    expect(script).toMatch(/\[ -z "\$want" \] \|\| \[ -z "\$got" \]/);
    expect(script).toContain('case "$want$got" in *[!0-9]*)');
    // An unchecked `mv` that failed would stamp .last-verified and prune the older dumps anyway.
    expect(script).toMatch(/if ! mv -- "\$tmp" "\$out"; then/);
    expect(script).toContain('date +%s > "$dir/.last-verified" || return 1');
  });

  it("is unhealthy as soon as a run fails, and honours the retry interval the README documents", () => {
    // The age check alone kept a failing service `(healthy)` for up to two intervals after its last
    // good run; measured on a stack whose every run since had logged FAILED.
    expect(script).toContain('date +%s > "$dir/.last-failed"');
    expect(script).toContain('rm -f "$dir/.last-failed"');
    expect(backup).toContain("test ! -e /backups/.last-failed &&");
    // The script reads BACKUP_RETRY_SECONDS and the README documents it, so compose must pass it.
    expect(backup).toContain("BACKUP_RETRY_SECONDS: ${BACKUP_RETRY_SECONDS:-600}");
  });
});

/**
 * Five flags asked P0.3's per-flag question again — does it serve what it mounts, is what it
 * records a claim, does its failure reach anybody, does its concurrency forge a finding, can its
 * cost be reclaimed, does it change the answer for a deployment that works today — and none passes
 * all six, so the command carries none of them. Each absence is fenced with the clause it fails, so
 * adding one back is a decision that has to answer the measurement rather than a line nobody read.
 */
describe("the five flags that stay off, each with the clause it fails", () => {
  const args = apiCommandArgs();

  it("passes no --rate-limit-policy: it refuses traffic that works today, and its record never shrinks", () => {
    // Clause 6: the in-memory default is 10,000/60s and nothing defaults a ceiling, so any declared
    // policy is a limit a working deployment did not have. Clause 5: every decision is an INSERT into
    // meta.rate_limit_decisions and no statement in the workspace deletes one (api-gateway-pg's only
    // DELETEs are the idempotency store's), so the table grows by one row per request for ever.
    expect(args).not.toContain("--rate-limit-policy");
    expect(args).not.toContain("--rate-limit-default-policy");
  });

  it("passes no --classified-write-mask: it changes no shipped field, and only refuses designs that omit a grant", () => {
    // Measured with surveySensitiveFields, mask off against mask on: 0 of the 173 resolved
    // sensitive-classified fields across the seven packs change writers, because each carries an
    // explicit grant since ADR-0348 — so on the boot pack the flag serves nothing (clause 1). Where
    // it does bite is a tenant design that classifies a field and grants nobody, which a model can
    // still emit (a prompt instructs, nothing validates): the mask turns that field from write-only
    // into a 403, and a *required* one makes its entity uncreatable, which the per-tenant survey
    // reports and does not refuse — a create that succeeds today would start failing (clause 6).
    // Measured on the Architect's worked example before and after it gained field grants: with no
    // grants both classified fields went from writable by [app_admin, app_user] to writable by
    // nobody; with grants they are unchanged, which is the case a validator would make universal.
    expect(args).not.toContain("--classified-write-mask");
  });

  it("passes no --schedule-ms: turning it on starts writing to the ledger on a deployment that works", () => {
    // Clause 6: the served erp-core jobs post depreciation, mark invoices overdue and raise invoices
    // from sales orders (ADR-0430), so the flag changes what a working deployment's books say. It is
    // also refused at parse without --schedule-tenant or --schedule-all-tenants, and which tenants a
    // scheduler writes into is a decision for the operator rather than a default.
    expect(args).not.toContain("--schedule-ms");
  });

  it("passes no --workflow-workers: with no producer mounted it has nothing to execute", () => {
    // Clause 1: no producer is on this command (--schedule-ms, --enable-job-invoke and
    // --emit-entity-events are all absent), so the job worker claims from a queue nothing fills, and
    // the timer and activity workers refuse no_definitions because nothing publishes a workflow
    // definition. A worker fleet that serves nothing reads, in the process list, as one that works.
    for (const producer of ["--schedule-ms", "--enable-job-invoke", "--emit-entity-events"]) {
      expect(args).not.toContain(producer);
    }
    expect(args).not.toContain("--workflow-workers");
  });

  it("declares no deletion capabilities: they mount nothing alone, and the surface they enable destroys data", () => {
    // Clause 1: the capability map mounts no route by itself. The routes it gates need a role and,
    // for the runner, --deletion-subject-scope, whose only servable value erases every subject in a
    // tenant when one subject asks (ADR-0379). Which of those a deployment exposes is a product
    // decision with an irreversible failure mode, not a default.
    for (const flag of ["--deletion-capabilities", "--deletion-capability", "--deletion-subject-scope"]) {
      expect(args).not.toContain(flag);
    }
  });

  it("fences flags the binary actually parses, so a rename cannot make an absence vacuous", () => {
    const cli = readFileSync(resolve(here, "./cli.ts"), "utf8");
    for (const flag of [
      "--rate-limit-policy", "--classified-write-mask", "--schedule-ms", "--workflow-workers",
      "--enable-job-invoke", "--emit-entity-events", "--deletion-capability", "--deletion-subject-scope",
    ]) {
      expect(cli, flag).toContain(`"${flag}"`);
    }
  });

  it("ships no launcher that configures a credential the console no longer reads", () => {
    // scripts/run-dev.ps1 started the API on --store memory with `--api-key devkey:…` on argv and the
    // console with OPERATE_API_KEY='devkey'. operate-web reads that variable nowhere since ADR-0358
    // and --credential-login refuses --store memory, so every console request it produced was a
    // 401. It is deleted rather than repaired: a working version is the documented bootstrap, and a
    // second copy of that is the copy that drifts (ADR-0364's addendum).
    const root = resolve(here, "../../..");
    const launchers = ["scripts/run-dev.ps1", "scripts/run-dev.sh"].filter((p) => {
      try {
        readFileSync(resolve(root, p));
        return true;
      } catch {
        return false;
      }
    });
    expect(launchers).toEqual([]);
  });
});

describe("CURSOR_ENCRYPTION_SECRET's second purpose is documented where an operator rotates it", () => {
  // ADR-0456 keys the AI-provider tenant pseudonym on this secret, so rotating or unsetting it
  // changes what a vendor sees. The only document an operator reads before rotating is the
  // variable's own comment, which said rotation costs a cursor 400 and nothing else.
  const envExample = readFileSync(resolve(here, "../../../deploy/.env.example"), "utf8");
  const readme = readFileSync(resolve(here, "../../../deploy/README.md"), "utf8");

  it(".env.example says the secret also keys the pseudonym, what rotation and unsetting cost", () => {
    const start = envExample.indexOf("# --- ");
    const at = envExample.indexOf("CURSOR_ENCRYPTION_SECRET=");
    expect(at, "the variable line is gone").toBeGreaterThan(start);
    const block = envExample.slice(envExample.lastIndexOf("# --- ", at), at);
    expect(block).toContain("ADR-0456");
    expect(block).toContain("NEW");
    expect(block).toContain("never the raw id");
  });

  it("README's boot-line list names the pseudonym line", () => {
    expect(readme).toContain("[ai-design] tenant pseudonym:");
  });
});

describe("every AI provider path is reachable from .env, and the overlay reaches Ollama", () => {
  const AI_COMPOSE = resolve(here, "../../../deploy/docker-compose.ai.yml");
  const ENV_EXAMPLE = resolve(here, "../../../deploy/.env.example");
  const api = liveLines(composeService(COMPOSE, "api"));
  const overlayApi = liveLines(composeService(AI_COMPOSE, "api"));
  const ollama = liveLines(composeService(AI_COMPOSE, "ollama"));

  it("forwards the AI variables the server reads, each empty when unset", () => {
    // Without these the free OpenAI-compatible path needed an edit to the `command`, because
    // OPENAI_BASE_URL never reached the container and a third-party model is refused at boot
    // without a declared price (ai-model-source.ts).
    for (const v of [
      "OPENAI_BASE_URL",
      "LOCAL_LLM_BASE_URL",
      "LOCAL_LLM_API_KEY",
      "OPERATE_AI_MODEL",
      "OPERATE_AI_MODEL_PRICE",
      "OPERATE_AI_MAX_OUTPUT_TOKENS",
      "OPERATE_AI_PROVIDER_TIMEOUT_MS",
    ]) {
      expect(api, v).toContain(`${v}: \${${v}:-}`);
    }
  });

  it("points the overlay at Ollama's /v1, because the local provider appends only /chat/completions", () => {
    // packages/ai-providers-local appends `/chat/completions` to the base and Ollama serves the
    // OpenAI-compatible route at /v1/chat/completions; the base without /v1 was a 404 per design.
    expect(overlayApi).toContain("LOCAL_LLM_BASE_URL: http://ollama:11434/v1");
    const localProvider = readFileSync(
      resolve(here, "../../../packages/ai-providers-local/src/provider.ts"),
      "utf8",
    );
    expect(localProvider).toContain('"/chat/completions"');
    expect(localProvider).not.toContain('"/v1/chat/completions"');
  });

  it("defaults the overlay to a model that fits a 12 GB VM, with room for the design prompt", () => {
    expect(overlayApi).toContain("OPERATE_AI_MODEL: ${OPERATE_AI_MODEL:-qwen2.5:7b-instruct}");
    expect(readFileSync(AI_COMPOSE, "utf8")).toContain('"pull", "${OPERATE_AI_MODEL:-qwen2.5:7b-instruct}"');
    expect(ollama).toContain("OLLAMA_CONTEXT_LENGTH: ${OLLAMA_CONTEXT_LENGTH:-16384}");
    expect(ollama).toMatch(/mem_limit: \$\{OLLAMA_MEMORY_LIMIT:-\d+g\}/);
    expect(overlayApi).toContain("OPERATE_AI_PROVIDER_TIMEOUT_MS: ${OPERATE_AI_PROVIDER_TIMEOUT_MS:-900000}");
  });

  it("leaves OPERATE_AI_MODEL unset in .env.example, so a hosted key keeps the provider's default", () => {
    // The base now forwards OPERATE_AI_MODEL, so an uncommented Ollama tag here would be sent to
    // Anthropic or OpenAI as a model id neither has.
    const env = readFileSync(ENV_EXAMPLE, "utf8");
    expect(env).not.toMatch(/^OPERATE_AI_MODEL=/m);
    expect(env).toMatch(/^# OPERATE_AI_MODEL=$/m);
  });
});
