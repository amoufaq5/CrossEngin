import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_ADMIN: RoleDefinition = {
  name: "erp_admin",
  label: { en: "ERP Administrator" },
  description: "Full CRUD on accounts, contacts, invoices, and invoice lines.",
};

export const ROLE_ACCOUNTANT: RoleDefinition = {
  name: "erp_accountant",
  label: { en: "Accountant" },
  description: "Creates and sends invoices, marks them paid, reads accounts and contacts.",
};

export const ROLE_VIEWER: RoleDefinition = {
  name: "erp_viewer",
  label: { en: "Read-only viewer" },
  description: "Read-only access for auditors and observers.",
};

export const ERP_CORE_ROLES: Readonly<Record<string, RoleDefinition>> = {
  erp_admin: ROLE_ADMIN,
  erp_accountant: ROLE_ACCOUNTANT,
  erp_viewer: ROLE_VIEWER,
};
