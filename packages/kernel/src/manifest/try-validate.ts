import { ManifestValidationError } from "./errors.js";
import type { ValidationResult } from "./patch.js";
import type { Manifest } from "./types.js";
import { validateManifest } from "./validate.js";

export function tryValidateManifest(manifest: Manifest): ValidationResult {
  try {
    validateManifest(manifest);
    return { ok: true };
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      return {
        ok: false,
        errors: [{ path: err.path, message: err.message }],
      };
    }
    throw err;
  }
}
