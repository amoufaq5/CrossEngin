import type { EntityPermissions } from "@crossengin/auth";

const ALL_ROLES = ["erp_admin", "erp_accountant", "erp_viewer"];
const WRITE_ROLES = ["erp_admin", "erp_accountant"];
const ADMIN_ONLY = ["erp_admin"];

export const ACCOUNT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
};

export const CONTACT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
};

export const INVOICE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    send: { roles: WRITE_ROLES },
    mark_paid: { roles: WRITE_ROLES },
    mark_overdue: { roles: WRITE_ROLES },
    void: { roles: ADMIN_ONLY },
  },
};

export const INVOICE_LINE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: WRITE_ROLES },
};

export const ERP_CORE_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Account: ACCOUNT_PERMISSIONS,
  Contact: CONTACT_PERMISSIONS,
  Invoice: INVOICE_PERMISSIONS,
  InvoiceLine: INVOICE_LINE_PERMISSIONS,
};
