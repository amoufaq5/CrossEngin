# @crossengin/types

Shared TypeScript types for the CrossEngin monorepo. Two surfaces.

## `@crossengin/types`

Branded ID types used across the kernel runtime.

```ts
import type { TenantId, UserId, RequestId, ManifestId } from "@crossengin/types";
```

## `@crossengin/types/meta-schema`

The kernel's meta-schema per **ADR-0003** — the formal description
of what an entity is, what fields it has, what relations it
participates in, and how the kernel translates that description into
Postgres objects.

```ts
import {
  EntitySchema,
  FieldSchema,
  RelationSchema,
  TraitSchema,
  FieldTypeSchema,
  IndexDefinitionSchema,
  BUILTIN_TRAITS,
} from "@crossengin/types/meta-schema";

import type {
  Entity,
  Field,
  Relation,
  Trait,
  FieldType,
  IndexDefinition,
  BuiltinTraitName,
} from "@crossengin/types/meta-schema";
```

### Field types (23)

- **Primitives:** `text`, `long_text`, `integer`, `decimal`,
  `boolean`, `date`, `time`, `datetime`, `duration`, `uuid`.
- **Structured:** `enum`, `reference`, `array`, `json`, `file`.
- **Domain:** `email`, `phone`, `url`, `currency_amount`,
  `geo_point`, `geo_polygon`, `country_code`, `language_code`,
  `timezone`.

`array.element` is constrained to a primitive (non-array) field in
v1 — `array(array(x))` is rejected.

### Validation

All schemas validate at runtime via zod 3. Refines enforce:

- `integer.min <= max`
- `decimal.scale <= precision`, `decimal.min <= max`
- `enum.values` non-empty + unique
- `field.name` is snake_case
- `entity.name` is PascalCase
- `entity.fields` has unique names
- `entity.indexes` reference declared fields

### Built-in traits

```ts
const BUILTIN_TRAITS = [
  "auditable",
  "soft_deletable",
  "versioned",
  "tenant_owned",
  "gxp_signed",
  "part_11_compliant",
] as const;
```

Concrete field composition for each is materialized by the kernel
(Phase 2 work).

## Deferred to Phase 2

- Manifest top-level type (ADR-0004 → future package).
- DDL emission from these schemas.
- Default-value expression DSL beyond `literal` + `expression` opaque strings.
- Validation rule discriminated union beyond `regex` + `custom`.
- Schema-evolution directives (`rename_from`, `confirm_destructive`, `data_migration`).
- Trait composition + override semantics (compliance packs override kernel traits).

## Run tests

```bash
pnpm --filter @crossengin/types test
```
