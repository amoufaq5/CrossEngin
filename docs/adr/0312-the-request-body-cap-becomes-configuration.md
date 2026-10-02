# ADR-0312: The request body cap becomes configuration, and the two adapters share it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0267 |

## Context

ADR-0267 recorded "request bodies cap at 10 MiB → 413, a platform-wide gap since P1.7". Two things were
wrong, and the second was the serious one.

**The cap was a constant.** `MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024` in `node.ts`, unchangeable
without a rebuild. A deployment importing a 40 MiB CSV through `@crossengin/migration` had no way to
raise it, and one serving only small entity writes had no way to lower it.

**Only the Node listener enforced it.** `createFetchHandler` — the Fetch/Workers edge adapter, the same
`dispatch` core — read the whole body with no limit at all. So the control existed on one of the two
paths into the same server, and the one without it is the one that runs at an edge, where an
unauthenticated connection is cheapest to make.

The cap is not a convenience. The listener buffers a body **in memory, whole, per concurrent request**,
before it dispatches. It is the only thing bounding what one unauthenticated connection can make the
process allocate.

## Decision

**One module, `request-body-limit.ts`, owns the cap; both adapters delegate to it.**

`readLimitedBody(source: AsyncIterable<Uint8Array>, limitBytes)` is the single enforcement point. Node's
`IncomingMessage` is already an `AsyncIterable<Uint8Array>`; the Fetch adapter's `streamChunks` drives a
`ReadableStream` reader by hand and releases the lock in a `finally`. So the two paths differ in how they
produce chunks and not in what is done with them.

Three properties, each of which is why this is a module rather than a number:

- **Enforced per chunk, as the body arrives.** Checking `content-length` is not enough — a chunked
  request declares none, and a header is a claim — and checking after the read is not a control at all,
  because by then the allocation has happened. `readLimitedBody` throws on the chunk that crosses the
  line and never requests the next one, so an over-limit request costs the bytes already in flight and
  nothing more.
- **A configured value cannot disable it.** There is no "unlimited". Absent means the default; a value
  outside the band is **refused rather than clamped**, because silently accepting a nonsense cap is how
  the control goes missing. `0` and `Infinity` are not a tighter and a looser setting — they are the
  absence of a cap in two directions.
- **A floor, not only a ceiling.** `MIN_REQUEST_BODY_LIMIT_BYTES = 1 KiB`, because a cap below a few
  kilobytes 413s ordinary JSON entity writes, which reads to a client as a broken server rather than a
  strict one. `MAX_REQUEST_BODY_LIMIT_BYTES = 1 GiB`, because the body is held whole in memory per
  concurrent request and a value above that is indistinguishable from no cap — a deployment that
  genuinely must accept more wants the signed-URL upload path in `@crossengin/files`, not a bigger
  buffer.

`resolveMaxRequestBodyBytes` is called **once at build time**, not per request: an out-of-band limit must
fail the boot, not every request after it.

`parseRequestBodyLimit` accepts a bare integer or a `kb`/`mb`/`gb` suffix and returns a result rather
than throwing, so the CLI can attach its own flag name. The suffixes exist because a cap written in raw
bytes is a place to lose a factor of 1000 by eye, and the mistake is only visible in production.

Both adapters map `RequestBodyTooLargeError` to a 413 RFC 9457 problem document.
`MAX_REQUEST_BODY_BYTES` stays exported from `node.ts` as a re-export of the default, because callers
import it.

## Alternatives considered

- **Option A:** keep the constant and raise it.
  - **Pros:** no new surface; one edit.
  - **Cons:** whatever number is chosen is wrong for somebody, and raising it weakens the control for
    every deployment that did not need it raised. It also does nothing about the Fetch adapter.
  - **Why not:** the gap was not the value.

- **Option B:** trust `content-length` and reject before reading.
  - **Pros:** zero bytes allocated for an over-limit request; one header comparison.
  - **Cons:** a chunked request declares no `content-length`, and a declared one is a claim a client can
    simply lie about. Either way the per-chunk check is still required, which makes this an optimisation
    rather than a mechanism.
  - **Why not:** worth adding later as a fast path; useless as the control.

- **Option C:** clamp an out-of-band configured value into the band.
  - **Pros:** never fails a boot; the operator always gets a working server.
  - **Cons:** the operator asked for 10 GiB and got 1 GiB, with no error. The next incident is debugged
    against a number nobody set.
  - **Why not:** a silently-adjusted security control is worse than a refused boot. The boot failure is
    at the one moment somebody is watching.

- **Option D:** allow a sentinel for "unlimited" for a trusted internal deployment.
  - **Pros:** covers the bulk-import case without a second path.
  - **Cons:** it makes the one memory bound in the request path optional, and "trusted internal" is a
    property of today's network topology, not of the code.
  - **Why not:** `@crossengin/files` exists for large payloads, and it does not hold them in memory.

## Consequences

- **Positive:** the cap is configurable, the two adapters cannot drift apart on what it is or when it
  fires, and the Fetch/Workers path has a body limit for the first time. An out-of-band value fails at
  boot.
- **Negative:** a deployment that previously relied on the Fetch adapter accepting an oversized body now
  gets a 413. That is the fix, but it is a behaviour change on an existing path.
- **Neutral:** `content-length` is still not consulted, so an over-limit request is detected mid-body
  rather than at the header. The bytes already in flight are the cost.
- **Reversibility:** the default is the old constant, so a deployment that configures nothing behaves
  exactly as before. The module is one file and both adapters call one function.

## Implementation notes

- `apps/operate-server/src/request-body-limit.ts`; `node.ts` and `edge.ts` both delegate.
  `createNodeRequestListener(server, maxRequestBodyBytes?)` and
  `createFetchHandler(server, maxRequestBodyBytes?)`, plus
  `BuildEdgeFetchHandlerOptions.maxRequestBodyBytes`.
- `streamChunks` drives the `ReadableStream` reader explicitly rather than using `for await`, because the
  lock has to be released in a `finally` — an early throw mid-body otherwise leaves it held.
- `--max-request-body <size>` on `operate-server`; `parseRequestBodyLimit`'s failure becomes a
  `CliUsageError` naming the flag.
- `readLimitedBody` returns `null` for an empty body, which the gateway distinguishes from a zero-length
  one. Preserved from the previous implementation.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A `content-length` fast path would reject an honest oversized request before any allocation. Worth adding beside the per-chunk check? | amoufaq5 | _unscheduled_ |
| The cap is platform-wide. A per-route or per-tenant limit (a bulk-import endpoint wanting more than an entity write) is unaddressed. | amoufaq5 | _unscheduled_ |

## References

- ADR-0267 (the gap, recorded as platform-wide since P1.7).
- RFC 9457 problem details; RFC 9110 §15.5.14 (413 Content Too Large).
