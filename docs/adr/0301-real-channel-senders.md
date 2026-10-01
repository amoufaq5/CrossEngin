# ADR-0301: Real email and SMS senders, configured from the environment (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0274 (notification delivery), ADR-0280 (AI provider base URLs), ADR-0302 (bounces feed suppressions) |

## Context

ADR-0274 built the `ChannelSender` seam, the retry ladder and suppression handling, and shipped one
implementation: `in_app`. Email and SMS had a contract and no sender, so a tenant's invoice notice was
planned, throttled, digested and then refused as `no_sender_configured`. The whole notification stack
worked except the part that reaches anyone.

## Decision

A new `@crossengin/notification-providers` package implements two real senders behind the existing
contract — `SesEmailSender` (SES v2 `SendEmail`, signed with a real SigV4 chain from
`@crossengin/crypto`) and `TwilioSmsSender` (form-encoded, Basic auth) — and `operate-server` builds
its registry from the **environment**, not from CLI flags.

Environment, because every one of these values but the sender identity is a credential and a process's
argv is readable by anyone who can run `ps`. The AI providers already resolve this way
(`buildDesignProviderFromEnv`); `--stripe-api-key` does not, which is a weakness this does not copy.

Three rules make the wiring's failure modes legible rather than silent:

1. **`in_app` is always registered**, so an unconfigured channel is refused per-delivery as
   `no_sender_configured` — which the drain already treats as retryable, so configuring the channel and
   re-draining delivers the backlog — rather than the registry coming back empty.
2. **Half-configured is a warning, not a guess.** A channel nobody touched is silent; a channel with
   some of its variables set is reported with what is missing. Sending nothing while looking healthy is
   the failure this exists to make loud, which is also why a missing `SES_CONFIGURATION_SET` or
   `TWILIO_STATUS_CALLBACK_URL` warns: without them no bounce can ever arrive (ADR-0302).
3. **A provider refusing its options costs its channel, not the process.** The senders validate in
   their constructors — a secret too short to derive a signing key, an ambiguous sender identity — and
   throw. Letting that escape would mean one typo'd credential takes the whole API down at boot, when
   the notification stack is not what the API is for.

`SES_ENDPOINT_URL` / `TWILIO_BASE_URL` override the endpoint. That is a deployment concern rather than
a credential — SES is reachable through a VPC interface endpoint and some networks only allow egress
via a proxy, the same reasoning as ADR-0280 — and it is what makes this path verifiable against a local
endpoint instead of only against a fake.

## Alternatives considered

- **Option A: CLI flags, like `--stripe-api-key`.**
  - **Pros:** consistent with an existing flag; visible in the process's own invocation.
  - **Cons:** `ps` publishes argv to every local user, and a compose file's `command:` ends up in shell
    history and image layers.
  - **Why not:** these are long-lived credentials for sending mail as the tenant's domain.

- **Option B: per-tenant provider credentials in `meta.operate_tenant_settings`.**
  - **Pros:** a tenant could send from its own SES account.
  - **Cons:** the platform would store and rotate each tenant's AWS credentials, and a tenant admin who
    can edit settings could redirect the platform's mail.
  - **Why not:** wanted eventually, but it is an authorization design, not a wiring change.

- **Option C: refuse to boot when a channel is half-configured.**
  - **Pros:** impossible to run a deployment that silently sends nothing.
  - **Cons:** a partial variable set — common when a secret mount is empty — takes down an API whose
    entities, reports and workflows are all fine.
  - **Why not:** the warning plus an unroutable channel is the proportionate failure. A *bad* secret on
    the bounce webhook is different and does refuse (ADR-0302), because that route writes.

- **Option D: pick one when both Twilio sender identities are set.** Taken, with the messaging service
  winning. The provider accepts exactly one, so two values have to be resolved somewhere; the messaging
  service is a pool that may contain the number, Twilio's own guidance for production traffic, and the
  one an operator adds *after* starting with a single number — so it is the later intent of the two.
  Refusing the channel over two valid values would be worse.

## Consequences

- **Positive:** email and SMS actually send. A deployment that wants only in-app notices is unchanged
  and silent.
- **Negative:** one platform-wide set of provider credentials, so all tenants send from one domain.
- **Neutral:** the endpoint overrides exist mostly for proxies and VPC endpoints, and are what make the
  path testable; they also mean a misconfigured override sends mail somewhere unintended, which the
  boot log names.
- **Reversibility:** unsetting the variables returns the deployment to in-app only, immediately.

## Implementation notes

- `packages/notification-providers/src/email-ses.ts`, `sms-twilio.ts`; zero runtime dependencies,
  injectable `fetch`.
- `apps/operate-server/src/delivery-senders-env.ts` — the registry builder and its skip report, logged
  at boot. It also warns when a real channel is configured but no drain is running, since the channel
  list would otherwise read as "email works" to an operator who never passed
  `--notification-drain-ms`.
- Verified live end to end: a throwaway Postgres, the real `operate-server` with both providers pointed
  at a recording endpoint, and a queued dispatch to two recipients. The drain composed a real
  SigV4-signed `POST /v2/email/outbound-emails` carrying the configuration set and `EmailTags` for
  `dispatch_id` / `tenant_id` / `attempt` — which is what lets a bounce correlate back — and recorded
  two `delivered` rows with `provider = ses`, HTTP 200, and the recipient stored only as a sha256.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Per-tenant sending identities (a tenant's own domain) — an authorization design, not a wiring one. | amoufaq5 | _unscheduled_ |
| Should `--stripe-api-key` move to the environment for the same reason? | amoufaq5 | _unscheduled_ |
| No push (`push_mobile`) or voice sender; the contract has 18 providers and 2 are implemented. | amoufaq5 | _unscheduled_ |

## References

- AWS SES v2 `SendEmail`; AWS SigV4.
- Twilio Programmable Messaging `Messages` resource; messaging services.
- ADR-0274, ADR-0280, ADR-0302.
