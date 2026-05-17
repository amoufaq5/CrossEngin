# @crossengin/testing

Shared test utilities for the CrossEngin monorepo.

## Vitest preset

Consumers extend the shared Vitest config:

```ts
// vitest.config.ts
import { vitestPreset } from "@crossengin/testing/vitest";
export default vitestPreset;
```

Override fields in a consumer config by merging:

```ts
import { mergeConfig } from "vitest/config";
import { vitestPreset } from "@crossengin/testing/vitest";

export default mergeConfig(vitestPreset, {
  test: { setupFiles: ["./test-setup.ts"] },
});
```

## Future

Factory helpers (`makeTenant()`, `makeUser()`), MSW setup utilities,
and DB harness wrappers land here as the kernel + manifest engine
require them.
