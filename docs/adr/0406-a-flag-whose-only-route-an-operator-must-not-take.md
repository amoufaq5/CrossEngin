# ADR-0406: A flag whose only route an operator must not take

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-09 |
| **Authors** | CrossEngin platform team |
| **Reviewers** | CrossEngin platform team |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0286, ADR-0287, ADR-0301, ADR-0328, ADR-0334, ADR-0338, ADR-0357, ADR-0358, ADR-0362, ADR-0371, ADR-0390, ADR-0399 |

## Context

Register item P0.3 — the oldest open item in this repository — says the shipped compose mounts no
background subsystem, so nearly everything built since Phase 3 is off. ADR-0376 answered three of
its nine flags and left the rest to a **per-flag survey**, on the finding that "which flags should a
reference deployment default on" is not one question but three asked per flag: *does it serve what
it mounts* (ADR-0370), *is what it records a claim* (ADR-0371), and *does its own failure mode reach
anybody* (ADR-0374).

Asking those three of the four **file-taking** flags found one class with three members, and the
class is sharper than "a flag nobody passes": **the flag exists, the feature behind it is built and
correct, and the only route by which an operator can supply its input is one they must not take.**

*The keystone.* `--audit-chain-config <file>` was the sole route to the chain's Ed25519 keypair.
ADR-0301 forbids a credential on argv. A file in `deploy/` is **baked into the image**:
`deploy/Dockerfile:18` is `COPY . .` under a repo-root context with `.dockerignore` excluding
`deploy/.env` and **not** `deploy/*.json`, so an Ed25519 private seed would be exposed by
`docker history`, `docker save`, any registry push and the local layer cache — which ADR-0390
measured and which is why that increment **withheld** the `volumes:` key with its reason stated:
*"meaningless until the audit chain has an environment route for its keypair."* So no shipped compose
passed the flag, **no audit row has ever been anchored in any shipped deployment**, and
`--checkpoints` and `--integrity-proof` had nothing to anchor or verify. The whole tamper-evidence
story was gated on one credential with no honest route.

*The falsely-true control.* `--checkpoint-config '{}'` parses — and it is the file's **natural
minimal content**, and what `deploy/ORACLE.md` documented. It resolves to
`{tenants: [], allTenants: false, includePlatform: true}`, so the scope set is `[null]`: **the
platform chain alone.** On the shipped stack that chain is empty, and ADR-0399's `isEmptyScope`
discards an empty scope's report entirely — zero callbacks, no stored row. Measured live, `{}`
against `--checkpoints`: **0 anchors / 0 verdicts / 0 log lines** against **4 / 4 / 8**. An operator
who pasted the documented example got a deployment that printed a checkpoint scope line and did
nothing, for ever, in silence. That is the third clause of the per-flag question failing.

*The template that refuses everything.* `--deletion-capabilities <file>` has no satisfiable example:
`CONSERVATIVE_DELETION_CAPABILITIES` is all six subsystems `erases`, which register P2.6 records as
refusing every deletion, and the map is total by design (ADR-0328 — a schema default is applied to
*silence*, and silence must not decide how much of an Article 17 proof covers). So the guidance an
operator needs lived in `cli.ts`'s `--help` prose and in no `deploy/` document.

And one defect was in none of those: `PostgresTenantSource`'s `DEFAULT_TENANT_STATUSES = ["active"]`
is **one constant answering two questions.** It is right for a cron scheduler — do not run a
tenant's scheduled jobs after they are gone — and wrong for a tamper-evidence pass, because all four
chain tables are `PLATFORM_RECORD_TABLES` members, retained by the Article 17 erasure *precisely so
an auditor can read them after the tenant is gone*, and retirement is `UPDATE … SET status =
'deleted'`, so the row survives and the tenant id stays enumerable. The population the retention set
exists to preserve was the one population the two chain passes never covered.

## Decision

**One environment variable carries the chain's seed, and the public half is derived from it.**
`AUDIT_CHAIN_SIGNING_KEY` holds the 32-byte seed; `ed25519PublicKeyFromSeed` derives the public half.
That is ADR-0358's `OPERATE_TOKEN_SIGNING_KEY` precedent, and the reason is a measurement rather than
convenience: node builds an Ed25519 private key from `d` and **silently discards an inconsistent
`x`**, so a pair stated twice can be stated inconsistently with the only symptom being that the
signer announces one fingerprint while signing under another.

**The file keeps the policy and loses the key.** `AuditChainFileSchema` is
`AuditChainConfigSchema.partial({privateKeyBase64: true, publicKeyBase64: true})`, so a file may
carry `schema`, `actorReference` and `samplingRate` with no key material at all. Measured on zod
3.25.76: `.partial({subset})` preserves `.strict()` and keeps every refinement on the fields that
are supplied.

**Two sources are admissible iff they state the same keypair.** `resolveAuditChain` answers
`file_only` / `env_only` / `both`, comparing by **fingerprint** — `ed25519ChainSigner`'s own
comparison, one layer out. Precedence is **refused**: a deployment that set the variable and forgot
the file, or the reverse, would silently serve one of them and which one depends on a rule nobody
reads, so the `both` verdict says so out loud (ADR-0357's shape). Concatenation, ADR-0357's answer
for api-key specs, is unavailable because a keypair is not a list. Four refusals —
`signing_key_malformed`, `private_key_absent`, `public_half_mismatched`, `sources_disagree` — and
**none of them prints a seed**. `KEY_SOURCE_EXPOSES_A_LAYER` is a total map with only `env_only`
false, so `file_only` and `both` warn by name about the pushable layer and name the variable as the
remedy.

**`--checkpoints` and `--integrity-proof` are booleans, defaulted on in the shipped compose**, each
mutually exclusive with its `-config` sibling. A boolean cannot be `{}`, which is the whole of it:
the falsely-true control is not repaired, it is made inexpressible.

**The two chain passes read every tenant status.** `chainScopeStatuses` widens the default from
`["active"]` to all five `TENANT_STATUSES` for the checkpoint scheduler and the integrity proof
alone. Widening rather than confining the wide set to the new booleans, on ADR-0338's rule: a
tamper-evidence pass that reaches more rows can only find more, and a pass that skipped the retained
population was not working. It is a **helper function and not a `z.default()`**, because
`tenantStatuses` is `.nonempty()` and a default would need a non-empty tuple, hence a cast, hence
ADR-0362's class — a type annotation standing in for a check.

**`--deletion-capability <subsystem>=<disposition>` is repeatable and inline.** Not a mount: a
mounted file's content is outside every workspace rule and every test, which is ADR-0376's tenth
reading of the fake-connection blind spot. `DISPOSITION_REQUIRES_ATTESTATION` (`erases: true,
retains: true, absent: false, present_not_erased: false`) is what makes an honest template
satisfiable. The parse refuses five ways: an entry with no `=`, an unknown subsystem, an unknown
disposition, a **repeated subsystem** (last-wins would make an Article 17 proof's scope depend on
argv order), and an **incomplete set naming the missing subsystems** — because the map is total and
an operator must say what each subsystem does rather than have silence say it for them.

**The `volumes:` key stays withheld, and its reason narrows rather than retires.** The keypair has an
environment route now, and each of the three remaining file-taking flags has a non-file route — two
booleans and a repeatable `k=v` — so a mount would serve nothing a flag does not while licensing a
private seed in a mounted file (ADR-0334: a remedy that cannot work is worse than none).

## Alternatives considered

- **Option A: add `volumes:` to the `api` service and document a config directory.**
  - **Pros:** one change serves all four flags; the obvious reading of P0.3.
  - **Cons:** a mounted file's content is read by no workspace rule and no test, so a malformed or
    falsely-true config is invisible to all twelve rules and all 20k tests; and it is the route by
    which an operator would put a private seed in a file on the host.
  - **Why not:** ADR-0390 withheld it for the second reason and this increment removes the first —
    every flag the mount would serve now has a route that *is* fenced. A mount that serves nothing
    new and licenses a secret in a file is strictly worse than none.

- **Option B: two variables for the keypair, `AUDIT_CHAIN_PRIVATE_KEY` and `_PUBLIC_KEY`.**
  - **Pros:** symmetric with the file's two fields; no derivation step.
  - **Cons:** measured — node silently discards an `x` inconsistent with `d`, so the pair can be
    stated wrongly with no error and the only symptom is every signature verifying against a
    fingerprint the deployment does not announce.
  - **Why not:** `credential-auth-env.ts`' own argument, one subsystem across: a pair that can be
    stated twice can be stated inconsistently, so one variable plus a derivation closes the class by
    construction rather than by a check.

- **Option C: precedence — the variable wins over the file, or the file over the variable.**
  - **Pros:** no refusal to explain; a deployment migrating from a file keeps working.
  - **Cons:** a deployment holding both serves one keypair and which one depends on a rule in a
    source file; the loser's fingerprint is what an operator reads in their own notes.
  - **Why not:** ADR-0357's `both` verdict exists for exactly this and says so: a deployment that
    stated two things must be told it did, not have one of them silently dropped. Same-or-refuse
    makes the two sources a redundancy check instead of a hazard.

- **Option D: keep `--checkpoint-config`/`--integrity-proof-config` as the only route and document
  `{"allTenants": true}` instead of `{}`.**
  - **Pros:** no new flags; the config files keep their full expressiveness.
  - **Cons:** the falsely-true control is still *reachable* and is still the file's natural minimal
    content — a documentation fix does not stop `{}` parsing, and the failure is silent on every
    axis (no anchor, no verdict, no log line).
  - **Why not:** ADR-0334's conversion — make the unsafe state inexpressible rather than
    documented-against. Both config flags survive for a deployment that needs a narrower scope.

- **Option E: give the deletion capabilities a `z.default()` so `{}` or an omitted flag resolves.**
  - **Pros:** one fewer refusal; the flag becomes optional.
  - **Why not:** ADR-0328 decided this and the reason has not changed — a schema default is applied
    to *silence*, and here silence would decide how much of an Article 17 proof covers.

- **Option F: confine the wide status set to the two new booleans and leave `-config` narrow.**
  - **Pros:** no behaviour change for a deployment already passing a config file.
  - **Cons:** two scope rules for one question, so the boot line and the pass could disagree about
    which tenants are covered depending on which flag was used.
  - **Why not:** ADR-0338's rule read directly — a pass skipping the retained population was not
    working, so widening breaks nothing that was right, and one rule per question is the property
    ADR-0361 exists to keep.

## Consequences

- **Positive:** the audit chain has a route that is neither argv nor a pushable layer, so
  `--checkpoints` and `--integrity-proof` can be — and now are — defaulted on; the two chain passes
  cover the population the retention set preserves; `{}` can no longer configure a pass into silence;
  an Article 17 deployment has a pasteable capabilities declaration that is not all-`erases`; and
  three of P0.3's four file-taking flags are closed without a mount.
- **Negative:** `AUDIT_CHAIN_SIGNING_KEY` is a 32-byte secret an operator must generate, keep and
  back up — losing it means the chain's existing entries verify against a key the deployment no
  longer holds, and there is no rotation path (ADR-0371's open end). Widening the status set means a
  deployment with many retired tenants pays a full fold per retired scope — **once** on the shipped
  pairing and on **every** pass if the checkpoint scheduler is off; see the addendum's table, which
  replaces the two contradicting accounts this ADR first gave, at a measured 107 µs per entry.
  `--deletion-capability` requires six entries on argv, which is verbose by design.
- **Neutral:** two new boolean flags beside two existing config flags; the compose `command:` grows
  from 26 to 28 flags. `loadAuditChainConfig` is deleted and replaced by a comment naming its
  successor (ADR-0337's test for a deletion).
- **Reversibility:** high for the flags — each is additive and the config siblings are untouched, so
  a deployment can go back to a file for either pass. Low for the **variable**, in the sense that
  matters: once a deployment has anchored entries under a derived key, that seed is the only thing
  that can verify them, so the decision is reversible in code and not in data.

## Implementation notes

- `apps/operate-server/src/audit-chain-env.ts` is new and owns the whole resolution:
  `AUDIT_CHAIN_SIGNING_KEY_VAR`, `AuditChainFileSchema`, `AUDIT_CHAIN_KEY_SOURCES`,
  `KEY_SOURCE_EXPOSES_A_LAYER`, `AUDIT_CHAIN_REFUSALS`, `loadAuditChainFile`, `resolveAuditChain`,
  `formatAuditChain`. It composes a **complete** `AuditChainConfig` through the existing
  `AuditChainConfigSchema.parse`, so no consumer of that type changed.
- `apps/operate-server/src/chain-scope-survey.ts` is new and owns both halves of the scope question:
  `CHAIN_SCOPE_TENANT_STATUSES` + `chainScopeStatuses` (F8), and `CHAIN_SCOPE_COVERAGES` +
  `COVERAGE_REACHES_A_TENANT` + `surveyChainScopes` + `formatChainScopes` (the boot line that would
  have named `{}`'s coverage). `namedTenants` is **0** under `allTenants`, because `node.ts` passes
  `tenants:` which *replaces* the static scope list — the first implementation returned 1 and
  contradicted the field's own doc comment.
- The gate in `node.ts` is one compound condition,
  `auditConfig !== null && auditChainProducer !== null && conn !== undefined`, with the third
  conjunct a type-system necessity rather than a second check.
- Each scheduler block reads **its own** resolver (`configScopes` / `integrityConfigScopes`), so the
  two boot lines cannot come to describe one scope differently.
- `DEFAULT_CHECKPOINT_CONFIG` and `DEFAULT_INTEGRITY_PROOF_CONFIG` are
  `…Schema.parse({ allTenants: true })`, so the boolean's behaviour is the schema's and not a second
  literal.
- `.env.example`'s own literal is **refused at boot**, measured by extracting it from the document
  and feeding it in: `fatal: audit chain: refused signing_key_malformed —
  AUDIT_CHAIN_SIGNING_KEY must be 32 bytes of standard base64 (an Ed25519 seed)`. So the documented
  copy-and-forget path fails closed and loud, which is the **opposite** of ADR-0377's
  `unreplaced_placeholder` hazard, where the placeholder cleared both entropy floors and the control
  then asserted a sealed cursor over a key derivable from this repository. That is why no
  placeholder-prefix check is owed here — and it is an argument from the *width*, which is the
  narrower claim open question 2 records: a different placeholder that happened to be 32 valid
  base64 bytes would be accepted.
- Live verification, **34 assertions**, the first two harnesses as the non-owner `serving` role on
  PG 16.15: **21 of 21** arms in the main harness (A0–A9 — the three sources, all four refusals, the
  `{}` finding against its `--checkpoints` control, and A1's entry fingerprint equal to the derived
  fingerprint); **5 of 5** in the F8 harness; **2** on the flag-naming complement (the boolean route
  warns `--checkpoints`, the file route `--checkpoint-config`, and likewise for the proof);
  **4** on `--deletion-capability`'s refusals, each naming its specific cause (an incomplete set
  names `search_indexes`, a repeated subsystem names `'erases' then 'absent'`, the mutual exclusion
  names both flags, an unknown disposition lists the four); and **1** that is the register's own
  P0.9 lesson applied here — *checking that a document has been rewritten is not checking that the
  rewrite is true*, so `ORACLE.md`'s pasteable capabilities block is **extracted mechanically from
  the document and fed to the real binary**, which boots and reads it back as
  `[deletion] capabilities: 2 must attest (tenant_schema, shared_tables), 1 held and not erased
  (backups), 3 declared absent (object_storage, search_indexes, caches)`. That extraction was itself
  wrong first — `lstrip('- ')` strips a *character set*, so it ate the `--` and the binary answered
  `unknown argument: deletion-capability` about the document rather than about the probe.
- The F8 result is an exact complement over two tenants holding genuinely signed entries and
  differing only in `status`, each count read as `serving/owner`:

  | arm | `tenantStatuses` | active | retired |
  |---|---|---|---|
  | N (pre-ADR-0406) | `["active"]` | `1/1` | **`0/0`** |
  | W (shipped default) | all five | `1/1` | **`1/1`** |

- **Three harness defects are worth recording, because each made a probe failure read as a subject
  failure.** `psql -At -c "INSERT … RETURNING id"` prints the row **and** the `INSERT 0 1` command
  tag, so a captured id was two lines — which corrupted every SQL interpolation *and* the api-key
  spec, surfacing as a 500 on the seeding request; `-q` fixes it, and the durable half is a floor
  validating the id as a bare uuid before it reaches any SQL or any argv. `meta.forensic_chain_entries`
  has no `operation` column (it is `kind`) and `payload_size_bytes` is NOT NULL with no default — read
  the catalog, do not guess. And `entry_hash` carries a **table-wide** UNIQUE, so an entry cannot be
  copied into another tenant's scope; the stated reason for copying was itself false, because
  `--tenant-status-gate` is opt-in and not passed, so a `deleted` tenant **is** served — which is
  ADR-0334's own finding and the reason that flag exists. The honest seeding is one real request per
  tenant while both are active, then retire one. The harness's own premise check fired on all three
  rather than letting an arm read as proof, which is what it is for.
- **Two fences this increment's own defaults made necessary**, both because the default is what an
  operator now meets. Each scheduler block's warn messages **name the flag that was passed**,
  selected from which route was used, because a message naming `--checkpoint-config` to somebody who
  passed `--checkpoints` is a remedy they cannot act on (ADR-0334) — fenced as text in
  `node.test.ts`, since a wrong flag name typechecks, and mutation-checked. And README's
  first-launch secrets list is fenced **against `.env.example`** rather than against a second list,
  on `SECRET_PLACEHOLDER_PREFIX` — the marker `refuseWeakSecret` itself refuses on — because
  `AUDIT_CHAIN_SIGNING_KEY` landed in `.env.example` and the compose and in **neither** of README's
  two lists, so an operator following it would have set three secrets and read warn lines about the
  fourth. Both of that fence's own mechanics were measured rather than chosen: the window from each
  `cp .env.example .env` to its closing fence is 1200 because the two are **1079 and 330**, and a
  round 700 silently matched only one — caught by the five-variable floor rather than by reading.
- **And the secrets fence itself paid ADR-0307's split**, which is worth recording because the file
  already carries the rule: `[...env.matchAll(…)]` yields groups typed `string | undefined`, so
  `.filter(([, , value]) => value.startsWith(…))` is `TS18048` — while vitest transpiles through
  esbuild and never typechecks, so the 56 tests were green and `tsc` was not. The package typecheck
  had been run *before* the fence was added and not after. `?? ""` rather than a non-null assertion,
  because an assertion there would be ADR-0362's annotation standing in for a check.
- **ADR-0404 does not exist**, and nothing in the repository references it — a permanent gap beside
  the ADR-0080–0085 one reserved by ADR-0077.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The chain seed has no rotation path: a new seed makes existing entries verify against a key the deployment no longer holds, and `provenance` records how a prefix was verified but not under which key. | platform | 2026-12-15 |
| Should `AUDIT_CHAIN_SIGNING_KEY` carry the placeholder-prefix check `SECRET_PLACEHOLDER_PREFIX` gives the other three secrets? The 32-byte width refusal already rejects the obvious placeholder, so it is not owed — but that is an argument from a width and not from publication (ADR-0377). | platform | 2026-12-15 |
| A full fold per retired scope is unbounded in the chain's length, and on a deployment running the proof **without** `--checkpoints` it recurs on every pass (addendum's table, measured). The two sentences this row and the Consequences bullet first gave are replaced there; what is still open is whether a scope whose fold cannot fit its interval should be *dropped from the scope set* with a named reason rather than skipped on every tick for ever. | platform | 2026-12-15 |
| `--deletion-capability` names six subsystems on argv and four of them can only be `absent` today, because their erasures do not exist (register P2.6). Whether the honest default is a shorter flag that names only what this deployment *has* is a contract question about `DeletionCapabilities`' totality. | platform | 2027-01-15 |
| The overlap guard is in-process, so ADR-0399's witness-memory axis loses its premise across replicas: one replica over one scope forges **0** false `compromised` verdicts and two forge **19 of 240** (~8%), measured, with the chain verifying by hand. The remedy exists — `advisoryKeyFor(scope)` + `pg_advisory_xact_lock`, which the append path already takes — and its cost is that the lock must span load-compute-append, i.e. a whole fold. Latent on the shipped stack: no compose file sets `replicas`. | platform | 2026-12-15 |
| P0.3's remaining background flags — `--schedule-ms`, `--workflow-workers`, `--notification-template-routes`, `--rate-limit-policy` — are each still gated on their own answer to the per-flag questions, which this addendum gives a fourth: does the surface's own *concurrency* forge the finding it reports? | platform | 2027-01-15 |

## Addendum: the hazard this increment created, and what it turned out to be

Defaulting `--integrity-proof` on made one thing live that neither this ADR nor the register had:
`IntegrityProofScheduler.runOnce` had **no overlap guard**, where the sibling `CheckpointScheduler`
has had one since ADR-0371. `start()` fires `void this.runOnce()` and `setInterval` fires
`void this.runOnce()` again, so a pass that outlasts its interval is joined by a second, a third, and
so on — and `proveScopeIntegrity`'s `loadChain` is **unconditional** (`integrity-proof.ts:335`), so
one pass holds one scope's whole chain and k overlapping passes hold k of them. `fromCheckpoint`
bounds the Ed25519 CPU and **not** the heap, and `intervalMs` changes how often a pass starts rather
than what one pass holds, so neither existing lever reaches it.

**What it is was not what the hazard predicted.** The argument on file was about memory and about a
stale verdict. Measured live, three arms over one cluster and one 40-entry chain, differing only in
the config or the binary:

| arm | skips | verdicts | `compromised` | contradictions |
|---|---|---|---|---|
| A1 guard present, `intervalMs: 1` | 2,646 | 208 | **0** | 0 |
| A2 guard present, `intervalMs: 2000` (control) | **0** | 4 | 0 | — |
| A3 guard **absent**, `intervalMs: 1` (the before) | 0 | 38 | **32** | 32 |

The unguarded arm produced **32 `compromised` verdicts out of 38** — an 84% false-positive rate — on
a chain that `verify-chain --full` then answered **OK** over, 278 signatures checked. `compromised`
is the paging `sev1`. So the overlap does not merely consume memory: **it forges the finding the
detector exists to report.**

The mechanism is ADR-0399's witness-memory axis meeting its own concurrency. Each pass loads the
chain, computes the verdict, then appends and anchors that verdict. With k concurrent passes, B loads
the chain before A's verdict lands, A commits, and B's comparison then finds a prior verdict anchored
at a sequence B's loaded chain does not hold → `prior_verdict_contradicted` → `compromised`. So the
axis is sound **iff passes over one scope are serial**, and the guard does not paper over a bug in it
— it establishes the axis's premise. Neither ADR-0399 nor this increment could have seen it alone:
that one shipped the axis, this one made the pass run hourly by default over a widened scope set.

A second measurement **refuted the prediction this increment wrote for it**. I asserted the unguarded
arm would out-run the guarded one, because every tick starts a pass. It produces **fewer** — 38
against 208. `createNodePgConnection` sets no pool `max`, so pg-pool defaults to 10 and k concurrent
folds serialize on the pool and thrash. The guard does not pace a fast detector; it is what makes the
detector fast, by a factor of 5.5 in the same window.

**The fix** is the sibling's guard with one departure: `onPassSkipped` is a **required** callback and
not a silent `return`. The sibling returns silently, and here that would be a falsely-true boot line —
*the hourly proof is running* would be true of the timer and false of the verification. Required
rather than optional, because an optional reporter defaulting to *say nothing* is the defect restated
as a default (ADR-0364); and reported on **every** skipped tick rather than once, because for a scope
whose fold never fits its interval that line is the only thing that ever appears again. The reset is
in a `finally`, and that matters for a reason measured rather than assumed: of five callback-throw
arms (`scopes`, `prove`, `onPass`, and `onError` reached from each of the first two), **only a
throwing `onError` escapes `pass`** — and with the reset outside the `finally` that one escape leaves
`inFlight` set, so every later pass reports `pass_already_in_flight` for the life of the process. One
reporter failure would take the detector down permanently.

**The residual is cross-process and is measured, not predicted.** The guard is in-process, so it
establishes the axis's premise within one replica and says nothing across two. One replica over one
scope at `intervalMs: 1` forges **0**; two replicas over the same scope forge **19** (10 + 9 of 240
verdicts, ~8%), with the chain again verifying by hand at 457 signatures. The remedy is concrete and
already in the repo — `advisoryKeyFor(scope)` plus `pg_advisory_xact_lock`, which the chain's append
path already takes for linearity — and it is a genuine follow-up rather than an oversight, because
the lock would have to span load-compute-append, i.e. a whole fold, which is exactly the duration
this increment's own warn message tells an operator to avoid. No compose file sets `replicas` or
`scale:`, so it is latent on the shipped stack and live for anyone scaling out.

**And this ADR contradicted itself about what a retired scope costs**, which the same measurement
settles. The Consequences bullet said *"one full fold per retired scope on first pass"* and the open
question said *"re-folds every pass until something appends — and nothing ever will"*. Both are true,
of different populations, read off the binary's own `chain=<mode>:<reason>` rendering:

| population | config | fold |
|---|---|---|
| no prior anchor | both flags | `full:no_checkpoint` **once**, then `from_checkpoint` |
| legacy anchor at the tail, provenance NULL | both flags (**shipped**) | `full:anchor_provenance_absent` twice, then `from_checkpoint` — **self-healing** |
| legacy anchor at the tail, provenance NULL | proof **without** `--checkpoints` | `full:anchor_provenance_absent` on **every** pass, `sigs` 35 → 39 |

So the Consequences clause describes the shipped pairing (modulo *one* being one or two) and the open
question describes a deployment running the proof with the checkpoint scheduler off. `DO NOTHING` is
per **sequence**, so once the checkpoint scheduler anchors at a *higher* sequence than the legacy row
the stale anchor is superseded rather than replaced — measured, anchors at 29 `<null>`, 30
`verified_full`, 31–35 `verified_suffix`. The open question's final clause is **refuted twice**:
something does append, namely the proof's own `recordVerdict` (`sigs` growing 35 → 39 is that), and
that growth makes the cost **worse** rather than curing it, because the anchor stays at N while the
chain grows past it. Both sentences are replaced by the table.

## References

- ADR-0301 — credentials travel through the environment, never argv.
- ADR-0358 — one variable with a derived public half, and node's silent discard of an inconsistent `x`.
- ADR-0357 — the `both` verdict: a deployment that stated two things is told it did.
- ADR-0390 — the build-context route, and the `volumes:` key withheld with its reason.
- ADR-0328 — `DeletionCapabilities` is total because a schema default is applied to silence.
- ADR-0334 — a remedy that cannot work is worse than none; the tenant-status gate.
- ADR-0371 — a checkpoint's provenance, and the scheduler that verifies before it anchors.
- ADR-0399 — `isEmptyScope`, which discards an empty scope's report entirely.
- ADR-0338 — refusing breaks nothing that was right.
- ADR-0362 — a type annotation standing in for a check.
- Register P0.3, P2.6 — the deployment items this closes three of.
- ADR-0364 — an optional reporter defaulting to *say nothing* is the defect restated as a default.
- ADR-0337 — a falsely-false control costs a certification; here it costs a page.
