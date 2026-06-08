# ADR-0156: operate-web client-side hydration + bundler (Phase 3 P3.4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0080 (operate-web renderer), ADR-0155 (operate-web-react SSR renderer), ADR-0154 (operate-web edge + JWT), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per ADR-0077).
> 0080 anchors the P3 renderer arc (operate-web); this is its fourth increment
> (P3.4), taking the next free ADR number.

## Context

P3.3 (ADR-0155) shipped `@crossengin/operate-web-react` — SSR-only React 18
components rendered to `text/html` via `react-dom/server`, and additive `/app/*`
routes on `apps/operate-web`. The pages are server-complete HTML but **inert**:
no client JS, so a deferred follow-up.

P3.4 makes the SSR pages **interactive** by shipping a client bundle that
`hydrateRoot`s the *same* React components against the server markup, then handles
in-page interactions (table sort + pagination) **without full reloads**, reusing
the existing read-only `/ui/...` JSON endpoints (operate-web has no write routes).

The hard constraint is unchanged from P3.3: the offline test suite + CI must stay
**hermetic** — no bundler, no browser/jsdom on the `pnpm -r build` / `typecheck` /
`vitest` path. The chosen mechanism keeps the bundler (esbuild) in a separate
`build:client` npm script, never imported by tsc or vitest. The pure, DOM-free
pieces (state serialization, fetch-URL builders) are unit-tested; live
`hydrateRoot` DOM behavior is verified by a manual browser smoke (below), not
vitest.

## Decision

### Part A — client entry + hydration (`packages/operate-web-react`)

- **`page-state.ts` (pure, DOM-free, unit-tested).** A `WebPageState`
  discriminated union (`app` | `table` | `detail` | `form`) carries the
  **already-redacted** models + data the SSR rendered plus the `basePath`.
  - `serializePageState(state)` — `JSON.stringify` then escape `<` → `<`,
    `>` → `>`, U+2028 → ` `, U+2029 → ` `. The result is still
    valid JSON (so `parsePageState` round-trips) but can **never** form a
    `</script>` (or `<!--`) to break out of the inline state `<script>`, nor a raw
    line terminator that would break the JS. (The escape table's U+2028/U+2029
    keys are built with `String.fromCharCode` so no literal control char appears
    in source.)
  - `parsePageState(raw)` — the inverse.
  - `buildListQueryUrl(entity, { cursor?, sort?, order? })` — builds the
    `/ui/:entity?cursor=…&sort=…&order=…` URL the hydrated table refetches.
- **`page.tsx`.** `PageRoot({ state })` — the **single** component the SSR renders
  AND the client hydrates; it switches on `state.kind` and renders the matching
  tree inside `AppShell`. The table branch wraps the P3.3 `TableView` in a
  stateful `TableSection` that adds sort-toggle buttons (per sortable column) +
  Prev/Next pagination; interactions `fetch` the `/ui/:entity` JSON and swap rows
  + cursor in `useState` (forward keyset cursor + a visited-cursor stack for
  Prev). Detail/form/app branches are static; row links remain normal navigations
  to the SSR `/app/:entity/:id` detail page. Rendering one component on both sides
  guarantees the markup matches so `hydrateRoot` attaches cleanly. A `fetcher`
  seam keeps `TableSection` testable without a network.
- **`render.tsx` gains `renderHydratablePage(state, opts?)`.** It `renderToString`s
  `PageRoot` (hydration markers, vs `renderToStaticMarkup`) into
  `<div id="root">…</div>`, embeds `<script>window.__OPERATE_WEB_STATE__ =
  {serializePageState(state)};</script>`, and appends
  `<script src="/assets/operate-web-client.js" defer></script>`. The original
  `renderPage` (static) is unchanged.
- **`client.tsx` (the browser entry — NEVER on the Node/vitest path).** Imports
  `react-dom/client`, reads the embedded global, and `hydrateRoot`s `PageRoot`
  into `#root`. It is **not** re-exported from `index.ts`; the bundler points at it
  via a new `./client` package export. `tsconfig` adds `"DOM"` to `lib` so
  `document`/`hydrateRoot` typecheck.

### Part B — bundling + serving (`apps/operate-web`)

- **`esbuild` devDependency + a `build:client` script** (`node
  scripts/build-client.mjs`) bundles `@crossengin/operate-web-react/client`
  (resolving react + react-dom + the components) to
  `apps/operate-web/dist/assets/operate-web-client.js` — `platform: browser`,
  `format: iife`, `minify`, `target es2020`, automatic JSX, `process.env.NODE_ENV
  = "production"`. `build` stays plain `tsc`; `build:client` is separate and never
  a `pnpm -r build` dependency.
- **`assets.ts`** — `serveClientBundle(loader?)` serves the on-disk bundle as
  `application/javascript` (200), else a helpful **503** pointing at `build:client`
  (the SSR pages still render; they just won't hydrate until the bundle exists).
  The loader is injectable for hermetic tests.
- **`OperateWebServer.dispatch`** serves `GET /assets/operate-web-client.js`
  **before auth** — the bundle is a public static asset carrying no per-caller
  data (every model + row is redacted *before* it's embedded in the page). Because
  the route lives in `dispatch`, both the Node listener and the edge fetch handler
  serve it for free. `bundleLoader` is an injectable `OperateWebServer` /
  `buildOperateWebServer` option.
- **`html.ts`** now builds a `WebPageState` and calls `renderHydratablePage`, so
  `/app/*` emit the `#root` + embedded-state `<script>` + client `<script src>`.
  The embedded state is the **exact** redacted models + data the SSR rendered, so
  the client never receives a hidden field either.

## Cross-cutting invariants enforced (by tests)

- **XSS-safe embedded state.** `serializePageState` neutralizes `</script>` /
  `<!--` / U+2028 / U+2029; an over-HTTP test seeds a record whose `sku` is
  `</script><script>alert(1)</script>` and asserts the page contains exactly **two**
  real `</script>` tags (the state + client scripts) and the data's tag chars
  appear only `\u`-escaped.
- **Redaction baked into the client state.** The cashier's `/app/Product/p1` HTML
  carries neither the `"unit_cost"` key nor its value in the embedded blob; the
  manager's carries both — the same redaction the visible markup shows.
- **Hermetic.** All vitest tests render via `react-dom/server` or call pure helpers
  / the injectable bundle loader; **no test imports esbuild or jsdom**, and `pnpm
  -r build` / `typecheck` never run the bundler. `serveClientBundle` is unit-tested
  with stub loaders (present → 200 JS, missing → 503 with a `build:client` notice).
- **Bundle actually builds.** `pnpm --filter @crossengin/operate-web-app
  build:client` produces a ~146 KiB minified IIFE (react + react-dom + components +
  client entry).

## Manual browser smoke (not vitest)

1. `pnpm -r build && pnpm --filter @crossengin/operate-web-app build:client`
2. Run the `operate-web` bin (`--pack erp-retail --api-key dev:store_manager:t1`),
   seed a few Product rows, open `http://localhost:PORT/app/Product?` with
   `x-api-key` (e.g. via a browser extension or a same-origin dev proxy).
3. Confirm the table renders server-side (view-source shows full markup +
   `#root` + `window.__OPERATE_WEB_STATE__`), then that Sort/Next/Prev mutate the
   rows **without a full navigation** (Network shows `/ui/Product?...` XHRs), and
   that a row link still navigates to the SSR detail page.

## Alternatives considered

- **A full bundler/dev-server (Vite) integrated into `build`/`test`.**
  - **Decision.** No — that is exactly the hermetic-ness the constraint forbids.
    esbuild in an isolated `build:client` script keeps tsc/vitest bundler-free.
- **Embed the bundle as a string constant (edge runtimes have no fs).**
  - **Decision.** Deferred. The Node path reads `dist/assets/...`; the edge handler
    serves the same route via the injectable `bundleLoader` (an edge deployment can
    pass a loader returning an embedded/KV-fetched bundle). Shipping a generated
    string module is a later mechanical step.
- **Client-side routing (SPA navigation between `/app/*`).**
  - **Decision.** Deferred — row navigation uses normal links to the SSR detail
    pages (a read-only surface needs no SPA router). Pagination/sort are the
    in-page interactions that matter.
- **`renderToStaticMarkup` for the hydratable pages.**
  - **Decision.** No — `hydrateRoot` needs the markers `renderToString` emits;
    static markup would mismatch. `renderPage` (static) is kept for any future
    no-JS surface.

## Consequences

- **64 packages + 4 apps, 125 meta-schema tables** (no new META_ tables — pure
  rendering + a static asset). **+22 offline tests** (+15 in `operate-web-react`:
  `page-state` 11, `render-hydratable` 4; +7 in `apps/operate-web`: `assets` 3,
  `html` +4).
- **The `/app/*` pages are now interactive** — sort + pagination hydrate over the
  existing `/ui/...` JSON, no full reload — while staying server-complete HTML.
- **The bundler is off the hermetic test path**: esbuild lives only in
  `build:client`; vitest/tsc never touch it.
- **Deferred:** form submission / mutations (operate-web has no write endpoints),
  full client-side routing (SPA), an edge-embedded bundle, and richer view kinds
  (kanban / calendar / dashboard).
