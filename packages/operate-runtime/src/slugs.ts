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

// `entityReadOperationIds(name) -> [<camel>.list, <camel>.read]` used to live here, described as
// "the operationIds whose responses carry this entity's records (for redaction)". That was false —
// `create`, `update`, `delete` and every lifecycle transition carry the record too — and
// `compileOperateServer` keyed the redaction registry off it, so every write response returned
// every classified field in the clear. It is deleted rather than corrected with a truthful
// comment: nothing else called it, and a per-entity list of action names cannot be made correct
// here at all, since a transition's id comes from the manifest's workflow. The operation set an
// entity really serves is `entityRouteSpecs` in `operations.ts`, and `compile.ts` indexes the
// routes it derived; a helper over the name alone would only invite the same mistake back.

/** A stable `rt_…` route id derived from an operationId. */
export function routeId(opId: string): string {
  const slug = opId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `rt_${slug.slice(0, 40).padEnd(8, "x")}`;
}
