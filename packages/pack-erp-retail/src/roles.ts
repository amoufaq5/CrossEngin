import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_RETAIL_ADMIN: RoleDefinition = {
  name: "retail_admin",
  label: { en: "Retail Administrator" },
  description: "Full CRUD on products, stores, and sales orders, including costs.",
};

export const ROLE_STORE_MANAGER: RoleDefinition = {
  name: "store_manager",
  label: { en: "Store Manager" },
  description: "Manages a store's orders + products; sees wholesale costs.",
};

export const ROLE_CASHIER: RoleDefinition = {
  name: "cashier",
  label: { en: "Cashier" },
  description:
    "Rings up sales orders; reads products but not their wholesale cost.",
};

export const ROLE_RETAIL_ANALYST: RoleDefinition = {
  name: "retail_analyst",
  label: { en: "Retail Analyst" },
  description: "Read-only access to products, stores, and orders for reporting.",
};

export const ERP_RETAIL_ROLES: Readonly<Record<string, RoleDefinition>> = {
  retail_admin: ROLE_RETAIL_ADMIN,
  store_manager: ROLE_STORE_MANAGER,
  cashier: ROLE_CASHIER,
  retail_analyst: ROLE_RETAIL_ANALYST,
};
