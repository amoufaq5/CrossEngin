import type { Relation } from "@crossengin/types/meta-schema";

export const ACCOUNT_CONTACTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "contacts",
  to: "Contact",
  onDelete: "cascade",
};

export const INVOICE_ACCOUNT_RELATION: Relation = {
  kind: "many_to_one",
  from: "Invoice",
  field: "account_id",
  to: "Account",
  onDelete: "restrict",
};

export const INVOICE_LINES_RELATION: Relation = {
  kind: "one_to_many",
  from: "Invoice",
  field: "lines",
  to: "InvoiceLine",
  onDelete: "cascade",
};

export const ERP_CORE_RELATIONS: readonly Relation[] = [
  ACCOUNT_CONTACTS_RELATION,
  INVOICE_ACCOUNT_RELATION,
  INVOICE_LINES_RELATION,
];
