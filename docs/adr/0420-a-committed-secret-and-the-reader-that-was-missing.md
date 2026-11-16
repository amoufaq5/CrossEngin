# ADR-0420: A committed secret, and the reader that was missing

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0382 (the CI workflow and the pre-commit hook, both running `pnpm --filter @crossengin/testing test`), ADR-0377 (`SECRET_PLACEHOLDER_PREFIX` and `refuseWeakSecret`'s `unreplaced_placeholder`), ADR-0301 (credentials never on argv), ADR-0333 (`pg-column-coverage.ts`, a rule that reads another package's source as text rather than importing it), ADR-0009 (the security baseline whose gitleaks claim this corrects) |

## Context

An external due-diligence audit examined commit `7bc8db9` and ranked its first finding critical:
**credentials committed on `main`**. `7bc8db9` is `2b98f46` plus one edit to `deploy/.env.example`,
and that edit put two values in the file — line 117, a `#`-commented value in Anthropic API key
format, 106 characters; and line 5, a non-placeholder `POSTGRES_PASSWORD`. The audit did not test
whether the key is valid.

A verification pass at HEAD `f6faf05` confirmed every part and placed it precisely:

- `7bc8db9` is the tip of `main` and `origin/main` and is contained by the audit branch
  `origin/claude/affectionate-archimedes-nf0hx3`. It is **not** an ancestor of the working branch,
  whose `deploy/.env.example` is clean: `POSTGRES_PASSWORD`, `DOMAIN` and `ACME_EMAIL` are
  placeholders and `ANTHROPIC_API_KEY` is empty.
- The audit's own commit carries only a redacted prefix of the key. A refuter noted that two module
  reports on the audit branch (`R09`, `R13`) carry a short prefix of the committed password; the full
  value is absent from both.
- Rotation cannot be verified offline, and the history has not been purged.
- **Nothing in the repository could have refused it.** There was no secret scanner in
  `.github/workflows/ci.yml` or in `.githooks/pre-commit`. The CI workflow and the hook run the
  workspace rules and the suite, and none of those reads a file for what it *contains* as opposed to
  what it *declares*. The audit's claims-versus-reality table recorded the gap against this
  repository's own text: ADR-0009 says *"No secrets in repository. CI enforces via `gitleaks` and a
  custom scanner that fails the build on regex matches"*, and there was neither.

The audit's remedy has three parts: revoke and rotate both values now, purge them from history, and
add secret scanning as a merge gate. Measured against what this repository can do:

- **Rotation** needs access to the key's provider account and to every database the password was
  used for. Nothing in this workspace has either, and it is the only one of the three that removes
  the exposure.
- **Purging history** rewrites `main`, which is published, and every clone's history. It shortens
  how long the value is easy to find and does not unpublish it: anyone who cloned or fetched already
  holds it.
- **Scanning** is the only part that is a change to this repository, and it prevents the next
  commit, not this one.

## Decision

**Secret scanning is a workspace rule; rotation and history rewriting are the owner's decisions and
are not taken here.**

`packages/testing/src/strategy/secret-values.ts` is a workspace rule, run by the suite that the
pre-commit hook and the CI *Workspace rules* step already run (`pnpm --filter @crossengin/testing
test`), so it needed no new wiring in either place. It reads every tracked file — the index, both
path and **content**: the staged blob, not the working copy, because the blob is what a commit
publishes. A file staged for the first time is in scope, so `git add -f deploy/.env` is refused; a
file nobody has staged is not, because it is not about to be published and `.gitignore` already
excludes `.env`.

Two families of finding:

- **Pattern** — a value whose own shape says it is a credential, wherever it appears. Seven kinds in
  a total map: `anthropic_api_key`, `openai_api_key`, `aws_access_key_id`, `pem_private_key` (the
  header plus a body, across a real newline or the `\n` escape), `slack_token`, `github_token`,
  `stripe_live_key`.
- **Assignment** — a secret-named variable given a literal value in a file whose job is to hold such
  values. In an env file the only safe values are empty, an interpolation, or a placeholder carrying
  `SECRET_PLACEHOLDER_PREFIX`; in a YAML file, an interpolation. The prefix is read out of
  `@crossengin/crypto`'s source **as text** rather than imported, so the rule stays green or red with
  no build in between (`pg-column-coverage.ts`' reason, ADR-0333), and it is the same prefix `refuseWeakSecret` refuses at
  boot, so the scanner and the binary cannot disagree about what a placeholder is.

Four rules decide what counts, each the answer to a measured bypass (below):

- An interpolation is a reference only if it is exactly one `${NAME}` whose default, if any, is
  itself acceptable: `${X:-}`, `${X:?message}`, a nested `${X:-${Y}}` and GitHub's `${{ … }}` pass;
  `${X:-<literal>}` and `${X}<literal>` do not, because compose substitutes that literal whenever the
  variable is unset.
- An env file is any basename in which `.env` or `.envrc` ends the name or is followed by `.`, `-` or
  `_`; `env.ts` is not one.
- An upper-case name is matched on substring (`DBPASSWORD` is a plausible spelling); a name with a
  lower-case letter is matched on whole tokens, because a substring match would flag `keyv:` in
  `pnpm-lock.yaml`.
- Any number of `#` marks a commented line, so a commented value is still read — which is where the
  committed key sat.

**No finding carries a value.** A finding is a path, a line, a kind, the variable name and a length,
because a scanner that echoes the secret into a CI log publishes it a second time.

**Exceptions are declared with exact counts and compared in both directions.**
`SECRET_SCAN_EXEMPTIONS` holds one entry — `email-ses.test.ts`, one `aws_access_key_id`, AWS's own
published example pair — and `DECLARED_PLACEHOLDERS` one: `deploy/.env.example`'s
`POSTGRES_PASSWORD`, matched on its exact placeholder value, since Postgres reads that variable
directly and `refuseWeakSecret` never sees it, so it has no reason to carry the prefix. The audit
reports `exemption_count_changed`, `exemption_overtaken` and `placeholder_overtaken` as well as
`secret_value`, so a real key added beside a declared fake is still a finding and a declaration
nobody needs is not left as a hole. Two non-vacuity floors — at least 25 secret-named assignments
examined and at least 20 accepted — stop a scanner that silently stopped reading from passing.

`deploy/README.md` gains *If a credential was committed*: rotate first, rewriting history is a
separate decision that never substitutes for rotation, and the scanner only prevents the next one.

## Alternatives considered

- **Adopt gitleaks (what ADR-0009 claimed).**
  - **Pros:** a maintained rule set far wider than seven patterns.
  - **Cons:** a binary dependency the CI and the hook would both have to install, with its own
    allow-list format outside the workspace rules' both-directions comparison, and no knowledge of
    this repository's placeholder prefix.
  - **Why not:** the hook and CI already run one command, and a rule inside it is covered by the same
    vacuity floors and declaration audits as every other workspace rule. A wider pattern set is an
    open question rather than a reason for a second gate.
- **Read the working tree, as the other workspace rules do.**
  - **Why not:** measured as a bypass (B7 below): stage a file holding the key, delete it from the
    working copy, commit without re-staging, and the key is published while pre-commit passes.
- **Rewrite `main` and rotate in this increment.**
  - **Why not:** both are decisions only the repository owner can take — rotation needs credentials
    this workspace does not hold, and rewriting published history needs the owner's explicit
    go-ahead. Neither is done, and nothing here claims either was.
- **Exempt by path pattern instead of exact count.**
  - **Why not:** a path exemption would let a real key land in any exempt file. An exact count turns
    a second key beside the fake into a finding.

## Consequences

- **Positive:** the next committed credential of a covered shape is refused by the hook at commit
  time and by CI at merge time, with no new wiring. ADR-0009's enforcement claim has a mechanism
  behind it, narrower than gitleaks.
- **Negative:** the exposure the audit found is untouched. **C-01 stays critical** until the key is
  revoked and the password changed: the values are on `main`, `origin/main` and the audit branch.
- **Neutral:** the hook only runs where `core.hooksPath` is installed; CI is the gate that does not
  depend on that.
- **Reversibility:** deleting the module removes the rule; nothing else depends on it.

### Verified

**Suite:** `@crossengin/testing` typecheck and build clean, 23 files / 796 tests, 38 of them in
`secret-values.test.ts`.

**Over the committed tree**, a direct run of the rule over the index: **2,655** tracked text files,
**0** binary; **32** secret-named assignments examined, **25** accepted as placeholders or
references, **1** declared placeholder matched; **1** finding — `email-ses.test.ts:25`
`aws_access_key_id`, covered by the one exemption. The review and an independent live re-run
reported the same counts.

**Against `7bc8db9`**, the control that the rule would have refused the actual commit: three
findings, at lines 5, 117 and 118, the line-117 value reported as 106 characters, with no value
printed.

**An adversarial review found nine bypasses in the first version, B1–B9, and all nine are fixed**;
each was probed against the built rule and was missed before the fix and caught after it:

- **B1** a compose or env default, `${X:-<literal>}`, passed because any value starting `${` was
  accepted — the most realistic accident, since the compose file writes `${CREDENTIAL_PEPPER:-}` on
  every secret line and adding a "dev default" publishes it;
- **B2** trailing text after the brace, `${X}<literal>`;
- **B3** a line commented with `##`;
- **B4** a lower-case env name, `db_password=`;
- **B5** `.envrc`, `.env-prod`, `prod.env.bak` not treated as env files;
- **B6** lower-case or camelCase YAML keys (`password:`, `apiKey:`);
- **B7** the partial-stage bypass: content read from the working tree, not the index;
- **B8** a non-vacuity floor of 25 equal to the measured 25, so removing one compose variable for a
  legitimate reason would have turned the build red — now 25 and 20 on two measures;
- **B9** a comment claiming three modules name the PEM header to recognise one, when two are tests
  building fixtures.

**Mutation checks**, each restored by reversing the exact edit with the file's hash verified:
accepting any default → 1 test fails; the old `isEnvFile` → 1 fails; swallowing a missing object →
1 fails; substring matching for every name → 3 fail; reading the working tree instead of the index →
the staged-then-removed test fails.

## Implementation notes

- `readTrackedTextFiles` reads staged blobs with `git ls-files --stage` and one
  `git cat-file --batch` call. A conflicted path is read once; a submodule entry is skipped; an
  object git reports missing **throws** rather than reading as empty, since an empty read is
  indistinguishable from a clean file.
- `packages/testing/src/strategy/index.ts` re-exports the module.
- The `.githooks/pre-commit` comment still says the hook checks *"the WORKING TREE, not the index"*,
  which remains true of the other rules and is no longer true of this one. Left because the hook is
  outside this increment's files and needs no wiring change.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Revoke the committed key at its provider and change the database password wherever it was used. The only step that removes the exposure. | repository owner | _unscheduled_ |
| Whether to rewrite `main` (and the audit branch, whose `R09`/`R13` reports carry a short password prefix). Shortens discoverability; does not unpublish; rewrites every clone. | repository owner | _unscheduled_ |
| No pattern for an AWS secret access key, a Stripe `whsec_` signing secret, or a PEM split across string concatenation. | platform | _unscheduled_ |
| A literal password assigned in a Dockerfile, a JSON file or a TypeScript constant is not an assignment finding; only the seven patterns apply there. | platform | _unscheduled_ |
| A value beginning `REPLACE_WITH_` passes by definition, so a real secret pasted after the prefix is accepted. | platform | _unscheduled_ |
| The rule reads the index, not history: nothing scans what is already committed on other refs. | platform | _unscheduled_ |
| ~~Correct the `.githooks/pre-commit` comment that says every rule reads the working tree.~~ **Closed** (see the last line of this ADR). | platform | closed |

## References

- Corrections to the inputs this ADR is built from:
  - The verification's C-01 residual, *"no secret scanner in CI or pre-commit"*, was true at HEAD
    `f6faf05` and is closed by this ADR; the rest of that residual (the values in published history,
    rotation unverified) is not.
  - ADR-0009's *"CI enforces via `gitleaks` and a custom scanner"* was false: there was neither.
    The custom-scanner half is true as of this ADR; the gitleaks half is still false.
  - The first version's module comment and README said the rule *"reads files the index holds"*;
    that was true of which paths are read and false of their content until B7 was fixed, and the
    module's claim that `git add -f deploy/.env` *"is refused like any other"* was false in exactly
    the partial-stage case.
- The audit report (`ERP_DUE_DILIGENCE_REPORT.md`, finding C-01, recommendation 1, and the
  claims-versus-reality row for ADR-0009) and its verification at HEAD `f6faf05` (§2, §6 and §8).
- ADR-0382, ADR-0377, ADR-0301, ADR-0333, ADR-0009.

**Addendum.** The `.githooks/pre-commit` comment is corrected, closing the last open question: it now says `secret-values.ts` reads the index — staged paths from `git ls-files --stage`, content from `git cat-file --batch` — while the other rules read the working tree, so a partial stage can still hide a non-secret finding from them until CI (`sh -n` passes; recorded in ADR-0419's addendum, which landed it).
