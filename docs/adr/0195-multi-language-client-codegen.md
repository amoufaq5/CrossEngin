# ADR-0195: Multi-language client codegen — Python (Phase 3 P3.40)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0193 (OpenAPI TS client codegen), ADR-0194 (operate-web client codegen), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.38 emitted a TypeScript client from operate-server's OpenAPI document. The
`sdk-clients` package models a 10-language matrix; the next concrete step is a
**second language** from the *same* document, proving the emitter approach
generalizes. Python is the highest-value second SDK target.

## Decision

A **pure, deterministic OpenAPI 3.1 → Python emitter**, behind a `--lang` flag.

- **`@crossengin/operate-runtime` `openapi-codegen-py.ts`** — `emitOperatePythonClient(doc,
  {className?})` produces one self-contained `.py` module (Python **3.11+**, stdlib
  only — `urllib` + `json`, no `requests`/`pydantic`): a `TypedDict` per object
  schema (`schemaToPyType` maps the JSON-Schema subset — `$ref`→name, scalars→`str`/
  `int`/`float`/`bool`, arrays→`list[T]`, enums→`Literal[...]`, nullable→`T | None`,
  `oneOf`/objects→`dict[str, Any]`; required fields plain, optional wrapped in
  `NotRequired[...]`), and an `OperateClient` class with a `snake_case` method per
  operation (`pythonMethodName` splits the operationId + camelCase tokens; path
  params → typed args via `urllib.parse.quote`; the list envelope → `ListResult`;
  `204` → `None`). Transport is a stdlib `urllib.request` `_request` raising
  `OperateApiError` on non-2xx.
- **`apps/operate-server` `openapi-client --lang ts|python`** (default `ts`)
  selects the emitter; `--client-name` sets the factory (TS) or class (Python) name.
- **Committed reference client** — `apps/operate-server/src/generated/retail_client.py`,
  generated for the retail pack, **syntax-validated with `python3 -m py_compile`**
  (it imports + instantiates cleanly — 51 methods) and drift-guarded by
  `generated.test.ts` (regenerate + assert equality, like the TS client).

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,164 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests:
  `openapi-codegen-py.test.ts` (the Python type mapper + full module emit — TypedDict
  required/`NotRequired`/`Literal`, snake_case methods, path-param quoting, custom
  class name) + the operate-server `generated.test.ts` Python drift/smoke. The
  emitter shares nothing language-specific with the TS one beyond the `OpenApiDocument`
  input — so a Go/Java/… emitter follows the same template. No new META_ tables.
- The TS emitter (P3.38) + this Python emitter prove the document is a genuine
  language-neutral codegen source. Wiring these into the `sdk-clients` release
  pipeline + adding Go is the natural continuation.
