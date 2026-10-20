# @crossengin/operate-web

A hand-built Next.js + Tailwind admin console for the CrossEngin Operate
ERP. White canvas, a single **salient red** brand accent. Renders all 23
enterprise-core entities (CRM, Inventory, Procurement, Finance, People)
as productive list + create + delete screens, talking to `operate-server`.

## Design system

- **White** surfaces (`#ffffff` / soft `#f7f8fa`), neutral ink text.
- **Salient red** (`#E5132B`) reserved for the brand mark, primary
  actions, active navigation, key figures, and destructive actions.
- Tokens live in `tailwind.config.ts` (`brand`, `ink`, `surface`, `line`)
  and component classes in `app/globals.css` (`.btn-primary`, `.card`,
  `.field`, …).

## Architecture

```
app/
  layout.tsx                 sidebar shell
  page.tsx                   dashboard
  [domain]/[entity]/page.tsx one route renders any resource
  api/[...path]/route.ts     server proxy → operate-server (adds x-api-key)
components/                  Sidebar, Topbar, Badge, ResourcePage (list+create)
lib/
  resources.ts              hand-authored per-entity columns + form fields
  nav.ts, api.ts, format.ts
```

Each entity's columns and form fields are hand-authored in
`lib/resources.ts`; the polished chrome (table, form, badges) is shared.
Adding a new screen = one entry in `RESOURCES`.

## Run it

Needs the API running first:

```bash
# Terminal 1 — the API (from repo root, after pnpm -r build)
node apps/operate-server/dist/bin/operate-server.js \
  --pack erp-core --store memory --port 8787 \
  --api-key "devkey:erp_admin:11111111-1111-1111-1111-111111111111"

# Terminal 2 — the web app
cd apps/operate-web
pnpm install          # first time (pulls next/react/tailwind)
pnpm dev              # http://localhost:3000
```

Open <http://localhost:3000>.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `OPERATE_API_URL` | `http://localhost:8787` | operate-server base URL |

`OPERATE_API_KEY` **is gone** and this table documented it as live for one release too long
(ADR-0358 removed it, ADR-0377 removed the row). It is read nowhere in this app — the proxy forwards
**the viewer's own session token** from an `httpOnly` cookie and answers a cookie-less `/api/*`
request with a JSON 401 without calling upstream. The variable is deleted rather than left unset
because its old `?? "devkey"` default meant removing it did not fail closed: every browser that
could resolve the domain was one shared `platform_admin`. Setting it now does nothing at all, which
is worse than an error — so if you have it in a `.env`, delete the line.

The browser only talks to this app's `/api` proxy, so there are no CORS
issues and the API key stays server-side. Use a `cashier`/limited role on
the API key to see classification redaction (e.g. `Item.standard_cost`)
drop out of the tables automatically.
