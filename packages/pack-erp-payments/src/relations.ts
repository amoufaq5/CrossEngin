import type { Relation } from "@crossengin/types/meta-schema";

export const INVOICE_PAYMENTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Invoice",
  field: "payments",
  to: "Payment",
  onDelete: "restrict",
};

export const ERP_PAYMENTS_RELATIONS: readonly Relation[] = [INVOICE_PAYMENTS_RELATION];
