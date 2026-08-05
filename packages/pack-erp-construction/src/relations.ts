import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the core ERP `Account` (the client / owner).
export const ACCOUNT_PROJECTS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "projects",
  to: "Project",
  onDelete: "cascade",
};

export const PROJECT_WORK_ORDERS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Project",
  field: "work_orders",
  to: "WorkOrder",
  onDelete: "cascade",
};

export const SUBCONTRACTOR_WORK_ORDERS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Subcontractor",
  field: "work_orders",
  to: "WorkOrder",
  onDelete: "restrict",
};

export const ERP_CONSTRUCTION_RELATIONS: readonly Relation[] = [
  ACCOUNT_PROJECTS_RELATION,
  PROJECT_WORK_ORDERS_RELATION,
  SUBCONTRACTOR_WORK_ORDERS_RELATION,
];
