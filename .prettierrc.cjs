// Root Prettier config re-exports the shared base by relative path — single
// source of truth in @crossengin/config/prettier, no workspace dep at the root
// (mirrors how eslint.config.mjs re-exports the shared ESLint base; ADR-0250).
module.exports = require("./packages/config/prettier/index.json");
