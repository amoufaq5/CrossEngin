export class UnknownRoleError extends Error {
  override readonly name = "UnknownRoleError";
  readonly roleName: string;
  constructor(roleName: string) {
    super(`unknown role '${roleName}'`);
    this.roleName = roleName;
  }
}

export class RoleInheritanceCycleError extends Error {
  override readonly name = "RoleInheritanceCycleError";
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`role inheritance cycle: ${cycle.join(" -> ")}`);
    this.cycle = cycle;
  }
}
