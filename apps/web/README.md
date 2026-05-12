# @crossengin/web

The CrossEngin SaaS frontend. Next.js 15 (app router), PWA-enabled,
multi-tenant.

## Status

Skeleton: empty Next.js shell. UI shell + auth + tenant context land
in Phase 2. The generic renderers (List, Record, Kanban, Calendar,
Map, Dashboard, Form per ADR-0018) land alongside the manifest
engine in Phase 3.

## Development

```bash
pnpm install
pnpm --filter @crossengin/web dev
```

Visit `http://localhost:3000`.

## Configuration

See `.env.example` for required environment variables.
