# ADR-0390: The backup the documentation destroys

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-28 |
| **Authors** | Claude |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0301 (a credential reaches this process through the environment), ADR-0334 (a remedy that cannot work is worse than none), ADR-0337 (a falsely-true control *is* the compliance failure), ADR-0364 (its addendum: the documented path that could not be followed), ADR-0376 (the first fence over `deploy/`), ADR-0380 (`NO HISTORY — nothing was examined`), ADR-0388 (the seventeen-section census) |

## Context

Register items P0.9 and P0.3 are both about `deploy/`, and both were measured on 2026-10-28 with an
adversarial pass aimed at the measurement. Between them they had five claims that did not survive,
and **two of the five were prescriptions rather than facts** — the costliest kind, because an
increment spends itself on a remedy.

### P0.9: the scheduled path destroys the last good backup

`deploy/ORACLE.md` § *13. Back up* shipped a `~/backups/dump.sh` of three substantive lines:

```bash
set -eu
docker compose exec -T db pg_dump -U crossengin crossengin \
  | gzip > "/home/ubuntu/backups/crossengin-$(date +%F-%H%M).sql.gz"
find /home/ubuntu/backups -name 'crossengin-*.sql.gz' -mtime +14 -delete
```

`pg_dump` is the **non-final** element of that pipe and there is no `pipefail` — measured, **zero
occurrences anywhere under `deploy/`**. So a `pg_dump` that fails produces a *valid* gzip of an
empty or partial stream, the pipeline exits 0, `set -e` never fires, cron is silent, and the
retention sweep then runs **unconditionally**, with no integrity check and no minimum-count floor.

Reproduced end to end on a real cluster rather than reasoned. A good 72,122-byte dump, `touch`ed to
20 days old, then the script's exact structure with a failing `pg_dump`:

```
pg_dump: error: ... FATAL:  role "nosuchrole" does not exist
   REACHED the find line -- set -e did NOT fire
   script exit=0
after:     20 bytes          <- the 72KB good backup is GONE
```

And the section's own restore check could not have caught it. `gunzip -c … | head -40` reads only
the dump preamble, which a truncated dump still carries verbatim, and `head` closing the pipe sends
`gunzip` `SIGPIPE` before any trailing-CRC check — so on the real reproduction it printed nothing
and exited 0. That one command is the **only** occurrence of the word "restore" in all of `deploy/`.

**And one failing run is enough, not fifteen.** The brief for this change said *"fifteen consecutive
silently-partial dumps leave only partial dumps"*, which understates it: measured on the old form,
**one** failing run against a directory holding one dump past the retention window exits 0, prunes
the good dump, and leaves a `gunzip -t`-valid gzip of a partial in its place. The comment in the
shipped script says *"it takes one"*.

`deploy/README.md` carried three further sites, and the third was outside the brief. Its Day-2
bullet was
`pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`, with three defects in one line: no `-T`,
where the other two invocations have it; a **constant** redirect target, which the shell truncates
*before* `pg_dump` runs; and two variables that are **never set in the operator's shell**, because
they live only in `deploy/.env` and no documented step sources it (measured: zero hits for
`set -a`, `source .env` or `export POSTGRES` in either document). And README's
*"On Oracle Cloud (Always Free)"* walkthrough reads *"until it does, **that cron line** is the
deployment's real recovery point"* while `grep -c crontab deploy/README.md` is **0** — that
walkthrough is an abridgement of ORACLE.md's and the abridgement dropped the script, the crontab,
the retention and the restore block, so that reference has four missing antecedents.

The third site was **not in the brief and is the sharper of the two unset-variable instances**: the
by-hand `CREATE EXTENSION` repair under *"If `extensions` exits 2"* carries the identical defect in
a `psql` command on the **recovery** path — so a documented remedy cannot be followed at the moment
it is needed, which is ADR-0334's class. And the **working** idiom sat 38 lines above it in the
password-repair step of the same section: `$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)`. Two
spellings of one thing in
one document, with the broken one later, which is proof the author knew the host shell does not hold
these variables — a transcription slip rather than a missing insight. Fixing only the backup line
would have been a count reduction inside a defect class (ADR-0366).

### P0.3: a bold claim in the document that was corrected

`deploy/ORACLE.md` asserted, in bold, *"**None of the four file-taking flags has a path by which you
can supply a file.**"* That is false. `deploy/Dockerfile:18` is `COPY . .` under `WORKDIR /app`, the
build context is `context: ..` — the repository root — and `.dockerignore` excludes `deploy/.env`
and **not** `deploy/*.json`, with no `deploy/Dockerfile.dockerignore` to take precedence. So a file
at `deploy/checkpoint.json` **is** baked into the image and `--checkpoint-config
deploy/checkpoint.json` reads it with no `volumes:` key anywhere. It need not even be committed: a
build context is the working tree minus `.dockerignore`, not the git index, which is why
`.dockerignore` lists `.git` explicitly.

The same paragraph carried *"every field has a default"* about two schemas where `tenantStatuses`
(both) and `escalation` (integrity-proof) are `.optional()` with none — **a figure from the register
that had propagated into shipped documentation**. And it called the three non-credential flags peers
when `DeletionCapabilitiesSchema.safeParse({})` **fails** with six `Required` issues, by design
(ADR-0328 — a schema default is applied to *silence*), with the only exported template all six
`erases`, which register P2.6 records as refusing every deletion. The per-subsystem guidance that
template cannot give **already exists in `cli.ts`'s `--help` prose and nowhere in `deploy/`**, which
is ADR-0376's asymmetry in a second place.

A third stale claim was in the same file and is the one that had *become* false rather than having
always been: README's *"Approving a tenant's design"* section said *"The diff does not show you
`meta.extends`"*, and ADR-0388's section
census made that wrong — measured on a pair differing on `meta` alone, `sectionChanges` carries
`{section: "meta", added: ["extends"]}`. Its *counts* clause stayed literally true, which is how it
survived: the five itemised layers are blind to `meta` and the census is not.

## Decision

**Fix the two destructive documented procedures, replace the false claim with the true one and its
cost, and extend the one fence over `deploy/` so none of the four shapes can return.**

1. **`dump.sh` becomes fail-closed.** `set -euo pipefail`; dump to `$out.partial` under a
   `trap 'rm -f "$tmp"' EXIT`; `gunzip -t` it; `mv` it into place; and only then prune. The
   invariant is that `~/backups` holds **verified dumps and nothing else**, so a reader never has to
   ask whether a file there is this minute's half-written one, and the retention sweep can no longer
   be the thing that leaves a deployment with nothing restorable.
2. **The manual check is three steps and the first and third catch *disjoint* failures.** `gunzip -t`
   **first**, then the `head -40` reading, then `gunzip -c "$f" | tail -5 | grep -q 'PostgreSQL
   database dump complete'` per file. Step 1 is the reliable detector of a **truncated** stream and
   is blind to one that never started, because an empty input is a *valid* gzip — the 20-byte
   remnant the old script left behind passes steps 1 and 2 with exit 0, and that directory is
   exactly where those remnants are. Step 3 answers 0 on it, and conversely a *late* truncation
   leaves the terminating line intact in the decompressible prefix, so step 3 passes and step 1
   catches it. Both measured, both ways. Plus an explicit paragraph saying what this is **not**:
   verifying the bytes is not restoring them.
3. **README's ad-hoc dump matches its two siblings**: `-T`, literal `-U crossengin crossengin`, and
   a timestamped filename, each with the reason beside it, and a cross-reference by **heading** to
   ORACLE.md's section rather than a copy of the cron line.
4. **The bold claim is replaced by the truth and the two things that make it still a gap** — no
   route for an *uncommitted, host-side* file, which is exactly the shape a credential needs; and
   the cost, since `COPY . .` sits immediately above the full `pnpm install && pnpm -r build &&
   next build` under a comment saying that layer is deliberately coarse, so two bytes of JSON buy a
   full workspace rebuild. An Ed25519 seed in an image layer is readable from the layer cache, any
   `docker save` and every registry the tag reaches, which **sharpens** ADR-0301 rather than
   weakening it.
5. **The `volumes:` key is deliberately withheld.** The three committable configs it would serve are
   only meaningful once `--audit-chain-config` has an environment route, because with no chain
   nothing is anchored and the integrity proof verifies an empty chain — which ADR-0380 made print
   `NO HISTORY — nothing was examined`. Shipping a host mount now would quietly license a private
   seed in a mounted file: ADR-0334's rule, that a remedy which cannot work is worse than none.

## Alternatives considered

- **Option A: retire register P0.3's entry, because ORACLE.md had already been rewritten to carry
  its analysis.**
  - **Pros:** the document does discuss the gap at length; the register line was stale.
  - **Why not:** the rewrite is **present and not true**. It asserts the refuted claim in bold and
    repeats the propagated imprecision, so retiring the entry would have left a false bold
    assertion in the document an Oracle operator follows while deleting the only internal record
    that it is false — ADR-0337's falsely-true direction. **Checking that a document has been
    rewritten is not checking that the rewrite is true**, and that is the one genuinely new
    staleness shape this measurement found.

- **Option B: `gunzip -t` as the restore check, as this increment's own brief prescribed.**
  - **Why not:** measured insufficient against the exact artefact the failure produces. `: | gzip`
    is a **valid 20-byte archive** and `gunzip -t` exits **0** on it, as does `gunzip -c | head -40`.
    The prescribed minimum passes on a dump that does not exist — a second falsely-true control in
    place of the first. The discriminator there is pg_dump's terminating line, measured at **0**
    occurrences in the broken artefact.
  - **And the complement holds**, which is why both checks earn their place: a gzip with its last
    30 bytes removed **fails** `gunzip -t` and still **carries** the terminating line in its
    decompressible prefix. The two catch **disjoint** failure modes — `gunzip -t` is the reliable
    detector of a truncated stream and is blind to one that never started, because an empty input is
    a *valid* gzip. Inside `dump.sh` `gunzip -t` alone is sufficient, because `pipefail` aborts on
    the failed `pg_dump` before the empty artefact is ever verified; in the **manual** check over an
    existing deployment's directory it is not, and that directory is the live population.

- **Option C: `pipefail` alone, with the sweep gated on `set -e`.**
  - **Why not:** it stops the sweep and leaves behind a today-stamped file that passes both checks —
    the same falsely-true shape one step along, and **worse** for an operator who reads a directory
    listing rather than an exit code. The temp-file-then-`mv` under a `trap` is therefore required
    rather than an improvement. Verified in both arms: on failure, exit 1 with the good backup
    surviving and no `.partial` left; on success, the 20-day-old one pruned **only once a verified
    new one exists**.

- **Option D: add `volumes:` to `api` and ship the three config files now.**
  - **Pros:** closes the mechanical half of P0.3 in one line, copying a bind mount the same file
    already has twice.
  - **Why not:** see Decision 5. It would also not have worked as a three-file set:
    `DeletionCapabilitiesSchema.safeParse({})` **fails** with six `Required` issues, by design
    (ADR-0328 — a schema default is applied to *silence*), and the only exported template is all six
    `erases`, which register P2.6 records as refusing every deletion.

- **Option E: copy the cron line into README so its reference resolves.**
  - **Why not:** a second spelling that drifts, which is this repository's most-found class. The
    cross-reference points at ORACLE.md's heading instead, and the fence asserts the heading exists.

## Consequences

- **Positive:** the scheduled path can no longer delete a good backup; a failed run leaves the
  directory exactly as it was; the manual check can fail for the failure mode a silent cron
  produces; README's two broken commands work; and the four shapes are fenced, so the next
  regression of any of them is a test failure rather than something found by a restore.
- **Negative:** `dump.sh` is six substantive lines rather than three, and the comments explaining
  why are longer than the script. Judged worth it: the measurement is the justification, and a
  reader who removes `pipefail` to tidy it would restore the defect.
- **Neutral:** the restore story is still **not** a restore test. Loading a dump into a scratch
  database and reading a row back is, and nothing in `deploy/` does that — stated in the document
  rather than implied away, which is why register P0.9 **splits**: the two destructive paths are the
  P0 and are closed here, the absent scheduler and the untested restore are **P1**, and the
  `--dr-readiness-config` surface is **P2**.
- **Reversibility:** entirely. These are documentation edits plus assertions over them.

## Implementation notes

- `deploy/README.md`, `deploy/ORACLE.md`, `apps/operate-server/src/deployment-defaults.test.ts`.
  `deploy/docker-compose.yml` is deliberately untouched.
- The fence now reads the two markdown documents as well as the compose file and `.env.example`.
  That is a **scope extension** rather than an extension of coverage — ~110 KB of prose it had never
  parsed, with the fenced-block-versus-inline-code judgement calls that implies — and it is the only
  part of this change that prevents recurrence, so it is sized honestly rather than described as
  free. Twelve assertions across three groups, each carrying the measurement that earned it, and the
  first of them is a **non-vacuity floor**: it asserts every `pg_dump` invocation was found, because
  a scanner that stops matching reports zero violations.
- The seventeen/sixteen correction has a trap beside it and the fence covers both halves: two
  occurrences of "sixteen" are the stale manifest denominator ADR-0388 corrected to **seventeen**,
  and a third — *"Fifteen of the sixteen tables the GDPR Article 17 erasure protects"* — is a
  different sixteen (`PLATFORM_RECORD_TABLES`) and is **correct**, so a careless pass over the word
  breaks a true sentence.
- The resolved fallback user in README's broken command is **`root`**, not `postgres`:
  `deploy/postgres/Dockerfile` carries no `USER` directive and the official image drops privileges
  via gosu inside its entrypoint. The `postgres` *database* does exist (initdb creates it
  unconditionally); only the role is absent.
- The `-T` claim is measurable with no docker daemon: `pty.fork()` shows a line discipline rewriting
  every `\n` to `\r\n` where a pipe does not (2 CRs injected into a two-line stream, 0 through a
  pipe). So no claim in this change rests on reasoning.
- **Three of the fence's own assertions were vacuous on their first run and all three are fixed**,
  which is the part of this change most worth reading before adding to it. (1) Removing
  `gunzip -t "$tmp"` from the script **passed**, because the script's own *comments quote*
  `gunzip -t` — so the verify-before-`mv` ordering assertions were holding for the wrong reason.
  The scanner strips full-line comments now; it is the exact hazard this file's own drain-absence
  group names, reproduced by an author who had just read it. (2) Restoring *"that cron line"*
  **passed**, because the replacement prose itself contains the word *crontab* — so the assertion is
  `hasRunnableCronLine()`, a `crontab` invocation or a five-field schedule **inside a shell block**,
  rather than a word match. (3) Deleting one of the two cross-references **passed**, because
  `toContain` was satisfied by the other — the count is asserted at 2. A fourth was a scanner bug
  rather than a vacuity: `> *(\S+)` stopped at the space inside `$(date +%F-%H%M)`, so it fired on
  correct text while reporting a target it had truncated.
- **The terminating-line check is safely addable and the form matters.** It was first refused on the
  ground that `| grep -q` under `pipefail` risks SIGPIPE, which is **right about the hazard and
  wrong about which form carries it**. Measured over a real 16,590-line dump, 200 trials each:
  `gunzip -c f | grep -q …` exits non-zero **200/200** — it breaks *deterministically on a good
  dump*, because grep matches early, exits, and `gunzip` takes SIGPIPE — while
  `gunzip -c f | tail -5 | grep -q …` exits non-zero **0/200**. That is structural rather than
  lucky: `tail` cannot emit until the stream **ends**, so `gunzip` always runs to completion and
  tail's five lines fit in one pipe-buffer write grep cannot truncate. So the check shipped in that
  form, and the `| tail -5 |` carries its measurement at the site.
- **Adding that third step fired four assertions at once on correct text**, which is a fifth
  instance of the vacuity family and the one worth keeping. The commands scanner excludes prose by
  stripping markdown code spans, which rests on the convention that a comment **backticks** a
  command name — and the trailing comment written beside step 3 did not, so a `for` loop read as a
  fourth `pg_dump` invocation with no `-T`, no `-U` and a constant redirect target. Fixed **both
  ways**, which is this repository's usual pair: the comment follows the convention, and the scanner
  strips a trailing shell comment so the convention is no longer load-bearing. Scoped to a `#`
  preceded by whitespace, so `${#var}` and a markdown anchor like `ORACLE.md#13-back-up` are
  untouched; mutation-checked afterwards by removing a real `-T`, which still fails exactly one
  assertion.

## Addendum — the adversarial review, and the fence that was blind to the defect

An adversarial pass over the commit found **fifteen** findings, two of which block, and the first is
the increment's own class landing on the increment's own fence.

**The fence could not see the defect in the form it actually had.** `pgDumpCommands()` stripped
markdown code spans and justified it with a convention — *in this repository's prose a command name
is always inside backticks, and in a command it never is* — which the tree's own pre-image refutes:
the sharpest single defect in `deploy/`,
`docker compose exec db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql`, shipped as a
**one-line code span**. Measured by restoring that exact line: the three assertions written to catch
it — no `-T`, an unset variable, a constant redirect target — all **passed**, and only the
population count noticed (`1 failed | 32 passed`). So the fence was green against the thing it
exists to refuse. A discriminator that reads *formatting* is one the next author satisfies by
changing the formatting, and the honest one reads **content**: candidates are every line of every
fenced `bash`/`sh` block plus every inline code span outside those fences, and a candidate is an
invocation rather than a mention iff it names `pg_dump` and then goes on to say something — a flag,
a pipe or a redirect. Measured over the three documents, the four prose mentions are each the bare
token and nothing else. After the change, restoring the same line fails **four** assertions.

**A committed comment said the opposite of what this increment measured.** The test comment read
that `gunzip -t` *"is what catches the truncation `pipefail` does not (a pg_dump that exits 0 having
written a short answer)"* — and this ADR's own Alternatives section records the refutation: a
complete gzip of a short dump passes `gunzip -t` with exit 0. The correct fact was in the report and
the wrong one was in the tree, which is this file's most-found documentation class committed inside
the increment that cites it. The comment now says what is true: `gunzip -t` catches a gzip that is
itself incomplete, which `pipefail` cannot see because gzip is the pipe's *final* element, and
neither sees a short-but-complete dump — the verification block's third step does.

Five further findings were real and each closed a way the fence was satisfiable:

- **The document set was a hardcoded pair** (ADR-0288's shape one level out). A maximally defective
  command in `deploy/VERCEL-SUPABASE.md` passed every assertion — and that is the document a backup
  section would be added to, being the managed-cloud path and the only one of the three with no
  occurrence of *backup*, *dump*, *restore*, *PITR* or *snapshot*. It is a `readdirSync` over
  `deploy/` with a floor of 3 now; the mutation fails four assertions.
- **Uniqueness was whitelisted by variable name.** `target.includes("$tmp")` passed as proof, so
  rewriting the unattended script to a constant `out="…/crossengin-latest.sql.gz"` passed all 33
  tests — the one invocation this increment says destroys data on its own, and a constant `$out`
  additionally makes the `-mtime +14` sweep meaningless because there is only ever one file to age.
  `resolveShellVars` resolves transitively from the assignments in the same shell block, bounded at
  four passes, and strips quotes last because substituting an assignment's right-hand side verbatim
  nests them (`tmp="$out.partial"` over a quoted `out=` gives `"""…".partial""`).
- **The bare-variable rule missed `${BRACE}`**, requiring a letter straight after the `$`.
- **One defect had two remedies in one document and the fence refused the right one.** README's
  extension repair reads the role out of `.env` with a `grep` and argues at length that this is the
  document's idiom for exactly this defect, while the two dump commands hardcoded `crossengin` — and
  README carries a whole `role "…" does not exist` bullet about an operator who changed
  `POSTGRES_USER`, so the literal is a remedy that fails for precisely the population most likely to
  need a backup. Both dump commands take the `.env` lookup now and the assertion is **one
  predicate** — *not a bare variable* — which admits the lookup and the literal alike, with a
  positive floor (`crossengin|POSTGRES_USER=`) so a command naming neither cannot satisfy the
  refusal by saying nothing. The scheduled script keeps the literal, with the reason where it is: it
  is a file authored once for one VM, not a line an interactive shell expands. Verified against a
  real `.env` whose `POSTGRES_USER` had been changed — the lookup answers `not_crossengin`.
- **The documented ad-hoc dump wrote into the Docker build context**, which is the mechanism this
  same increment established bakes untracked files into image layers. Both README commands are run
  from `deploy/`, the context is `..`, `.dockerignore` has no `*.sql`, and the documented upgrade is
  `docker compose up -d --build` — so following the day-2 bullet and then upgrading bakes a
  **plaintext dump holding `meta.users`' credential hashes** into a pushable layer. That is the
  exposure this ADR spends two paragraphs refusing for a 32-byte Ed25519 seed. Both redirect to
  `$HOME` now and the fence asserts the resolved target is absolute, `~` or `$HOME`. A blanket
  `*.sql` line in `.dockerignore` is **refused** rather than added as a belt:
  `deploy/postgres/init/00-extension.sql` and `deploy/supabase/00-uuidv7.sql` are both in the
  context on purpose, so the pattern would have to be scoped to the dump's own name, which is a
  second spelling of the redirect it would be guarding.

Three findings were prose rather than code, and one of them removes a claim the redesign rested on.
ORACLE.md asserted *"the diagnosis is on stderr, which cron mails you"* — and the runbook installs
no MTA and sets no `MAILTO` (measured: five `mail`-ish hits in the file, all unrelated), so on the
deployment it describes a failure still reaches nobody, which is the property the increment set out
to remove. The script writes its own log now (`exec >> …/dump.log 2>&1` plus a `date -Is` marker),
the verification section points an operator at it, and the comment says plainly that the failure is
**recorded rather than announced** and that pushing it needs an MTA or a monitor this runbook does
not provision. Beside it, a sentence written from scratch in this increment described an ordering
the document does not have — *"the same defect the backup command **below** carried, **one command
earlier** in the same document"*, where the two are hundreds of lines and several sections apart —
and the replacement states no distance at all, because the first attempt at one was measured at
*nine* fenced blocks against the pre-edit tree and *eight* against the post-edit one, on the same
pair of commands: a figure whose value depends on where its author put the endpoints carries no
information for a reader and drifts under the next edit. And the
`.dockerignore` paragraph said *"and nothing else under `deploy/`"*, true of the tree and false of
the rules, which is the conclusion-holds-reason-false shape this ADR corrects one bullet below it.

**Every line citation in the slice's own report that sat below its own insertion was exactly 10
low**, because it took its numbers before adding a ten-line paragraph. Three had reached this ADR
and are now **anchored by section heading** rather than re-derived, which is the remedy register
P0.9 already prescribes and which cannot drift again. That is the *correct-when-written* staleness
class rather than the wrong-when-written one, and the two want different remedies — the distinction
register P3.1 draws and that its own members have twice been filed on the wrong side of.

And **the mutation harness failed its own reversal twice, both times caught by its own guards.**
Expressing "delete the verify line" as a replacement with `""` has an inverse of `("", "…")`, which
the empty-`old` guard refuses; re-expressing it with `true` has an inverse that matches **7** times
in the file, which the occurrence-count guard refuses. Both left the tree mutated until it was
repaired by hand and confirmed byte-identical by `md5sum`. So a mutation reversed by string
replacement has to be a **bijection in both directions**: non-empty, and unique. The guards are the
reason this is a note rather than a defect in the committed tree — they refused rather than
silently reversing something else — but the cost is a window, and the fix is in the harness's shape.

**The rewritten script was then run as shipped**, extracted verbatim from the document with only
the three absolute paths retargeted and `docker compose` replaced by a stand-in whose exit status is
controlled — which is the right substitution, because every defect here was in the *shell structure*
rather than in `pg_dump`. Three arms, and arm 2 is the exact inverse of the pre-fix reproduction:

| Arm | Result |
|---|---|
| a good dump into an empty directory | exit **0**, one 1,066-byte `.sql.gz` plus the log |
| **one** failing run against a 20-day-old good backup | exit **2**, the old backup **survived byte-identical** (md5 `8e0749e9…`), **0** `.partial` left, and `pg_dump: error: connection to server lost` **in `dump.log`** under its `date -Is` marker |
| a good run after it | exit **0**, the 20-day-old one pruned, the new one kept |

All three verification steps then pass over the result, and the log is cumulative across runs, which
is what makes it a place to look rather than a snapshot. Pre-fix the same arm 2 exited **0** with the
backup gone and nothing written anywhere.

| Mutation | Before | After |
|---|---|---|
| the pre-fix command restored as a code span | 1 failed (population only) | **4 failed** |
| a defective command in the third document | 33 passed | **4 failed** |
| `-U "${POSTGRES_USER}"` | 33 passed | **1 failed** |
| a constant `out=` in the scheduled script | 33 passed | **1 failed** |
| the redirect moved back into `deploy/` | n/a | **1 failed** |
| a trailing comment on a script line | 3 failed | **33 passed** |
| the verify line replaced by a no-op | 1 failed | **2 failed** |

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The log the script now writes is unrotated. One entry a day is negligible on a 47 GB boot volume and a *failing* run writes a `pg_dump` error a day, so the horizon is years — but nothing bounds it and the retention sweep's glob deliberately does not match it. | unassigned | — |
| A prose code span that named a flag would read as a command and fire the fence on correct text. Measured at zero occurrences across the three documents, and the visible direction rather than the silent one — but it is the shape ADR-0382 records as how a fence gets deleted instead of satisfied. | unassigned | — |
| `--audit-chain-config`'s **environment route**: one variable holding the seed with the public half derived through `ed25519PublicKeyFromSeed` (ADR-0358's `OPERATE_TOKEN_SIGNING_KEY` shape), versus splitting the schema so the policy half stays a file. The second makes two required fields optional-in-the-file, which is a contract change wanting its own fence. It is also the blocker for the withheld `volumes:` key. | unassigned | — |
| There is no documented keypair-generation step anywhere in `deploy/` (0 hits for `generateEd25519`, `openssl genpkey` or "Ed25519 keypair") and no `AUDIT_CHAIN_*` variable in the tree, so the env route does not exist even in skeleton. The generator is `generateEd25519Keypair` — lowercase `p`, and the obvious spelling answers `undefined`. | unassigned | — |
| `--deletion-capabilities` is the one of the four with **no dedicated loader** (an inline `JSON.parse(await readFile(...))`), so a missing or malformed file names neither the flag nor the path, where the other three each produce a "cannot read" and an "invalid JSON in" message. | unassigned | — |
| An **in-stack** backup scheduler, which is register P0.9's P1 half. The schedule mechanism is an open choice between a sleep loop, a cron image and host cron, and the restore-into-scratch test depends on that choice, as does giving `BackupRecord` a code producer. | unassigned | — |
| `deploy/VERCEL-SUPABASE.md` mentions none of backup, cron, dump, PITR, snapshot, recovery or restore across 329 lines — so the one deployment path whose provider genuinely offers automated backups and PITR is the only document silent about a recovery point in either direction. | unassigned | — |

## References

- `deploy/README.md`, `deploy/ORACLE.md` § *13. Back up*, `deploy/Dockerfile`, `.dockerignore`
- `apps/operate-server/src/deployment-defaults.test.ts` — the one fence over `deploy/`
- CLAUDE.md, *The register* items P0.3, P0.9 and P3.1
