export class UnknownTraitError extends Error {
  override readonly name = "UnknownTraitError";
  readonly traitName: string;
  constructor(traitName: string) {
    super(
      `unknown trait: ${traitName} (not in built-in registry; pass via context.customTraits for custom traits)`,
    );
    this.traitName = traitName;
  }
}

export class FieldNameCollisionError extends Error {
  override readonly name = "FieldNameCollisionError";
  readonly fieldName: string;
  readonly entityName: string;
  constructor(entityName: string, fieldName: string, reason: string) {
    super(`entity '${entityName}': field name '${fieldName}' collides — ${reason}`);
    this.entityName = entityName;
    this.fieldName = fieldName;
  }
}

export class ReservedFieldNameError extends Error {
  override readonly name = "ReservedFieldNameError";
  readonly fieldName: string;
  readonly entityName: string;
  constructor(entityName: string, fieldName: string) {
    super(
      `entity '${entityName}' declares field '${fieldName}', which is reserved by the kernel (implicit primary key or trait field)`,
    );
    this.entityName = entityName;
    this.fieldName = fieldName;
  }
}
