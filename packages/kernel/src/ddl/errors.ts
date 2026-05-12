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

export class EntityRenameNotSupportedError extends Error {
  override readonly name = "EntityRenameNotSupportedError";
  readonly oldName: string;
  readonly newName: string;
  constructor(oldName: string, newName: string) {
    super(
      `entity rename '${oldName}' -> '${newName}' not supported by the v1 diff engine; use a manifest 'rename_from:' directive (Phase 2)`,
    );
    this.oldName = oldName;
    this.newName = newName;
  }
}

export class UnsupportedDiffChangeError extends Error {
  override readonly name = "UnsupportedDiffChangeError";
  readonly entityName: string;
  readonly fieldName: string;
  readonly reason: string;
  constructor(entityName: string, fieldName: string, reason: string) {
    super(`unsupported diff on entity '${entityName}', field '${fieldName}': ${reason}`);
    this.entityName = entityName;
    this.fieldName = fieldName;
    this.reason = reason;
  }
}
