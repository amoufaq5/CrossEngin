export class WorkflowValidationError extends Error {
  override readonly name = "WorkflowValidationError";
  readonly path: string;
  constructor(path: string, message: string) {
    super(`workflow validation failed at '${path}': ${message}`);
    this.path = path;
  }
}
