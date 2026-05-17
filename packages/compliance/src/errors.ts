export class UnknownPackError extends Error {
  override readonly name = "UnknownPackError";
  readonly packId: string;
  constructor(packId: string) {
    super(`compliance pack '${packId}' not found in registry`);
    this.packId = packId;
  }
}

export class CollisionError extends Error {
  override readonly name = "CollisionError";
  readonly packId: string;
  readonly kind: string;
  readonly itemName: string;
  constructor(packId: string, kind: string, itemName: string) {
    super(
      `compliance pack '${packId}' contributes ${kind} '${itemName}' which already exists in the tenant manifest or another pack`,
    );
    this.packId = packId;
    this.kind = kind;
    this.itemName = itemName;
  }
}

export class PackParameterError extends Error {
  override readonly name = "PackParameterError";
  readonly packId: string;
  readonly parameterName: string;
  constructor(packId: string, parameterName: string, message: string) {
    super(`compliance pack '${packId}' parameter '${parameterName}': ${message}`);
    this.packId = packId;
    this.parameterName = parameterName;
  }
}
