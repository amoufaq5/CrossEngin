# ADR-0155: operate-web React component renderer (SSR-only) (Phase 3 P3.3)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0080 (operate-web renderer), ADR-0154 (operate-web edge + JWT), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per ADR-0077).
> 0080 anchors the P3 renderer arc (operate-web); this is its third increment
> (P3.3), taking the next free ADR number.

## Context

P3.1 (ADR-0080) shipped `@crossengin/operate-web` — a framework-neutral,
redaction-aware view-model compiler producing plain serializable
`WebAppModel` / `TableModel` / `DetailModel` / `FormModel` (no React, no DOM).
P3.2 (ADR-0154) brought `apps/operate-web` to operate-server serving parity
(edge adapter + JWT/JWKS). Both shipped JSON only; the product still had no real
UI runtime.

The product decision for P3.3 is a **React component renderer** over those
models. The hard constraint is that the repo's offline test suite + CI must stay
**hermetic**: no browser, no jsdom, no bundler/dev-server on the test path. The
chosen mechanism is therefore **server-side rendering only** — components render
to HTML strings via `react-dom/server`'s `renderToStaticMarkup` (pure, runs in a
plain Node environment), and `apps/operate-web` server-renders them to real
`text/html` pages. Client-side hydration + a bundler are an explicit deferred
follow-up (below).

This is the first package in the workspace with a runtime UI-framework dependency
(`react` + `react-dom`).

## Decision

### Part A — `packages/operate-web-react` (the 64th package; first React dep)

- **Deps:** `react` + `react-dom` pinned `^18.3.1` (React 18 is the stablest pair
  with esbuild's automatic JSX transform under the workspace's vitest 2 /
  TypeScript 5 toolchain; React 19 resolves but 18 keeps the SSR surface and the
  type story simplest). Dev deps add `@types/react` + `@types/react-dom`
  `^18.3.1`. Depends on `@crossengin/operate-web` for the model **types** only.
- **JSX wiring kept local.** `tsconfig.json` adds `"jsx": "react-jsx"` +
  `"jsxImportSource": "react"` (so `.tsx` compiles under the shared base config
  without touching it); `vitest.config.ts` `mergeConfig`s the shared preset with
  `esbuild: { jsx: "automatic", jsxImportSource: "react" }` so vitest transforms
  `.tsx` test files with no bundler. The shared base tsconfig is **unchanged** —
  no other package sees JSX.
- **Components** (`components.tsx`) — presentational, typed entirely by the
  operate-web model types, pure (no data fetching, no client state, no effects):
  - `AppShell({ app, basePath?, children? })` — chrome + a nav link per entity.
  - `TableView({ model, rows, basePath? })` — a semantic `<table>`: `<thead>` from
    the model's columns, `<tbody>` pulling only those columns from each record.
    Because the compiler already dropped redacted columns from the model, a
    redacted column is structurally absent from both header and cells.
  - `DetailView({ model, record? })` — one `<section>`/`<dl>` per detail section.
  - `FormView({ model, action? })` — a `<form>` with one labelled control per
    field; `readOnly` → `disabled`, `required` marked, `enum`/`long_text`/`boolean`
    pick the right control.
  - `displayValue(unknown)` — the shared cell/`<dd>` stringifier.
- **`renderPage(node, { title?, lang? })`** (`render.tsx`) wraps
  `renderToStaticMarkup` in a complete, self-contained document: `<!doctype html>`
  + `<title>` + a tiny inline stylesheet + the markup. No client bundle, no
  external asset. `index.ts` re-exports the components + `renderPage`.

### Part B — SSR HTML routes in `apps/operate-web`

- A new `html.ts` (`renderAppPage` / `renderTablePage` / `renderDetailPage` /
  `renderFormPage` + `htmlResponse`) calls the React components as functions and
  feeds them to `renderPage`, returning `text/html` `RawWebResponse`s.
- `OperateWebServer.dispatch` is split into `dispatchUi` (the existing `/ui/...`
  JSON routes, **unchanged**) + a new `dispatchApp` (`/app`, `/app/:entity`,
  `/app/:entity/:id`, `/app/:entity/new` → HTML). The HTML serve methods reuse the
  **exact same** per-caller compile + `redactRecord` + store reads as their JSON
  siblings — no auth, redaction, pagination, or store logic is duplicated. The app
  gains a dep on `@crossengin/operate-web-react`.

## Cross-cutting invariants enforced (by tests)

- **Hermetic SSR.** Every component test renders via `react-dom/server`
  (`renderToStaticMarkup`) in the Node environment and asserts on the HTML string;
  there is no jsdom, no DOM, no bundler. `renderPage` produces a `<!doctype html>`
  document.
- **Redaction is structural in the markup.** A `TableModel` without a `unit_cost`
  column renders no `unit_cost` header or cell even when a stray value rides on the
  row record. End-to-end over the real retail-pack compiler: a `store_manager`'s
  rendered `DetailView` contains the classified `unit_cost`; a `cashier`'s does
  not — the compiler dropped the field, so the component never describes it.
- **Same guarantees over real HTTP.** A loopback test boots `serve()`, GETs
  `/app/Product/p1` as a manager (200 `text/html` containing `Unit cost`/`4.2`) and
  as a cashier (200 whose HTML omits both), and 401s an unauthenticated `/app`
  request — reusing the existing api-key wiring and the same `dispatch` core.

## Alternatives considered

- **Client-side React (hydration + a bundler/Vite).**
  - **Decision.** Deferred. A bundler on the CI test path is exactly the hermetic-
    ness the constraint forbids. SSR-only `renderToStaticMarkup` ships real HTML
    with zero client JS and tests in a plain Node process. Client hydration + a
    bundler/dev-server are the explicit follow-up.
- **React 19.**
  - **Decision.** No — 18 is the safest pairing with the current vitest 2 / esbuild
    JSX transform and `@types/react`; the SSR API (`renderToStaticMarkup`) is
    identical. A bump is a later, mechanical change.
- **A non-React HTML templater (string templates).**
  - **Decision.** No — the product decision is React components, and React gives
    safe escaping + composability for free; SSR keeps it hermetic.
- **Put the components in `@crossengin/views` or operate-web itself.**
  - **Decision.** No — operate-web is deliberately React-free (plain serializable
    models). A separate package quarantines the first UI-framework dep so the
    compiler stays renderer-neutral.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables** (no new META_ tables — pure
  rendering). **+18 offline tests** (13 in the new `operate-web-react`; +5 in
  `apps/operate-web`, 73 → 78).
- **operate-web now ships real HTML pages**, not just JSON: `/app/...` server-
  renders the same redaction-aware models the `/ui/...` routes expose, under the
  same per-caller auth + redaction.
- **First UI-framework dependency** lands quarantined in one package, with its JSX
  toolchain config kept local so no other package's build/test is affected.
- **Deferred:** client-side hydration, a bundler/dev-server, interactive form
  submission (the rendered `<form>` posts to `/app/:entity` but mutation routing is
  not yet wired), and richer view kinds (kanban / calendar / dashboard).
