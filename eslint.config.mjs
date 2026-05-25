// Root ESLint flat config — lints the whole workspace in one pass via the
// shared baseline in @crossengin/config. Imported by relative path so the root
// needs no dependency on the workspace package.
export { default } from "./packages/config/eslint/base.mjs";
