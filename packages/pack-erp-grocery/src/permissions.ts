import type { EntityPermissions } from "@crossengin/auth";

const ALL_GROCERY = ["grocery_admin", "receiving_clerk"];
const ADMIN_ONLY = ["grocery_admin"];

export const SUPPLIER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_GROCERY },
  read: { roles: ALL_GROCERY },
  create: { roles: ADMIN_ONLY },
  update: { roles: ADMIN_ONLY },
  delete: { roles: ADMIN_ONLY },
  // The receiving clerk reads the supplier to attribute a lot to it and receives
  // against a lot code, never against the supplier's mailbox — so the pii
  // contact stays with the admin who maintains the supplier record.
  fields: {
    contact_email: {
      read: { roles: ADMIN_ONLY },
      update: { roles: ADMIN_ONLY },
    },
  },
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
      // Set once at receipt from the delivery paperwork, corrected only by an
      // admin. The receiving clerk holds the entity's create grant and
      // cost_per_unit is required, so before this arm existed restricting the
      // correction to an admin also restricted the create and no clerk could
      // receive a lot at all (`field_required_but_uncreatable`; ADR-0348). The
      // clerk still cannot *read* a cost back — keying in the figure on the
      // invoice in front of them discloses nothing.
      create: { roles: ALL_GROCERY },
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
