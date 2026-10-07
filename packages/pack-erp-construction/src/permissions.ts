import type { EntityPermissions } from "@crossengin/auth";

const ALL_CONSTRUCTION = [
  "construction_admin",
  "project_manager",
  "foreman",
  "cost_analyst",
];
const MANAGERS = ["construction_admin", "project_manager"];
const FIELD_CREW = ["construction_admin", "project_manager", "foreman"];
const ADMIN_ONLY = ["construction_admin"];
const COST_READERS = ["construction_admin", "project_manager", "cost_analyst"];

export const PROJECT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CONSTRUCTION },
  read: { roles: ALL_CONSTRUCTION },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    start_work: { roles: MANAGERS },
    hold: { roles: MANAGERS },
    resume: { roles: MANAGERS },
    complete: { roles: MANAGERS },
    cancel: { roles: ADMIN_ONLY },
  },
  // The classification default already redacts budget_amount from a foreman; this
  // explicit grant documents that managers + cost analysts may read the budget.
  fields: {
    budget_amount: {
      read: { roles: COST_READERS },
      update: { roles: MANAGERS },
    },
  },
};

export const SUBCONTRACTOR_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CONSTRUCTION },
  read: { roles: ALL_CONSTRUCTION },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  fields: {
    tax_id: {
      read: { roles: COST_READERS },
      update: { roles: MANAGERS },
    },
    // MANAGERS and not COST_READERS, unlike tax_id beside it: the cost analyst
    // reads the money on a subcontractor, not the pii of who to ring.
    contact_email: {
      read: { roles: MANAGERS },
      update: { roles: MANAGERS },
    },
  },
};

export const WORK_ORDER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_CONSTRUCTION },
  read: { roles: ALL_CONSTRUCTION },
  create: { roles: FIELD_CREW },
  update: { roles: FIELD_CREW },
  delete: { roles: MANAGERS },
  fields: {
    cost_estimate: {
      read: { roles: COST_READERS },
      update: { roles: MANAGERS },
      // Set once by whoever raises the order, revised only by a manager. The
      // foreman holds the entity's create grant and cost_estimate is required,
      // so before this arm existed narrowing the revision to MANAGERS also
      // narrowed the create and no foreman could raise a work order at all
      // (`field_required_but_uncreatable`; ADR-0348). They still cannot *read*
      // a cost back — supplying the subcontractor's quote discloses nothing.
      create: { roles: FIELD_CREW },
    },
  },
};

export const ERP_CONSTRUCTION_PERMISSIONS: Readonly<
  Record<string, EntityPermissions>
> = {
  Project: PROJECT_PERMISSIONS,
  Subcontractor: SUBCONTRACTOR_PERMISSIONS,
  WorkOrder: WORK_ORDER_PERMISSIONS,
};
