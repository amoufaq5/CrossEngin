export { vitestPreset } from "./vitest-preset.js";
export * from "./strategy/index.js";
// Not under `strategy/`: those rules read the workspace from disk and answer one question per run,
// while this is a per-statement predicate a fake calls on the statement in front of it.
export {
  assertBindArity,
  bindArityMismatch,
  referencedParamPositions,
  type BindArityMismatch,
} from "./pg-bind-arity.js";
