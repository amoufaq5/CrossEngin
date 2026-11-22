# ADR-0463: A design must extend the pack the deployment serves, and every AI provider path is reachable from `.env`

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-22 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0368 (tenant lineage; the prompt half), ADR-0306 (the local provider), ADR-0450 (declared AI prices), ADR-0435 (design review), ADR-0388 (the reviewer's diff) |

## Context

This increment started as documentation: a step-by-step path from an empty Oracle Always Free
account to a public deployment with tenants and a working AI Architect. Its bootstrap, onboarding and AI
paths were walked against a real PG 16 cluster and the real server, booted with the shipped compose
`command:` and connecting as the confined `crossengin_app` role, before a sentence was written (the
Oracle, Cloudflare and `docker compose up` steps were not run, and the guide says so). Doing that found
six defects that would have made the guide false. One of them sits in the engine.

**1. A design that forgot `meta.extends` replaced the tenant's ERP.** ADR-0368 tells the model
*"meta MUST carry extends"*, and nothing enforced it. `designManifest` validated the design on its
own, and a manifest with no `extends` is a valid *standalone* manifest. So it was stored, shown to the
reviewer, approved and activated. Measured live: a provider that returned the prompt's own example
verbatim (which is standalone by construction — the prompt says so beside it) produced an activated
tenant whose `/v1/invoices` answered **404**. The tenant's whole ERP was gone behind a design that
added two entities. The reviewer's approval laundered it, because nothing in the flow treated
"replaces the pack" as different from "adds to it".

**2. Three AI provider paths were unreachable from `.env`.** The compose `environment:` block forwarded
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and nothing else. So the documented OpenAI-compatible route
(Groq, OpenRouter, vLLM) could not be configured on a compose deployment at all. Three variables
were missing from the block: `OPENAI_BASE_URL`, `OPERATE_AI_MODEL`, and the declared price ADR-0450
requires for an uncatalogued model. The price, the per-attempt output budget and the provider
timeout had flags and no environment route, and a compose operator edits `.env`, not `command:`.

**3. The self-hosted overlay could not have served a single design.** `docker-compose.ai.yml` pointed
the local provider at `http://ollama:11434`. That provider appends `/chat/completions`, while Ollama's
OpenAI-compatible route is `/v1/chat/completions`, so every design answered a 404. Three further
problems blocked the overlay:
- Its default model was a 14B one, about 9 GB, which does not fit beside the stack in the 12 GB
  Always Free shape.
- Ollama's default context window truncates a design prompt.
- The default 120 s provider timeout is shorter than a CPU model's first token.

**4. The console's New tenant form could not create a tenant.** Its tier and region options
(`starter`/`pro`, `us-east` and so on) were not the server's vocabulary
(`small|enterprise|regulated|on-prem`, `eu|us|me|ap|sa`), so every submission was a 400.

**5. Saving tenant settings deleted settings the form does not manage.** The form rebuilt the whole
document from its own fields, so any finance key it does not render was dropped on save.

**6. The unpriced-model refusal named only a flag.** It told a compose operator to pass
`--ai-model-price`, which needs an edit to the shipped command the variable now makes unnecessary.

## Decision

**A design on a deployment that serves a pack must extend exactly that pack.** `parentLineageIssues`
runs after the schema parse and before cross-validation, and it raises two kinds of issue:
- `meta.extends` is not exactly `[parent.slug]`. That covers a missing key and also a wrong or extra
  parent, because the gateway admits exactly one.
- A design reuses a parent entity name without `overrides: true`. Resolution refuses that at gateway
  build, which is a 503 for the tenant *after* a 200 for the activation.

Each issue is recorded as the existing `cross_validation_failed` kind and sent back to the model as
the corrective for the next attempt. It is retryable because the model can fix it, and no new enum
member is needed because the fault is the manifest's content. A deployment that serves no pack
(`parentPack: null`) is asked nothing.

**Every AI setting has an environment route, and the flag wins.** `OPERATE_AI_MODEL_PRICE`,
`OPERATE_AI_MAX_OUTPUT_TOKENS` (behind a new `--ai-max-output-tokens`, 1024..32768, default 8192)
and `OPERATE_AI_PROVIDER_TIMEOUT_MS` resolve through one `resolveAiSetting`. It follows
`resolveAiModel`'s precedence (flag, then environment), and the boot line says which source won and
what it ignored. A malformed variable refuses boot by name even when the flag would win, because a
typo that a flag happens to mask is still a typo the next operator inherits. The compose block
forwards all seven variables as `${VAR:-}`.

**The overlay is corrected rather than documented around:**
- `LOCAL_LLM_BASE_URL` gains `/v1`.
- The default model is `qwen2.5:7b-instruct`.
- `OLLAMA_CONTEXT_LENGTH` is 16384 and `mem_limit` is 8g.
- The provider timeout is 15 minutes (an inactivity deadline, so a slow stream is never cut off).

**The console sends the server's vocabulary, and settings saves merge.** The form's options are the
server's, with a comment naming the module that owns them. The save starts from the loaded document,
replaces only the sections the form manages, and keeps every finance key the form does not render.

**The guide is `deploy/GO-LIVE.md`, and onboarding is a script, because self-registration does
not exist.** The guide says so plainly. A public sign-up route needs a rate-limited unauthenticated
surface, email verification and a mail channel, and none of the three is built.
`deploy/onboard-tenant.sh` is the honest substitute: one command on the VM creates a tenant, its
`erp_admin` and a random password. It sends every body to curl on stdin, because one carries the
password and argv is readable by `ps`. It builds every body with `python3` JSON encoding, so a name
containing a quote cannot change the request. It stops **before** setting a password when the server
warns that the role is undeclared, because a login that authorizes nothing is a support call rather
than an onboarding.

## Alternatives considered

**Inject `extends` when the model omits it.** This is free, and it is wrong. It turns a model that
misunderstood the task into a design the reviewer reads as intended, and it does nothing for the
reused-entity half, which would still fail at gateway build. Refusing and retrying costs a paid call
and keeps the model's answer the model's.

**Refuse without retrying.** That treats a correctable omission as a wrong answer. ADR-0330's line is
*"did the model understand the question?"*, and a model that wrote a correct manifest and forgot one
key did understand it.

**A new `DesignFailureKind` for lineage.** It would force a fault mapping and every exhaustive reader
to move, to say what `cross_validation_failed`'s `manifest_content` fault already says.

**Document the variables instead of forwarding them.** That fixes nothing. A compose operator cannot
reach a variable the `environment:` block does not pass, which is how the overlay came to be needed
in the first place (ADR-0364).

## Consequences

- A design that does not extend the pack never reaches a reviewer, so approving a design cannot
  remove a customer's ERP. Measured live in both arms against a stand-in provider:
  - A provider that never complies fails after 3 attempts, with the issue on the job, and no proposal
    is stored.
  - A provider that complies activates. That tenant then answers `/v1/service-visits`,
    `/v1/customers`, `/v1/invoices` and `/v1/accounts` with 200.
- Three provider paths are verified end to end from `.env` alone:
  - Hosted (by the existing tests).
  - OpenAI-compatible: the wire request carried `model`, `max_completion_tokens: 4096` and a `ctp_`
    pseudonym, and never the tenant id.
  - Local: the request reached `/v1/chat/completions` and was labelled `local/qwen2.5:7b-instruct`.
- Boot controls, verified live:
  - An unpriced model refuses boot, naming the variable.
  - A flag beside a set variable wins, and the boot line says the variable was ignored.
  - A malformed variable refuses boot by name.
- A design costs at most one extra paid attempt when a model forgets `extends` and then complies.
- `parentLineageIssues` checks only the parent the deployment serves. A future deployment with
  several permitted parents would need the check widened alongside `TENANT_PARENT_POLICY`.

## Open questions

1. **The reviewer still cannot see `meta.extends`** (ADR-0368's own open end). It is enforced now, so
   this is a visibility gap and not a hazard.
2. **The example manifest in the prompt is standalone.** The prompt says so beside it, and a model
   copying it verbatim is now refused and corrected. An example that already carries the deployment's
   `extends` would save the retry. It is not done here, because the example is also the
   standalone-deployment prompt's example.
3. **`onboard-tenant.sh` creates one person.** A second person in an existing tenant uses the console.
   A `--existing` mode is a small follow-up.
4. **An operator-set password is permanent in intent**: nothing forces a change at first sign-in. This
   is ADR-0364's open question 1, and the guide states it.
