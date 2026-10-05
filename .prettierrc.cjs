// The workspace's Prettier settings, at the root where every tool looks for them (ADR-0329).
//
// `packages/config/prettier/index.json` has held them since Phase 1 and nothing pointed at it from
// here, so a bare `npx prettier --write` found no configuration and reformatted at Prettier's own
// default width of 80 against a codebase written at 100. An agent hit exactly that and had to
// revert the reflow by hand; this makes the ad-hoc invocation agree with the house style.
//
// A `require` of the JSON rather than a copy of the six settings: two files that must agree is the
// shape this repo keeps finding defects in.
//
// What this does **not** mean: the repo is not Prettier-clean. Measured at 882 of the
// `packages/*/src` files differing, because the config was never applied to anything — so
// `prettier --check` is red with or without this file, and there is deliberately no `format:check`
// script, since a check that is red on day one is one nobody looks at. Reformatting the workspace is
// a separate decision with a diff that would bury every real change in it.
module.exports = require("./packages/config/prettier/index.json");
