# ADR-0427: A sign-in is admitted before it is verified, and counted before it is judged

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0358 (scrypt, `spendPasswordWork`, the lockout), ADR-0364 (the self route honours the login's lock), ADR-0398 (the timing equaliser on every refusal arm) |

## Context

**H-06**, two halves. The lockout counted a failure **after** verification, as a read-then-write,
so N concurrent wrong passwords all read the counter below the threshold and the lock tripped late —
or never. And nothing bounded how many derivations ran at once: a derivation is 80–130 ms on a libuv
pool of 4 shared with `fs` and `dns`, and 80 concurrent logins for unknown addresses (each spends a
full derivation by design) made an `fs.readFile` during the burst wait **2 095 ms**. An
unauthenticated caller could stall the whole process, not only the login.

## Decision

**Count before judging.** `reserveAttempt` is one conditional `UPDATE` that increments
`credential_failed_attempts` and sets the lock when the count reaches the threshold, only while the
account is not locked, and returns whether a reservation was made. A correct password releases its
reservation (`releaseAttempt`); a wrong one keeps it. So concurrency cannot outrun the threshold:
the database serialises the increments.

**Admit before verifying.** `LoginAdmission` caps concurrent verifications at the libuv pool size
minus one (read from `UV_THREADPOOL_SIZE` the way libuv reads it, so the cap protects the resource it
is derived from), queues at most four times that, and allows two in flight per normalised email.
Past that it answers at once: **503 `saturated`** or **429 `account_busy`**. Neither depends on
whether the email names a user, so it is not an enumeration oracle, and it is deliberately not the
401 — it says *come back*, not *wrong password*.

## Alternatives considered

- **A per-IP limit.** Unavailable: behind Caddy every request arrives from one container address.

## Consequences

Login is still deniable by volume — a flood occupies every sign-in slot — but the process around it
is not. That trade is stated rather than implied away.

## Implementation notes

Verified live on PG 16: 50 parallel wrong passwords for one account gave 2 × 401 and 48 × 429 with
`credential_failed_attempts = 2`; sequentially the lock tripped at exactly 10; the correct password
was refused while locked.

## Open questions

1. `--login-lockout-*` now governs a reservation, not a post-hoc count; the flag names are unchanged.

## References

- `apps/operate-server/src/login-admission.ts`, `credential-store.ts`, `auth-token-route.ts`
