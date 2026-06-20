# operate-web (minimal UI)

A tiny, zero-dependency web UI for the CrossEngin `operate-server` API.
Plain HTML + vanilla JS + a small Node proxy. No build step, no npm install.

## Run

**Terminal 1 — the API server** (from the repo root, after `pnpm -r build`):

```bash
node apps/operate-server/dist/bin/operate-server.js \
  --pack erp-retail \
  --store memory \
  --port 8787 \
  --api-key "devkey:store_manager:11111111-1111-1111-1111-111111111111"
```

**Terminal 2 — the UI:**

```bash
node web-ui/server.mjs
```

Then open <http://localhost:5173>.

## What it does

- Lists products from `GET /v1/products`
- Creates products via `POST /v1/products` (form + "Add sample data" button)
- Deletes via `DELETE /v1/products/{id}`
- Shows the **classification redaction** live: `unit_cost` is
  `commercial_sensitive`, so it appears as "🔒 redacted" when the server
  runs with the `cashier` role and as a value with `store_manager`.

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `5173` | port the UI listens on |
| `TARGET` | `http://localhost:8787` | the operate-server API to proxy to |
| `API_KEY` | `devkey` | token sent as `x-api-key` to the API |

Example — try the cashier view (cost redacted):

```bash
# Terminal 1: start the API with the cashier role
node apps/operate-server/dist/bin/operate-server.js --pack erp-retail --store memory --port 8787 \
  --api-key "cashierkey:cashier:11111111-1111-1111-1111-111111111111"

# Terminal 2: point the UI at that key
API_KEY=cashierkey node web-ui/server.mjs
```

The browser only ever talks to this proxy, so there are no CORS issues and the
API key stays on your machine.
