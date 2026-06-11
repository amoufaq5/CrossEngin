# ADR-0199: PHP client codegen (Phase 3 P3.44)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0193/0195/0196 (TS/Python/Go emitters), ADR-0197 (generation bridge), ADR-0080 (Phase 3 P3 plan) |

## Context

TS/Python/Go emitters (P3.38/0.40/0.41) share a property: a **stdlib JSON codec +
an available validation toolchain** (tsc / py_compile / go build). A fourth language
was wanted. Java + Rust were considered but rejected: neither has stdlib JSON
(Jackson / serde are third-party), breaking the "stdlib-only, toolchain-validated"
invariant the other emitters hold. **PHP 8** has stdlib `json_encode`/`json_decode`
+ `curl`, and `php -l` lints syntax — so it fits the pattern and is in the
`sdk-clients` `TARGET_LANGUAGES`.

## Decision

A **pure, deterministic OpenAPI 3.1 → PHP emitter**, wired through the same `--lang`
flag + the generation bridge.

- **`@crossengin/operate-runtime` `openapi-codegen-php.ts`** — `emitOperatePhpClient(doc,
  {className?})` produces one self-contained `.php` file (PHP **8.1+**, stdlib only —
  `curl` + `json`): a `final class` per object schema (typed `readonly` promoted
  constructor properties, all nullable so redaction never breaks hydration, + a
  `fromArray` factory) and an `OperateClient` with a method per operation
  (`phpMethodName` camelCases the operationId; path params via `rawurlencode`; a ref
  response is hydrated through `Class::fromArray`, a list/report/object → the decoded
  `array`, `204` → `void`). Transport is a stdlib `curl` `request` throwing a typed
  `OperateApiError` (status + decoded RFC 9457 problem) on non-2xx. `schemaToPhpType`
  maps the JSON-Schema subset (scalars → `string`/`int`/`float`/`bool`, ref → class,
  enum → `string`, array/object/oneOf → `array`).
- **Generation bridge** — `php` joins `SUPPORTED_CLIENT_LANGUAGES`; `generateClient`
  / `planClientRelease` work unchanged (a PHP `GenerationRun` + `ClientRelease`).
- **`apps/operate-server openapi-client --lang php`** — `--client-name` → the PHP
  class name.
- **Committed reference client** — `apps/operate-server/src/generated/retail_client.php`,
  generated for the retail pack, validated by **`php -l`** (and it loads +
  instantiates at runtime — 49 methods) + drift-guarded by `generated.test.ts`.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,205 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests:
  `openapi-codegen-php.test.ts` (the PHP type mapper + full file emit — nullable
  typed props + `fromArray`, hydrated/array/void methods, `rawurlencode` paths,
  custom class name) + the operate-server `generated.test.ts` PHP drift/smoke + the
  bridge's `php` coverage. No new META_ tables.
- **Four languages** (TS, Python, Go, PHP) now emit from one document, each
  stdlib-only + toolchain-validated + drift-guarded. Java/Rust remain deferred
  pending a dependency policy for their JSON codecs.
