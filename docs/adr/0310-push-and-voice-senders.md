# ADR-0310: Push and voice senders, and a push payload that cannot carry content

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0301, ADR-0302 |

## Context

ADR-0301 shipped two of eighteen declared providers — SES for email and Twilio for SMS — plus `in_app`.
`push` and `voice` had contracts, `CHANNEL_CAPABILITIES` entries, templates and a dispatch ledger, and
no sender: a `push` notification planned by the engine had nowhere to go.

Push is not simply a fourth channel. It is the only one in this system whose content is rendered by an
operating system we do not control, on a lock screen, to whoever is holding the handset, having passed
through Google's servers (and for an iOS device, Apple's). `CHANNEL_CAPABILITIES` marks it
`requiresOptIn`, but **opt-in is consent, not confidentiality**: a patient who opted in to push did not
consent to a diagnosis appearing on a locked screen in a waiting room. With PHI in the system by
design (`pack-erp-healthcare`), a push body is the shortest path from a classified field to a stranger's
eyes.

## Decision

**`FcmPushSender`** against FCM HTTP v1 (`POST /v1/projects/{projectId}/messages:send`), and
**`TwilioVoiceSender`** against the same `2010-04-01` REST API as the SMS sender. Both follow ADR-0301's
shape: `ChannelSender`, injectable `fetch`, zero runtime dependencies, a channel-mismatch refusal before
any network call, and a typed `DeliveryOutcome`.

**The push payload may not vary with the notification's content.** This is the load-bearing decision,
and it is enforced rather than documented:

> Everything sent is either (a) one of the notices the deployment declared **at construction** — a
> static per-deployment catalog, so it cannot hold one recipient's data even in principle — or (b) an
> identifier already present on the `SendRequest`.

`pushPayloadViolations` checks that property against the composed payload on **every** send, and `send`
refuses — without calling FCM — when it does not hold. A composer that reaches for tenant data becomes a
failed delivery with a named error code instead of a disclosure. The real content is fetched afterwards
by the app over the authenticated API, using `dispatch_id` from `data`.

`PUSH_ALLOWED_DATA_KEYS` is the widest permitted set; the default composer sends a strict subset.
`template_id` is *permitted and not sent*, because a template id names the kind of notice —
`lab_result.critical_ready` is a clinical fact about the recipient — so a deployment that adds it is
choosing to disclose that much, visibly, rather than inheriting it.

**Neither sender mints its own credential.** `FcmPushSender` takes an `FcmAccessTokenProvider`. Minting
an FCM v1 token is not one request: it is RS256-signing a JWT assertion with the service account's
private key, POSTing it to `oauth2.googleapis.com`, and caching the result until shortly before
`expires_in` — a second endpoint, a private key at rest, and refresh state with a clock. All three belong
to the app that owns the process (which already runs a JWKS refresh poller), not to a pure provider
client. And on GKE or Cloud Run there is no key file at all, because the correct token source is the
instance metadata server. Injecting the provider keeps every one of those choices outside the module.

**Twilio's voice sender shares the SMS sender's credential handling, error-body parsing and failure
classification** by import, not restatement: a Twilio `20003` means the same thing whichever resource
returned it. Unlike SMS there is no messaging-service equivalent for Calls, so `fromNumber` is required
rather than one of two identities.

**Neither channel gains a bounce-webhook source.** A push has no asynchronous delivery receipt;
`UNREGISTERED` on the send *is* the whole bounce signal, so it is classified inline. Voice has status
callbacks, but a failed call is not a suppression signal in the way a hard bounce is — a busy line is
not an invalid number.

## Alternatives considered

- **Option A:** let a push body carry the notification's rendered title and body, like every other
  channel, and rely on a documented "no PHI in push" rule.
  - **Pros:** the push is useful on its own; no second fetch; one composer for all channels.
  - **Cons:** the rule is a comment. Every future template author has to know it, and the failure is
    silent, irreversible and visible to a third party. Google and Apple both retain the payload.
  - **Why not:** this is the one channel where the mistake cannot be taken back. The property is worth
    more than the convenience, and making it a test rather than a comment is the whole point.

- **Option B:** allow content for non-PHI tenants, gated on classification.
  - **Pros:** a retail tenant gets a useful push; the restriction lands only where it is needed.
  - **Cons:** it makes the safety of the channel depend on a per-tenant resolution being correct at
    compose time, in a package that is deliberately pure and has no classification source. One
    misresolved tenant is a disclosure.
  - **Why not:** a conditional invariant is not an invariant. A deployment that wants richer pushes
    declares richer notices in its static catalog, which is auditable at construction.

- **Option C:** mint the FCM token inside the sender from a service-account key file.
  - **Pros:** one less thing for a deployment to wire; works out of the box.
  - **Cons:** a private key, a second HTTP endpoint, a refresh cache and a clock inside a module whose
    stated contract is "zero dependencies, injected fetch" — and it does not work at all on GKE or
    Cloud Run, where the token comes from the metadata server.
  - **Why not:** it would make the module untestable offline and wrong on the two hosts most likely to
    run it.

- **Option D:** use the legacy FCM `/fcm/send` endpoint with a static server key.
  - **Pros:** a single static credential, no OAuth2 at all.
  - **Cons:** it is dead. Google retired it.
  - **Why not:** not available.

## Consequences

- **Positive:** four of eighteen providers are real, and the two channels with the worst failure modes
  (a lock-screen disclosure, an automated phone call) are the two whose refusals are enforced in code.
  A push cannot leak content even if a future composer tries.
- **Negative:** a push is useless without the app doing an authenticated fetch, so the mobile client has
  work to do before the channel is end-to-end. A deployment must stand up an FCM token provider itself.
  There is still one platform-wide credential set per provider, so every tenant pushes from one Firebase
  project and calls from one number — unchanged from ADR-0301.
- **Neutral:** fourteen providers remain unimplemented. The `ChannelSender` seam means each is additive.
- **Reversibility:** both senders are constructed from the environment and skipped when unconfigured
  (ADR-0301's `construct()` pattern), so removing either is removing a configuration. The push payload
  rule is enforced in one function and one test; relaxing it would be easy and is exactly what the
  enforcement exists to make deliberate.

## Implementation notes

- `packages/notification-providers/src/push-fcm.ts`, `voice-twilio.ts`. Both import
  `CHANNEL_MISMATCH_ERROR_CODE`, `truncateErrorMessage` and the `ChannelSender`/`FetchLike` types from
  `email-ses.ts`, which is where that vocabulary already lived.
- `FCM_API_BASE_URL` and `TWILIO_API_BASE_URL` are overridable, as in ADR-0301, for a VPC endpoint or a
  proxy.
- `twilioCallsPath` percent-encodes the Account SID; TwiML may be supplied inline or as a URL.
- Not yet wired into `buildSenderRegistryFromEnv`: FCM needs a token provider, which is a deployment
  decision rather than an environment variable, and ADR-0301's rule is that a partially-configured
  provider is skipped rather than guessed.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| The senders exist and `buildSenderRegistryFromEnv` does not construct them. FCM needs a token provider the env cannot express; what shape should that configuration take? | amoufaq5 | _unscheduled_ |
| Voice status callbacks are unused. Should a persistently-unreachable number become a suppression, and if so under which reason? | amoufaq5 | _unscheduled_ |
| APNs directly (rather than through FCM) is a fifth provider and a different payload shape. | amoufaq5 | _unscheduled_ |

## References

- ADR-0301 (the sender shape, the environment construction, the skipped-provider rule), ADR-0302
  (bounces → suppressions, and why push has no entry there).
- FCM HTTP v1 API; the legacy `/fcm/send` retirement. Twilio Programmable Voice `Calls` resource.
