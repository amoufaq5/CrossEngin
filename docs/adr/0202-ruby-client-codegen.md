# ADR-0202: Ruby client codegen (Phase 3 P3.47)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0193/0195/0196/0199 (TS/Python/Go/PHP emitters), ADR-0197 (generation bridge), ADR-0080 (Phase 3 P3 plan) |

## Context

Four languages (TS, Python, Go, PHP) emit clients from operate-server's OpenAPI
document, each stdlib-only + toolchain-validated. Ruby is a natural fifth: it has
stdlib `json` + `net/http` + `uri`, and `ruby -c` syntax-checks — so it fits the
same invariant, and is in the `sdk-clients` `TARGET_LANGUAGES`.

## Decision

A **pure, deterministic OpenAPI 3.1 → Ruby emitter**, wired through the same
`--lang` flag + the generation bridge.

- **`@crossengin/operate-runtime` `openapi-codegen-rb.ts`** — `emitOperateRubyClient(doc,
  {className?})` produces one self-contained `.rb` file (Ruby 3.x, stdlib only —
  `net/http` + `json` + `uri`): a `class` per object schema (`attr_reader` per field
  + an `initialize(h)` that reads string-keyed JSON + a `self.from_h` factory;
  lenient — a missing/redacted field is `nil`) and an `OperateClient` with a
  snake_case method per operation (`rubyMethodName` splits the operationId + camelCase
  tokens; path params interpolate via `URI.encode_www_form_component`; a ref response
  is hydrated through `Klass.from_h`, a list/report/object → the parsed Hash/Array,
  `204` → `nil`). Transport is a stdlib `net/http` `request` raising
  `OperateApiError` (status + parsed RFC 9457 problem) on non-2xx. `oneOf`/alias
  schemas stay plain Hashes (no class).
- **Generation bridge** — `ruby` joins `SUPPORTED_CLIENT_LANGUAGES`; `generateClient`
  / `planClientRelease` / `--persist` work unchanged (a Ruby `GenerationRun` +
  `ClientRelease`).
- **`apps/operate-server openapi-client --lang ruby`** — `--client-name` → the Ruby
  class name.
- **Committed reference client** — `apps/operate-server/src/generated/retail_client.rb`,
  generated for the retail pack, validated by **`ruby -c`** (and it loads +
  instantiates at runtime — 49 client methods, `from_h` hydration works) +
  drift-guarded by `generated.test.ts`.

## Consequences

- **65 packages + 4 apps, 126 meta-schema tables, ~7,224 offline tests + 54 gated
  real-Postgres integration tests + five CI gates.** New tests:
  `openapi-codegen-rb.test.ts` (the emit — class + `attr_reader`/`from_h`,
  hydrated/Hash/nil methods, `URI.encode_www_form_component` paths, custom class name)
  + the operate-server `generated.test.ts` Ruby drift/smoke + the bridge's `ruby`
  coverage. No new META_ tables.
- **Five languages** (TS, Python, Go, PHP, Ruby) now emit from one document, each
  stdlib-only + toolchain-validated + drift-guarded + persistable to the SDK ledger.
  Java/Rust remain deferred pending a dependency policy for their JSON codecs.
