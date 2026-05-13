export class ManifestValidationError extends Error {
  override readonly name = "ManifestValidationError";
  readonly path: string;
  constructor(path: string, message: string) {
    super(`manifest validation failed at '${path}': ${message}`);
    this.path = path;
  }
}

export class CycleDetectedError extends Error {
  override readonly name = "CycleDetectedError";
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`circular foreign-key dependency: ${cycle.join(" -> ")}`);
    this.cycle = cycle;
  }
}

export class ExtendsCycleError extends Error {
  override readonly name = "ExtendsCycleError";
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`manifest 'extends' cycle: ${cycle.join(" -> ")}`);
    this.cycle = cycle;
  }
}

export class UnknownParentManifestError extends Error {
  override readonly name = "UnknownParentManifestError";
  readonly parentId: string;
  readonly childSlug: string;
  constructor(parentId: string, childSlug: string) {
    super(`manifest '${childSlug}' extends unknown parent '${parentId}'`);
    this.parentId = parentId;
    this.childSlug = childSlug;
  }
}
