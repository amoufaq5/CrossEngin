import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_ADMIN: RoleDefinition = {
  name: "erp_admin",
  label: { en: "ERP Administrator" },
  description: "Full CRUD across every ERP domain — CRM, inventory, procurement, finance, and HR.",
};

export const ROLE_ACCOUNTANT: RoleDefinition = {
  name: "erp_accountant",
  label: { en: "Accountant" },
  description:
    "Creates and sends invoices, marks them paid, reads accounts and contacts.",
};

export const ROLE_VIEWER: RoleDefinition = {
  name: "erp_viewer",
  label: { en: "Read-only viewer" },
  description: "Read-only access for auditors and observers.",
};

export const ROLE_INVENTORY_MANAGER: RoleDefinition = {
  name: "inventory_manager",
  label: { en: "Inventory Manager" },
  description: "Manages items, warehouses, stock levels, and stock movements.",
};

export const ROLE_WAREHOUSE_CLERK: RoleDefinition = {
  name: "warehouse_clerk",
  label: { en: "Warehouse Clerk" },
  description: "Records stock movements and goods receipts; reads items and warehouses.",
};

export const ROLE_PROCUREMENT_MANAGER: RoleDefinition = {
  name: "procurement_manager",
  label: { en: "Procurement Manager" },
  description: "Manages vendors and purchase orders, approves procurement, posts goods receipts.",
};

export const ROLE_AP_CLERK: RoleDefinition = {
  name: "ap_clerk",
  label: { en: "Accounts Payable Clerk" },
  description: "Manages vendor bills and outbound payments.",
};

export const ROLE_CONTROLLER: RoleDefinition = {
  name: "controller",
  label: { en: "Financial Controller" },
  description: "Owns the general ledger — ledger accounts, journal entries, and posting.",
};

export const ROLE_HR_MANAGER: RoleDefinition = {
  name: "hr_manager",
  label: { en: "HR Manager" },
  description: "Manages departments, positions, employees, and leave requests (incl. PII).",
};

export const ERP_CORE_ROLES: Readonly<Record<string, RoleDefinition>> = {
  erp_admin: ROLE_ADMIN,
  erp_accountant: ROLE_ACCOUNTANT,
  erp_viewer: ROLE_VIEWER,
  inventory_manager: ROLE_INVENTORY_MANAGER,
  warehouse_clerk: ROLE_WAREHOUSE_CLERK,
  procurement_manager: ROLE_PROCUREMENT_MANAGER,
  ap_clerk: ROLE_AP_CLERK,
  controller: ROLE_CONTROLLER,
  hr_manager: ROLE_HR_MANAGER,
};
