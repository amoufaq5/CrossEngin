# ADR-0437: A chain is checked against its content, its signer is pinned, and its anchors are signed

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0371 (verified anchors), ADR-0375 (anchors read as a set), ADR-0399 (witness memory), ADR-0406 (the chain key from the environment, the overlap guard), ADR-0407 (read order), ADR-0424 (the confined serving role) |

## Context

**H-18**: the hash chain was not tamper-evident against a database writer. The verified report
graded it `partly_fixed` at `f6faf05` and listed what remained: the default pass does not re-fold
history, no verifier recomputes entry hashes, checkpoints are unsigned, a tenant-registered key is
accepted, plus several items this ADR does not touch (see Open questions). All four were still open
when measured through the real `forensics` and `forensics-pg` code:

- **A tail edit passed.** An edited tail `entry_hash` read `fold true sigs true`. The link fold
  compares stored `priorEntryHash` with stored `entryHash`, and the signature covers
  `canonicalEntryBytes`, not `entryHash` — so nothing recomputed the hash from the content.
- **A forged entry passed.** A tail entry signed by another key registered in `meta.crypto_keys`
  read `fold true` with a valid signature against its own key. The resolver (`getByFingerprint`,
  tenant-or-platform scope) pinned neither purpose, status nor owner. Live as `crossengin_app`, a
  tenant **can** register its own Ed25519 key there.
- **Checkpoints were unsigned**, so `sequence_number` and `root_hash` could be edited together —
  the two-column raising ADR-0375 and ADR-0399 left open.
- **No full re-fold**: `fromCheckpoint` defaults to true and nothing folded from genesis
  periodically.

## Decision

**An entry is checked against its content.** `recomputeEntryHash` and `verifyChainEntryHashes` in
`@crossengin/forensics`; `foldWithContent` and `foldSuffixWithContent` in `forensics-pg` report the
earliest break of the link fold and the content check together. Every fold uses them: the store's
`verify`, `verifyChainFromCheckpoint`, every `chain-verify` fold (so the integrity proof and
`verify-chain`), the bounded suffix, and the certification control `audit.tamper_evident_log`.

**A signature counts only if its key is pinned.** `pinnedKeyResolver` and
`PublicKeyResolver.trusts?` give a new failure kind, `untrusted_key`. The trust set is the public
half derived from `AUDIT_CHAIN_SIGNING_KEY` plus `AUDIT_CHAIN_TRUSTED_PUBLIC_KEYS`, for a rotated key
or an auditor's (`chainTrustFromEnv`); an empty pin is refused. Both lifecycles call
`requirePinnedChainKeys(chainTrust)`, which throws if no pin exists. The boot line prints the trust
set and warns, by fingerprint, about any platform `evidence_sealing` key that is registered but not
trusted. `verify-chain` pins from the environment when the keys are present and says when it is
unpinned.

**Checkpoints are signed.** `canonicalCheckpointBytes` is domain-tagged
`crossengin.chain.checkpoint.v1` over scope, sequence, root hash, provenance and checkpointed-at.
The scope is inside the bytes, so a signed row cannot be copied into another scope, and it is
**lowercased**, because `--tenant` and the static tenant lists accept any case. Two new nullable
columns, `signature` and `signing_key_fingerprint`, each with a CHECK, under a both-or-neither table
constraint; no default, added by the ordinary reconciler. The scheduler signs every anchor, and the
lifecycle refuses at boot if its signer is not in the pin. `checkpointSignatureStanding` answers
`signed`, `unsigned`, `untrusted_key` or `bad_signature`, and the anchor audit reads it:

- An unsigned row is counted and is not a finding.
- A mis-signed row is the compromise cause `checkpoint_signature_invalid` (payload key
  `anchorSignatures`) and is never the truncation witness.
- Once any signed row exists, the truncation witness is taken from signed rows only. This closes
  the two-column raising.
- ADR-0399's memory check is fed a separate `readableWitnessSequence`, the unfiltered witness. Fed
  the signed-only figure, an older replica's verdict covering its own unsigned anchor would read
  `witness_regressed` — a false paging `sev1` during every rolling upgrade.
- On a pinned bounded pass, an unsigned latest anchor folds from genesis (`anchor_unsigned`), and an
  untrusted or bad signature does too (`anchor_signature_invalid`). Both heal at the next signed
  anchor. Unpinned admission is unchanged.

**History is re-folded on a schedule.** `fullFoldEveryPasses`, default 24 (daily at the hourly
interval), 0 for never, counted per scope, with the first pass after boot a full fold reporting
`periodic`. CLI `--integrity-proof-full-every N`, refused without `--integrity-proof`; under
`--integrity-proof-config` it says to set the field in the file.

ADR-0406's overlap guard is unchanged, and ADR-0407's read order holds: the signature check reads
only what is already loaded and adds no compared read. An unpinned pass still reads
`meta.crypto_keys`; a pinned one does not.

## Alternatives considered

- **Keep the registry as the fallback when no environment key is set.** The first implementation
  wired `chainTrust ?? new PostgresKeyRegistry(conn)` and described it as keeping a working
  deployment on the registry. Review found it was dead code: the pin is built whenever a chain key
  resolves, by either route, and with no key both lifecycles skip, so the fallback could never run —
  and a `node.ts` fence pinned it as the expected wiring. Replaced with `requirePinnedChainKeys`.
- **Feed the memory check the signed-only witness.** Refused: it pages on an honest rolling upgrade
  (above). An unsigned row can only raise the unfiltered figure, so that figure hides no regression
  the memory caught before.
- **Recompute hashes over the whole prefix on every bounded pass.** Not taken. Every bounded pass
  already loads the chain, and recomputing measured 751 ms per 100k entries, about 20× cheaper than
  the signatures — but doing it every pass is a cost decision, so the periodic full fold bounds the
  window instead (Open questions).
- **Refuse unsigned checkpoints outright.** Refused: every existing row is unsigned, and older
  replicas write unsigned rows during an upgrade. They are counted, not paged.

## Consequences

A one-column edit to an entry is detected at the next fold that covers it; a key nobody pinned
cannot sign a verifying entry; and a raised checkpoint cannot manufacture a `TRUNCATED` once a
signed anchor exists. Two existing tests pinned the defect as the specification and are rewritten:
a `chain-verify` test expecting "integrity valid" for a below-anchor payload rewrite now expects a
content break at sequence 1, and the certification test's "intact chain" fixture, built from
made-up hashes, now uses a real chain beside a new case asserting a content-mismatched chain is not
certified.

**Upgrade cost:** a deployment that rotates its key must list the old public key in
`AUDIT_CHAIN_TRUSTED_PUBLIC_KEYS`, or older entries and checkpoints read `untrusted_key`, which
pages. The boot warning names those keys; nothing refuses.

## Implementation notes

In process: forensics 151, forensics-pg 141, kernel 949, kernel-pg 841, tenant-lifecycle-pg 527,
operate-server 5,674 in 149 files and the workspace rules 796 pass, with typechecks clean. Eighteen
mutations across the implementation and the review were each caught and reversed — among them the
content check removed from the folds, the pinned resolver ignoring trust, the scope dropped from or
not lowercased in the checkpoint bytes, the signed-only witness ignored, the memory fed the
signed-only witness, the periodic fold never firing, the bounded call site reverted to the link-only
`verifyChainSuffix`, the lifecycle passing no signer or no trusted keys, a `node.ts` site reverted
to the registry, and certification reverted to links only. Two of those fences were vacuous before
review (the periodic-fold wiring and the bounded call site) and are fenced now.

Live on PG 16, `verify-chain` run as `crossengin_app`:

- A one-column edit of the tail `entry_hash` reads FAILED, "BROKEN at 32 (entry hash does not
  match its content)", in the full fold and in bounded mode.
- An entry signed by a key the tenant registered itself reads `seq 10: untrusted_key`, exit 1,
  pinned. Unpinned it reads OK, exit 0, and labels itself "any registered key verifies".
- All 12 checkpoint rows were signed by the chain key. Raising one to sequence 99 with `root_hash`
  set to `ff…` reads `checkpoint at 99: bad_signature` pinned, with the witness falling back to 28
  and no truncation; unpinned still reports the false `TRUNCATED` at 99.
- The first integrity-proof pass after boot ran `chain=full:periodic`; the two edited tenants read
  `compromised`, the platform `verified`, and the checkpoint scheduler refused to anchor both.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A one-column edit **below** the anchor waits for the periodic full fold (up to 24 passes): live, bounded mode reported integrity valid for an edit at entry 3 while the full fold reported BROKEN. Content-check the prefix on every bounded pass at ~751 ms per 100k entries? | Platform | _open_ |
| An attacker who strips every row's signature returns the witness to all rows, allowing one pass of false `TRUNCATED` until the next signed anchor. On a deployment holding only legacy unsigned rows the two-column raising stays open until the first signed pass. | Platform | _open_ |
| `deploy/` documents neither `AUDIT_CHAIN_TRUSTED_PUBLIC_KEYS` nor `--integrity-proof-full-every`. | Platform | _open_ |
| Anyone holding `AUDIT_CHAIN_SIGNING_KEY` can rewrite and re-sign the chain: external anchoring and HSM custody are out of scope. A superuser or `BYPASSRLS` role, open `UPDATE` on the chain tables, and the 500-row audit-row anchor window are unchanged. | Platform | _open_ |
| `verify-chain` without the environment keys is unpinned and says so. | Platform | _open_ |

## References

- `packages/forensics/src/tamper-evident-logs.ts`, `sealing.ts`
- `packages/forensics-pg/src/chain-log-store.ts`, `chain-signature-verify.ts`, `checkpoint-store.ts`
- `packages/kernel/src/bootstrap/meta-schema.ts`
- `apps/operate-server/src/chain-verify.ts`, `anchor-audit.ts`, `integrity-proof.ts`,
  `integrity-escalation.ts`, `checkpoint-scheduler.ts`, `audit-chain-env.ts`,
  `audit-chain-key-registration.ts`, `certification.ts`, `cli.ts`, `node.ts`,
  `bin/operate-server.ts`
