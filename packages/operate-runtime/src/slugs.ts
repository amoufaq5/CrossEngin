export type CrudOperation = "list" | "read" | "create" | "update" | "delete";

/** `Product` → `product`, `SalesOrder` → `salesOrder` (operationId-safe, no hyphens). */
export function entityCamel(entityName: string): string {
  return entityName.length === 0
    ? entityName
    : entityName[0]!.toLowerCase() + entityName.slice(1);
}

/** `Product` → `products`, `SalesOrder` → `sales-orders`, `OrderLine` → `order-lines`. */
export function resourceSlug(entityName: string): string {
  const kebab = entityName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return `${kebab}s`;
}

/** A gateway operationId, e.g. `salesOrder.list` / `salesOrder.place`. */
export function operationId(entityName: string, action: string): string {
  return `${entityCamel(entityName)}.${action}`;
}

/** The operationIds whose responses carry this entity's records (for redaction). */
export function entityReadOperationIds(entityName: string): readonly string[] {
  return [operationId(entityName, "list"), operationId(entityName, "read")];
}

/** A stable `rt_…` route id derived from an operationId. */
export function routeId(opId: string): string {
  const slug = opId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `rt_${slug.slice(0, 40).padEnd(8, "x")}`;
}
