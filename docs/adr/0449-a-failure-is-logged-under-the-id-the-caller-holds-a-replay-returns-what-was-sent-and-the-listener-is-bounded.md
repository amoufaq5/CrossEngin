# ADR-0449: A failure is logged under the id the caller holds, a replay returns what was sent, and the listener is bounded

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0359 (a thrown handler is a 500 whose body names nothing; the recorder seam its Q3 left open), ADR-0336 (`PostgresIdempotencyStore`, whose stated guarantee closed only the sequential retry), ADR-0417 (the empty-body replay documented as a hazard), ADR-0335 (`--rate-limit-policy`), ADR-0334 and ADR-0376 (the tenant-status gate, opt-in in the binary and on in the compose), ADR-0394 (`--trusted-edge-client-cert`), ADR-0425 (the serving pool), ADR-0428 (a privileged write recorded in its own transaction), ADR-0338 (refuse only when nothing correct breaks), ADR-0382 and ADR-0439 (the other halves of H-22) |

## Context

The external due-diligence audit's **M-02, M-03, M-04, M-18 and M-22** were verified open or partly
fixed at `f6faf05`, and **H-22**'s remainder after ADR-0382 and ADR-0439 includes *"write 500
unlogged"*. Measured at HEAD before this slice:

- **M-02.** The listener's catch wrote the exception message into the response
  (`node.ts`, `detail = err.message`), reachable before authentication, and the gateway's stage loop
  had no catch. A write that failed answered 500 `write_failed` and **logged nothing**, so an
  operator had no line to find (the H-22 remainder).
- **M-04.** A replay answered 201 with an **empty body** (the audit's L23: `replay_body_len: 0`),
  error responses were persisted as completed, and there was no in-progress reservation, so two
  concurrent retries of one key both executed — the case ADR-0336's guarantee had stated it did not
  close.
- **M-03.** Rate limiting runs after authentication, so nothing bounds an unauthenticated caller,
  and the shipped compose declares no `--rate-limit-policy` (L22: 300 × 200). `deploy/README.md` and
  `deploy/ORACLE.md` described the limiter as *"durable, cross-replica"*, which is false: the window
  is counted per process.
- **M-22.** `maxConnections` was unlimited and keep-alive was Node's 5 s, behind a Caddy whose
  upstream idle is two minutes. On SIGTERM, `server.close()` had no grace bound and the database
  pool was never closed. One unhandled rejection anywhere ended the process with exit 1 (Node 22's
  default).
- **M-18.** The tenant-status gate was opt-in in the binary (on only in the compose, since
  ADR-0376). The console's `setStatus` re-checked nothing, so concurrent transitions all succeeded.
  Tenant creation wrote no audit row.

Two claims are corrected rather than repeated. *"No listener timeouts"* is **partly false**: Node 22
already applies a 60 s headers timeout and a 300 s request timeout. What was missing was a
connection cap, a keep-alive longer than the proxy's, flags for all of them, and a bounded drain.
And `operate-runtime`'s `handlers.ts` comment saying an operator can recover a failed write's
message *"from the process log"* is false: `writeTxn` drops the message.

## Decision

**A 5xx names nothing to the caller and is logged once under the id the caller was given.** The
listener's catch, the gateway's stage loop and the Fetch-path adapter (`edge.ts`, which rethrew a
body that failed mid-read to the host runtime) all answer a fixed 500 carrying an `x-request-id`,
and log a `[5xx]` JSON line with the stack under that id. `OperateHttpServer.dispatch` logs any 5xx
the gateway did not already log, with `stage: "pre_gateway"`, and tracks which responses were logged
so none is reported twice. A failed write answers `write_failed` and its `[5xx]` line names the
operation and stage. The rule is ADR-0359's — the body names nothing — with the id as the join an
operator needs between a caller's report and the log.

**A keyed write is reserved before it runs, a success is recorded with its body, and a refusal is
not recorded.** The idempotency store takes a reservation on the key with a lease; a concurrent
request on a held key gets **409** ("still being processed"). Only a response below 400 is
recorded, with its body, so a replay returns the original bytes with `x-idempotent-replay: true`; a
response of 400 or above releases the reservation, so a retry re-executes. The key-shape check
(422) applies only to POST, PUT, PATCH and DELETE, the methods the gateway keys; on a read the
header is ignored, as it was before. The shutdown report counts stored records and failed
releases separately, and is printed after the listener drains.

**An unauthenticated caller can be bounded per process, and the limiter says it is per process.**
`--pre-auth-rate-limit <requests>/<seconds>` bounds requests per (address, credential shape) before
authentication, the login included, answering 429 with `retry-after`. The key is the credential's
**shape**, not its value, because keying on the value would let a caller reset its budget with a new
token. The address is the socket's unless `--trusted-edge-client-cert` is passed, then the rightmost
`x-forwarded-for` entry. The post-authentication limiter's boot line and both deploy documents now
say it counts a per-process fixed window.

**The listener is bounded and stops cleanly.** `--http-headers-timeout-ms`,
`--http-request-timeout-ms`, `--http-keep-alive-timeout-ms` (default 125000, longer than Caddy's
two-minute upstream idle), `--http-max-connections` (default 4096) and `--shutdown-grace-ms`
(default 8000) are printed at boot. On SIGTERM the listener stops accepting, in-flight requests
drain within the grace period, and then the pool is closed. An unhandled rejection is logged with
its stack and counted and the process keeps serving; an uncaught exception is logged and shuts the
process down gracefully with exit 1.

**A tenant's status moves only from the state it was read in, its creation is recorded, and the
gate is on by default.** `setStatus` re-checks the source state in the same statement and a
transition that lost the race is **409 `concurrent_transition`**. Tenant creation commits a
`platform.tenant_created` audit row in the transaction that inserts the tenant. On a Postgres store
the tenant-status gate is on unless `--no-tenant-status-gate` is passed, which is announced at boot;
passing both flags is refused. This is a named, announced hatch rather than ADR-0338's
nothing-breaks rule, because the gate refuses a credential whose tenant has no `meta.tenants` row,
which ADR-0376 measured being served 200 today.

## Alternatives considered

- **Key the pre-authentication budget on the credential value.**
  - **Pros:** a caller with a valid key would not share a budget with a wrong-key caller from the
    same address.
  - **Cons:** a new token resets the budget.
  - **Why not:** the limiter exists to bound guessing, and per-value keying makes each guess free.
    The cost is measured live and documented: a valid key from an address that has spent its
    budget on wrong keys is 429.
- **Turn the pre-authentication limiter on by default.**
  - **Why not:** on the shipped stack every caller arrives from the Caddy container's address, so a
    default would be one budget shared by every caller. The boot line says this.
- **Ship a default `--rate-limit-policy`.**
  - **Why not:** `deploy/README.md`'s ADR-0338 argument stands — a default ceiling on upgrade would
    refuse traffic that works today.
- **Make the post-authentication window durable across replicas.**
  - **Why not here:** the defect on file was the documents claiming durability; the honest step is
    to say what it counts. Durability is left open below.
- **Cache 4xx responses, as the store did.**
  - **Why not:** a client that corrects its body after a 422 would be answered the cached refusal
    for the key's lifetime. Review found the premise *"a refusal commits nothing"* is false in at
    least two places (see Open questions); the erasure involved is idempotent, so the harm is low.
- **Gate `platform.*` routes on the caller's tenant status.**
  - **Why not:** those routes act on the deployment, and gating them would block the route that
    reactivates a suspended tenant.
- **Keep Node's default that an unhandled rejection is fatal.**
  - **Why not:** a fire-and-forget callback in any scheduler took the whole server down mid-request
    with no drain and no pool close. A rejection nobody caught is a missing `catch`; the request it
    belonged to has already failed and the others are unaffected.

## Consequences

- **Positive:**
  - No 5xx body echoes an exception, and every logged 5xx can be found by the id the caller holds.
  - A replay returns what the first request returned, and concurrent retries of one key execute
    once.
  - An unauthenticated caller can be bounded, and the documents no longer claim a durable limiter.
  - A SIGTERM closes the pool; a stray rejection no longer kills the process.
  - Concurrent tenant transitions cannot all succeed, and tenant creation is on the audit trail.
- **Negative:**
  - A POST, PUT, PATCH or DELETE carrying a malformed `Idempotency-Key` is now 422.
  - A concurrent request on a held key is 409 until the first finishes or its lease lapses.
  - The tenant-status gate is on by default on a Postgres store: a credential whose tenant has no
    `meta.tenants` row is refused unless `--no-tenant-status-gate` is passed.
  - A deployment with more than 4096 open sockets per process now has connections dropped.
- **Neutral:** the pre-authentication limiter is off by default, so the shipped stack is unchanged
  on that axis.
- **Reversibility:** every listener bound is a flag; the gate has its hatch; the reservation and the
  body-recording are store changes with no schema migration named in either report.

## Implementation notes

- Changed (implementer and review together): `packages/api-gateway-runtime/src/` (`runtime.ts`,
  `stores.ts`, `problems.ts`, `runtime-idempotency.test.ts`); `packages/api-gateway-pg/src/`
  (`idempotency-store.ts`, `rate-limit-checker.ts` and their tests);
  `apps/operate-server/src/` (`server.ts`, `node.ts`, `edge.ts`, `platform-admin.ts`, `cli.ts`,
  `gateway-idempotency.ts`, `pre-auth-limit.ts`, `http-listener.ts`, `process-lifecycle.ts` and their
  tests); `apps/operate-server/bin/operate-server.ts`; `deploy/README.md` (the idempotency
  paragraph, the `[rate-limit]` boot line, a section *"The listener, and stopping it"*, and the 5xx
  responses that carry no id); `deploy/ORACLE.md` (the `--rate-limit-policy` row).
- **Review found and fixed four defects in the implementation** and three wrong sentences in
  `deploy/README.md`:
  1. The key-shape check ran for every method, so a GET carrying a malformed key — ignored before
     the slice — was refused 422. It now runs only for the four keyed methods.
  2. The shutdown report counted every successful `release` as a stored record (the implementer's
     live *"6 record(s) stored"* included releases), and called a failed release *"NOT stored — a
     retry would re-execute"*, which is false: the reservation stands and a retry is 409 until its
     lease lapses. Releases are now counted separately and the message names the failed operation.
     The test pinning the old count was rewritten.
  3. The report was taken before the listener drained; it is now printed after.
  4. A 5xx answered by the webhook route, inside `dispatch` before the gateway, was never logged;
     `dispatch` now logs it as `pre_gateway`.
- **Mutation checks.** Implementer: 17 of 18 caught (stage-loop catch, reservation ignored, replay
  body dropped, pg reserve expiry guard, pg release-own-only, `setStatus` guard, creation unrecorded,
  gate default, XFF trust, max connections, rejection exits, listener echo, server catch, server 5xx
  report, edge catch, loop-denial release). The survivor — removing the explicit release on a
  response of 400 or above in dispatch — is redundant coverage: the loop's denial path releases too.
  Review re-ran a subset and it held, and added: removing the method gate on the key-shape check
  (the GET test fails), always and never treating a 5xx as logged (the webhook test, and the
  double-reporting assertion in the write-500 test). The pg `reserve` expiry fence is caught only by
  an assertion on the SQL text against the fake.
- **In process:** api-gateway-runtime 423 passed, api-gateway-pg 185/185, typecheck clean on both;
  operate-server 157 of 158 files (5,857 tests) and typecheck clean, the failing file being
  `workflow-workers.test.ts`, another lane's; testing 905/906, the failure being the `pg-record-reads`
  rule on another lane's `cost-store.ts`. These are the review's figures; they supersede the
  implementer's earlier ones.
- **Live, independent run on PG 16 as `crossengin_app`, `--store pg`** (port 5982):
  - `GET http://[`: 500 problem document `internal-server-error`, `x-request-id` equal to the body's
    `requestId`, *"Invalid URL"* absent from the response, `[5xx]` line and stack logged under the
    same id.
  - `INSERT` revoked on `meta.operate_entity_records`: 500 `write_failed` with an `x-request-id`,
    `[5xx]` line naming `vendor.create`, `dispatch_handler`, `handler_returned_500`; after restoring
    the grant the same key is 201, so the 500 was not cached.
  - Replay: 201, 307 bytes, byte-identical to the original, `x-idempotent-replay: true`.
  - Five concurrent POSTs on one key: 201 and four 409; exactly one row.
  - A 422 twice on one key: 422, 422; the same key with a valid body then 201.
  - GET with a two-character key 200; POST with it 422.
  - Three tenant creations: three `platform.tenant_created` rows.
  - Ten rounds of three parallel suspends: 10 × 200, 18 × 409 `concurrent_transition`,
    2 × 409 `illegal_transition`; the lifecycle trail holds exactly 11 suspend and 11 activate. (The
    run's summary reported *20 × 409*; the per-arm table gives the split, which is used here.)
  - `--pre-auth-rate-limit 3/60`: four wrong api-keys 401, 401, 401, 429 with `retry-after: 60`;
    anonymous and Bearer-shaped requests from the same address 401 and 401 (separate shape budgets);
    a valid api-key from that address afterwards 429.
  - `--http-max-connections 5`: five idle sockets stay open, the sixth is dropped.
    `--http-keep-alive-timeout-ms 1500`: the idle socket is closed at 2504 ms (Node adds a one-second
    buffer).
  - SIGTERM: exit 0 in 1.33 s, `[idempotency] 4 record(s) stored, 0 failed` — exactly the four keyed
    successes — and a new connection 0.2 s later refused.
  - The gate's default and hatch were verified in the marketplace slice's live run: on by default,
    the boot line names the hatch, and both flags together exit 2.
- **Earlier live runs as the non-owner `serving` role:** the implementer's (port 5987) confirmed
  pool close with a control — at Postgres `debug1`, SIGTERM produced 0 *"unexpected EOF"* lines over
  three connections while `kill -9` produced 3 — and replaced its own earlier zero count, which was
  vacuous at the default log level. The review's (port 5996) confirmed one stored key plus two 422
  refusals print `1 record(s) stored, 0 failed`, where the old report would have printed 3. The
  review measured on Node v22.23.4 that `headersTimeout` does not close an idle keep-alive socket.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A failed write's cause is still discarded: `writeTxn` drops it, so the `[5xx]` line records only `handler_returned_500`, and the `handlers.ts` comment saying the message is in the process log is false. Needs a recorder on `HandlerContext` (ADR-0359 Q3). | CrossEngin platform | _unscheduled_ |
| ~~Stage and handler throws lose their stack: `onInternalError` is not wired in `operate-runtime`'s `compile.ts`~~. **Closed in the commit that landed this ADR**: `compile.ts` declares and forwards it and `server.ts` wires `logGatewayInternalError`, which logs the stack under the request id. A review after the commit found one call site that is not a 500 — a failure to complete the durable idempotency record after the handler succeeded, which the gateway swallows so the caller keeps its 2xx — so the callback now carries `answered: "500" \| "success"` and the second logs as `[post-commit]` rather than `[5xx]`, naming the consequence (a retry with the same key may run again). | CrossEngin platform | closed |
| ~~`--http-headers-timeout-ms` does not bound what it names~~ (measured: 2000 ms answered a slowloris 408 after 26.2 s, because Node sweeps for expired timeouts every 30 s). **Closed in the commit that landed this ADR**: `connectionsCheckingIntervalFor` sets the sweep to half the shorter timeout (1 s floor, 30 s cap so the defaults are unchanged), and a test opening a raw socket now gets its 408 in about 2 s with a 1 s headers timeout; with the line removed it hangs past 10 s. | CrossEngin platform | closed |
| Three 503s answered before any route carry no `x-request-id` and produce no `[5xx]` line: `/readyz` with the database unreachable, the login's two (load shedding; store, mint or record failure) and an unbuildable tenant gateway. Documented, not fixed. | CrossEngin platform | _unscheduled_ |
| The post-authentication rate window is per process, so N replicas admit N times the policy. A shared window is unbuilt. Once 10,000 or more windows are live, every new key rescans them all. | CrossEngin platform | _unscheduled_ |
| Under `--per-tenant-manifests` (implied by `--ai-design`, which the shipped compose passes) a Bearer token's Ed25519 signature is verified before the pre-authentication limiter runs, so that check is unthrottled. | CrossEngin platform | _unscheduled_ |
| Under `--trusted-edge-client-cert`, callers that bypass Caddy (operate-web, or the loopback `127.0.0.1:8787` port) can set `X-Forwarded-For` and obtain fresh pre-authentication budgets. Console traffic arrives through the web proxy, which forwards no address, so its budget collapses to one. | CrossEngin platform | _unscheduled_ |
| The Fetch (edge) path has no pre-authentication limiter and no default tenant-status gate, and takes its remote address from `cf-connecting-ip` or `X-Forwarded-For` unconditionally. Latent: nothing shipped uses it. | CrossEngin platform | _unscheduled_ |
| A refusal is not always free of effects: `tenant-erasure-routes`' 500 `erasure_unrecorded` follows a dropped schema and its 409 `erasure_refused` writes an audit row, yet neither is cached, so a retry re-executes. The erasure is idempotent, so the harm is low. | CrossEngin platform | _unscheduled_ |
| The process deadline (grace plus 2 s, 10 s by default) equals Docker's stop timeout, so the two race. | CrossEngin platform | _unscheduled_ |
| The pg `reserve` expiry fence is tested only as SQL text against the fake, not against a database. | CrossEngin platform | _unscheduled_ |
| The tenant-creation audit row records actor kind `user` for an api-key service account, because the actor vocabulary has no service-account kind (as on the sibling routes). | CrossEngin platform | _unscheduled_ |

## References

- `apps/operate-server/src/node.ts`, `server.ts`, `edge.ts`, `http-listener.ts`,
  `process-lifecycle.ts`, `pre-auth-limit.ts`, `gateway-idempotency.ts`, `platform-admin.ts`,
  `cli.ts`; `apps/operate-server/bin/operate-server.ts`
- `packages/api-gateway-runtime/src/runtime.ts`, `stores.ts`, `problems.ts`
- `packages/api-gateway-pg/src/idempotency-store.ts`, `rate-limit-checker.ts`
- `deploy/README.md`, `deploy/ORACLE.md`
- ADR-0334, ADR-0335, ADR-0336, ADR-0338, ADR-0359, ADR-0376, ADR-0394, ADR-0417, ADR-0425,
  ADR-0428
