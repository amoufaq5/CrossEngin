import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the core ERP `Account` (the agency/organization record).
export const ACCOUNT_CITIZENS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "citizens",
  to: "Citizen",
  onDelete: "cascade",
};

export const CITIZEN_CASES_RELATION: Relation = {
  kind: "one_to_many",
  from: "Citizen",
  field: "cases",
  to: "Case",
  onDelete: "cascade",
};

export const CITIZEN_PERMITS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Citizen",
  field: "permits",
  to: "Permit",
  onDelete: "cascade",
};

export const ERP_GOVERNMENT_RELATIONS: readonly Relation[] = [
  ACCOUNT_CITIZENS_RELATION,
  CITIZEN_CASES_RELATION,
  CITIZEN_PERMITS_RELATION,
];
