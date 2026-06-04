// Emits the full meta-schema bootstrap DDL (all META_TABLES) to stdout, as a
// single semicolon-separated SQL script. Used by scripts/setup-integration-db.sh
// (CI + local) to provision a throwaway database for the gated real-Postgres
// integration tests. Requires the kernel to be built first (`pnpm -r build`).
import { emitMetaBootstrapSql } from "../packages/kernel/dist/bootstrap/index.js";

process.stdout.write(emitMetaBootstrapSql().join(";\n") + ";\n");
