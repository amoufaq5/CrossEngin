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
