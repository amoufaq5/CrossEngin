# ADR-0484: The Architect CLI refuses what it cannot show, and the secret rule reads the part of a value it names

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0436 (CLI file tools confined to a root), ADR-0420 (the secret-values rule), ADR-0438 (strict apply flags, read-only plan), ADR-0388 (the section census), ADR-0454 and ADR-0459 (the signed pack release), ADR-0361 (an aperture narrower than the artifact), ADR-0372 (tests that pin a defect), ADR-0301 (no credential on argv) |

## Context

Thirteen open items against `apps/architect-cli` and `packages/testing/src/strategy/secret-values.ts`,
each re-measured against the tree before it was designed against (register P3.1). All thirteen held;
none was already closed. What each one was, measured:

1. **A hard link escaped the file root.** `readConfinedText` and `writeConfinedText` open with
   `O_NOFOLLOW` and confine by real path, which stops a symlink and stops nothing about a hard link: a
   second name inside the root for a file outside it has a real path inside the root. Measured with a
   link to a file outside the root, both the read and the write went through. The write was worse than
   the read in a way that decided the fix: it opened with `O_TRUNC`, so the file was emptied **at
   open**, before any check on the descriptor could run.
2. **A truncated diff was offered for approval.** `unifiedDiff` caps at `MAX_DIFF_LINES` (400) and the
   capped text was what the y/N approver was shown, so a person approved an edit whose tail they had
   not seen.
3. **The implicit file root could be the home directory.** With no `--file-root` the root is the
   working directory, and a `crossengin chat` started from `~` put every non-hidden file in the home
   directory within reach of a model with no flag saying so.
4. **A file-tool error disclosed the absolute path.** The tool result carried `err.message`, which for
   an errno error names the real path (`EACCES: permission denied, open '/home/alice/…'`), back into
   the model's context.
5. **The OpenAI key pattern's `requires` tested the whole match.** Its three tests are a digit, an
   upper-case letter and a lower-case letter, and the whole match always begins `sk-`, so the
   lower-case test was satisfied by the prefix: `sk-` plus forty upper-case letters and digits passed
   all three. Both
   copies — the rule's and the CLI's own — carried it, and a test asserts the two are source-identical.
6. **Two key shapes were not recognised**: a Stripe webhook secret (`whsec_…`) and an AWS secret
   access key, which has no prefix and is recognisable only in context.
7. **A Dockerfile was not scanned.** `ENV` and `ARG` assignments are the one place a Dockerfile holds a
   literal, and the assignment arm read only env and YAML files.
8. **A placeholder was any value starting with `REPLACE_WITH_`.** `REPLACE_WITH_x; real-secret` passed.
9. **The Architect's one hard refusal read raw fields.** `detectEncryptionWeakening` walked
   `entity.fields`, so moving `phi` → `internal` on a field a trait contributes was permitted — the
   `fails_open` member ADR-0361's aperture rule declared for this file.
10. **A flag given twice was last-wins on `apply`**, the one command whose effect is DDL against a live
    database: `apply --plan --plan=false` was an apply. And `apply` had no help of its own; the
    top-level text lists four of its eight flags beside every other command's.
11. **`apply --plan` was refused on a production-looking database without `--confirm`**, though a plan
    applies nothing — its probe statements are rolled back. A test pinned the refusal (ADR-0372).
12. **`crossengin diff` counted entities and hardcoded the workflow figures to zero**, so two manifests
    differing only in workflows, roles, permissions, jobs, views or `meta.extends` printed
    `(no changes)`.
13. **There was no way to check a signed pack release before submitting it.** `pack sign` printed a
    submission; nothing in the CLI ran the verifier the authoring route runs.

## Decision

**The file tools refuse a file with more than one name, and check before they destroy.** After open,
on the descriptor already held, `nlink > 1` is a `hard_link` refusal on both the read and the write.
The write opens `O_WRONLY | O_CREAT` without `O_TRUNC`, checks, and only then truncates — so a
refused write leaves the linked file intact rather than emptied. The refusal is conservative: a pair
of names both inside the root is refused too, because nothing cheap tells the two cases apart and the
cost of a false refusal is one error message.

**A diff the person cannot see in full is not offered for approval.** `fullUnifiedDiff` builds the
whole diff and `diffExceedsCap` decides; past 400 lines the write is answered
`diff_too_large_to_review` naming the line count, and the approver is never called. An approver that
declares `showsDiffToPerson: false` (the auto-approver) still gets the write, with the capped text;
an approver that declares nothing is treated as a person, which is the fail-closed reading.

**The implicit root may not be the home directory; an explicit one may, and is named.**
`resolveFileRoot(dir, {implicit})` refuses `implicit_home_root` by real path (so a symlinked alias of
home is caught), and an unresolvable home refuses nothing. An operator who passes `--file-root ~` gets
it, and the startup line says the root is their home directory.

**A file-tool error names its errno code and the relative path, nothing else.** `fileToolError`
renders a refusal by its own message, an errno error as `<tool>: <CODE> on <requested path>`, and
passes any other error through unchanged.

**A pattern's `requires` applies to the part of the match it names.** `requiresSubject` reads capture
group 1 when there is one, so the OpenAI body requirement is a requirement on the body. Two patterns
are added: `whsec_` plus at least 24 alphanumerics, and an AWS secret access key **only in context**
(the variable name `aws_secret_access_key` in any of its spellings, including one carrying a prefix
such as `TF_VAR_` or `S3_`, an assignment, and exactly 40 characters of the key alphabet with mixed
case and a digit). The name is anchored by `(?<![A-Za-z0-9])` and not `\b`: `_` is a word character,
so a `\b` anchor missed every prefixed name. A bare 40-character string is not
recognised and cannot be without drowning the rule in hashes and base64. Dockerfile `ENV` and `ARG`
assignments are scanned for secret-named variables (`K=V`, continuation lines joined, the legacy
`ENV K V` form uncommented only); JSON and TypeScript stay out of the assignment arm. A placeholder
must match `^REPLACE_WITH_[A-Z0-9_]+$`, and the one shipped placeholder that does not —
`OPERATE_ADMIN_API_KEY`'s spec, which is a placeholder token followed by a role and a tenant — is
declared by exact value in `DECLARED_PLACEHOLDERS` rather than the shape being widened.

**The weakening refusal reads the kernel's own classification diff.** `detectEncryptionWeakening` is
`fieldClassificationChanges(current, proposed)` filtered to a change that drops encryption, which
resolves each side against its own manifest's traits — the same function the reviewer's diff layer
uses, so the two cannot disagree about which fields changed class. `isAuditable` already resolved
traits and is left as it was, with a comment saying so.

**A repeated flag is recorded by the parser and refused by `apply`.** `ParsedCommand.repeatedFlags`
is set by `parseArgs`, which keeps last-wins for the commands that want it; `readApplyFlags` refuses
any repeat by name before the environment is read. `apply --help` prints a text built from
`APPLY_FLAG_HELP`, a total map over `APPLY_FLAG_KINDS`, so a ninth flag is a compile error until it
has a sentence, and a test asserts the help names exactly those flags plus `--help`. Help runs
nothing, even beside `--confirm`. `pack verify` refuses a repeat the same way.

**`--plan` is exempt from the production guard; an apply is not.**

**`crossengin diff` prints the section census.** One line per section `diffManifestSections` reports,
`<section> [<reach>]: +a -r ~c` (or `section added` / `section removed` / `changed (members unkeyed;
n -> m)`), the member names, and the section's `reachNote` — sent by the kernel rather than restated,
for ADR-0388's reason. The JSON form carries `sections` beside the existing `diff`. `formatDiff` and
its hardcoded zeros are deleted.

**`crossengin pack verify <manifest.json> --release <file> --publisher-key <ns:kind:pub> [--bundle
<file>]`** runs `verifyPackPublisher` over the manifest and the release file (with the bundle's own
digest when `--bundle` is given) and then `verifyStoredRelease` over the submission's own stated
facts, so a release file whose `packId` or `manifestSha256` was edited is refused as the version row
it would become. Exit 0 verified, 1 naming the first refusal from the server's own vocabulary (plus
`manifest_unreadable`, `release_unreadable`, `bundle_unreadable`), 2 for an unusable command. It reads
either the whole `pack sign` output or a bare submission body.

## Alternatives considered

- **Compare inode and device of the opened file against a stat of every name** — the precise answer to
  "is the other name outside the root", and unavailable: nothing enumerates a file's other names.
- **Truncate the diff and say so in the prompt** — refused: approval is consent to what was shown, and
  a sentence saying more exists is not the more.
- **Widen the placeholder shape to admit the spec form** — refused: the shape is the fence, and one
  declared exact value is cheaper than a shape that admits a token followed by anything.
- **Make a bare 40-character AWS-alphabet string a finding** — refused on false positives.
- **Refuse repeated flags in `parseArgs` for every command** — refused: several commands read a flag
  once and nothing they do depends on order; the refusal belongs where the order is consequential.
- **Keep the entity counter and add a workflow counter** — refused: it would be the second partial
  census of seventeen sections, where the kernel already has the total one.

## Consequences

- A hard-linked file is unreachable through the file tools even when both names are in the root.
- An edit over 400 diff lines cannot be approved by a person; the model is told to propose a smaller one.
- `apply --plan` against `crossengin_production` now connects without `--confirm`.
- `crossengin diff` output changed shape for every caller; the JSON gained a key and lost none.
- **`packages/testing/src/strategy/entity-field-aperture.ts`'s declaration for
  `apps/architect-cli/src/refusal.ts::detectEncryptionWeakening` is now `overtaken`**, which is that
  rule working: the reader no longer reads raw fields. The declaration must be deleted and the test's
  raw-reader floor (`>= 14`) lowered to 13. Both are outside this slice's files and are left for the
  owner of that rule; until then four tests in that file are red.

## Implementation notes

- `refuseHardLink(path, nlink)` in `file-confinement.ts`; `FILE_REFUSAL_REASONS` gained `hard_link` and
  `implicit_home_root`; `isHomeDirectory` compares real paths.
- `fullUnifiedDiff`, `diffExceedsCap` in `unified-diff.ts`; `unifiedDiff` is the two composed.
- `fileToolError` in `tools.ts`; the root is memoised per `(dir, implicit)`.
- `requiresSubject` exported from `secret-values.ts`; `assignmentsIn(text, family)` over a total map
  `ASSIGNMENT_KIND_OF_FAMILY`.
- `APPLY_FLAG_HELP`, `applyHelpText` in `apply.ts`; `repeatedFlags` on `ParsedCommand`.
- `formatManifestSectionDiff` in `format.ts` with a total map over `ManifestSectionPresence`.
- `PACK_ACTIONS` and `PACK_VERIFY_INPUT_REFUSALS` in `pack.ts`.

## Verification

- `@crossengin/architect-cli`: build, typecheck and test green — 14 files, 345 tests.
- `@crossengin/testing`: typecheck green; `secret-values.test.ts` 46 of 46, including the real tree
  with zero new findings. The package's run is 820 passed / 9 failed: four in
  `entity-field-aperture.test.ts` are the overtaken declaration above, and five in
  `pg-unreadable-rows.test.ts` name `apps/operate-server` files another slice is changing.
- Mutation-checked: removing the read arm's `refuseHardLink` fails 2 tests, the write arm's 1,
  restoring `O_TRUNC` 1 (the linked file is emptied); disabling the truncation refusal fails 1;
  removing the `--plan` exemption fails 1; reading the whole match in `requiresSubject` fails 3
  (one over the real tree); a `startsWith` placeholder test fails 3; removing the declared spec
  placeholder fails the real-tree test at `deploy/.env.example:108`. Every mutation was applied by
  string replacement against a backup and restored with `cmp` confirming the file byte-identical.
- Adversarial review (same session, before commit) found and fixed three things: the AWS context
  pattern's `\b` anchor missed a prefixed name (`TF_VAR_aws_secret_access_key=…`,
  `S3_AWS_SECRET_ACCESS_KEY: …`), measured by scanning both and fenced by two new cases plus a
  `notaws_secret_access_key` negative; restoring `\b` fails 1 test. The CLI's pattern-agreement test
  still applied `requires` to `m[0]`, the predicate this ADR retires — it now uses `requiresSubject`.
  And a malformed line in `DECLARED_PLACEHOLDERS`. One reach limit was measured and left: a
  pattern finding's `length` is the whole match, so an AWS finding reports 64 (name included) rather
  than the 40 of the key.
- No live Postgres: nothing here reaches SQL except `apply --plan`'s guard, whose test reaches a
  closed port past the guard.

## Open questions

1. `classifyManifestEditRefusal` still has no caller outside its test, so the widened read protects
   nothing until the gate is wired.
2. The hard-link refusal refuses in-root pairs; whether an operator ever needs one is unmeasured.
3. A split PEM block and an AWS secret held under any other variable name are outside the secret
   rule's reach, and say so in its comment.
4. `pack verify` checks the bundle bytes only when `--bundle` is passed; without it the output says
   the bytes were not checked rather than implying they were.
5. `crossengin diff` names sections but not field-level detail inside them; the reviewer's diff view
   has that and the CLI does not.

## References

- `apps/architect-cli/src/{file-confinement,tools,unified-diff,refusal,cli,apply,commands,format,pack}.ts`
- `packages/testing/src/strategy/secret-values.ts`
- `packages/kernel/src/manifest/sections.ts`, `packages/kernel/src/manifest/change-detail.ts`
- `packages/marketplace/src/publishers.ts`
