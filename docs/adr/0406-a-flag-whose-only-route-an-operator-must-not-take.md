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
  deployment with many retired tenants pays one full fold per retired scope on first pass, at a
  measured 107 µs per entry. `--deletion-capability` requires six entries on argv, which is verbose
  by design.
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
| A full fold per retired scope on first pass is unbounded in the chain's length. ADR-0371's `DO NOTHING` means an **idle** retired tenant's anchor is never replaced, so such a scope re-folds every pass until something appends — and nothing ever will. | platform | 2026-12-15 |
| `--deletion-capability` names six subsystems on argv and four of them can only be `absent` today, because their erasures do not exist (register P2.6). Whether the honest default is a shorter flag that names only what this deployment *has* is a contract question about `DeletionCapabilities`' totality. | platform | 2027-01-15 |
| P0.3's remaining background flags — `--schedule-ms`, `--workflow-workers`, `--notification-template-routes`, `--rate-limit-policy` — are each still gated on their own answer to the three per-flag questions. | platform | 2027-01-15 |

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
