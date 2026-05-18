import type { EntityPermissions } from "@crossengin/auth";

const ALL_ROLES = ["erp_admin", "erp_accountant", "erp_viewer"];
const WRITE_ROLES = ["erp_admin", "erp_accountant"];
const ADMIN_ONLY = ["erp_admin"];

export const PAYMENT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_ROLES },
  read: { roles: ALL_ROLES },
  create: { roles: WRITE_ROLES },
  update: { roles: WRITE_ROLES },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    capture: { roles: WRITE_ROLES },
    settle: { roles: WRITE_ROLES },
    refund: { roles: ADMIN_ONLY },
    fail: { roles: WRITE_ROLES },
    cancel: { roles: WRITE_ROLES },
  },
};

export const ERP_PAYMENTS_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Payment: PAYMENT_PERMISSIONS,
};
