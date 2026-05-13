export * from "./types.js";
export * from "./emit.js";
export * from "./meta-schema.js";

import { emitBootstrapSql } from "./emit.js";
import { META_SCHEMA_NAME, META_TABLES } from "./meta-schema.js";

export function emitMetaBootstrapSql(): string[] {
  return emitBootstrapSql(META_SCHEMA_NAME, META_TABLES);
}
