# @crossengin/config

Shared configuration presets for the CrossEngin monorepo.

## TypeScript

Three presets, each importable from `@crossengin/config/typescript/...`:

- **`base.json`** — strict TypeScript baseline applied to all packages.
- **`library.json`** — extends base; emits `dist/` with declarations + sourcemaps. Use for packages compiled via `tsc`.
- **`nextjs.json`** — extends base; configured for the Next.js app router (`moduleResolution: bundler`, `noEmit`, JSX preserve).

Example consumer `tsconfig.json`:

```json
{
  "extends": "@crossengin/config/typescript/library.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  }
}
```

## ESLint

Flat-config preset at `@crossengin/config/eslint/base`. Consumers create `eslint.config.mjs`:

```js
import base from "@crossengin/config/eslint/base";
export default base;
```

## Prettier

JSON preset at `@crossengin/config/prettier`. Consumers add to their `package.json`:

```json
{
  "prettier": "@crossengin/config/prettier"
}
```

## Status

Skeleton. Rule sets tightened as packages take shape. Tool choices
(TypeScript strict, ESLint flat config, Prettier 3) are per ADR-0024.
