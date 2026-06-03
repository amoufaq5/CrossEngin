import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the CORE Account (reached two levels up the chain).
export const ACCOUNT_SUPPLIERS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "suppliers",
  to: "Supplier",
  onDelete: "cascade",
};

export const SUPPLIER_LOTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Supplier",
  field: "lots",
  to: "PerishableLot",
  onDelete: "restrict",
};

// Cross-pack: `from` is the RETAIL Product (the immediate parent pack).
export const PRODUCT_LOTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Product",
  field: "lots",
  to: "PerishableLot",
  onDelete: "cascade",
};

export const ERP_GROCERY_RELATIONS: readonly Relation[] = [
  ACCOUNT_SUPPLIERS_RELATION,
  SUPPLIER_LOTS_RELATION,
  PRODUCT_LOTS_RELATION,
];
