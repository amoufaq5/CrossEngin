import type { EntityPermissions } from "@crossengin/auth";

const ALL_GROCERY = ["grocery_admin", "receiving_clerk"];
const ADMIN_ONLY = ["grocery_admin"];

export const SUPPLIER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_GROCERY },
  read: { roles: ALL_GROCERY },
  create: { roles: ADMIN_ONLY },
  update: { roles: ADMIN_ONLY },
  delete: { roles: ADMIN_ONLY },
};

export const PERISHABLE_LOT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_GROCERY },
  read: { roles: ALL_GROCERY },
  create: { roles: ALL_GROCERY },
  update: { roles: ALL_GROCERY },
  delete: { roles: ADMIN_ONLY },
  // Lot cost is commercial-sensitive: redacted from the receiving clerk by the
  // classification default; this grant documents that only admins read it.
  fields: {
    cost_per_unit: {
      read: { roles: ADMIN_ONLY },
      update: { roles: ADMIN_ONLY },
    },
  },
  transitions: {
    shelve: { roles: ALL_GROCERY },
    deplete: { roles: ALL_GROCERY },
  },
};

export const ERP_GROCERY_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Supplier: SUPPLIER_PERMISSIONS,
  PerishableLot: PERISHABLE_LOT_PERMISSIONS,
};
