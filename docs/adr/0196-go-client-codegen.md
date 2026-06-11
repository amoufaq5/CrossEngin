# ADR-0196: Go client codegen (Phase 3 P3.41)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0193 (TS client codegen), ADR-0195 (Python client codegen), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.38 (TypeScript) + P3.40 (Python) emit clients from operate-server's OpenAPI
document. Go is the natural third SDK target and exercises a statically-typed,
struct-based language with explicit `(value, error)` returns — a different shape
from the TS factory + Python TypedDicts.

## Decision

A **pure, deterministic OpenAPI 3.1 → Go emitter**, behind the existing `--lang`
flag (now `ts|python|go`).

- **`@crossengin/operate-runtime` `openapi-codegen-go.ts`** — `emitOperateGoClient(doc,
  {packageName?})` produces one self-contained `.go` file (Go **1.18+**, stdlib only
  — `net/http` + `encoding/json`): a `struct` per object schema (`schemaToGoType`
  maps the JSON-Schema subset — `$ref`→name, scalars→`string`/`int`/`float64`/`bool`,
  arrays→`[]T`, enums→`string`, `oneOf`→`json.RawMessage`, objects→
  `map[string]interface{}`; required fields are value types, optional ones become
  pointers with `,omitempty` JSON tags), and a `Client` with an exported method per
  operation (`goMethodName` PascalCases the operationId; list envelope → the generic
  `ListResult[T]`; `204` → an `error`-only return; everything else → `(T, error)`).
  Path params interpolate via `url.PathEscape`; `request` is a stdlib `net/http`
  helper returning a typed `*APIError` (carrying the RFC 9457 body as
  `json.RawMessage`) on non-2xx. **Struct fields are column-aligned and `+` carries
  no surrounding spaces, so the output is `gofmt`-clean as emitted.**
- **`apps/operate-server` `openapi-client --lang go`** — `--client-name` sets the
  Go **package** name.
- **Committed reference client** — `apps/operate-server/src/generated/retail_client.go`,
  generated for the retail pack, validated by **`gofmt -l` (clean)** + **`go vet` +
  `go build`** (in a throwaway module) and drift-guarded by `generated.test.ts`.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables, ~7,178 offline tests + 52 gated
  real-Postgres integration tests + five CI gates.** New tests:
  `openapi-codegen-go.test.ts` (the Go type mapper + full file emit — structs with
  pointer/`omitempty` optionals, `(T, error)`/`ListResult`/error-only methods,
  gofmt-clean path expressions, custom package name) + the operate-server
  `generated.test.ts` Go drift/smoke. No new META_ tables.
- Three languages (TS, Python, Go) now emit from one document — the OpenAPI surface
  is a proven language-neutral codegen source. The remaining step is wiring the
  emitters into the `sdk-clients` release/versioning pipeline.
