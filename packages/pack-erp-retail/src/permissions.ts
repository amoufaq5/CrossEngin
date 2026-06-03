import type { EntityPermissions } from "@crossengin/auth";

const ALL_RETAIL = ["retail_admin", "store_manager", "cashier", "retail_analyst"];
const MANAGERS = ["retail_admin", "store_manager"];
const SELLERS = ["retail_admin", "store_manager", "cashier"];
const ADMIN_ONLY = ["retail_admin"];

export const PRODUCT_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_RETAIL },
  read: { roles: ALL_RETAIL },
  create: { roles: MANAGERS },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
  // The classification default already redacts unit_cost from a cashier; this
  // explicit grant documents that managers + analysts may read the cost.
  fields: {
    unit_cost: {
      read: { roles: ["retail_admin", "store_manager", "retail_analyst"] },
      update: { roles: MANAGERS },
    },
  },
};

export const STORE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_RETAIL },
  read: { roles: ALL_RETAIL },
  create: { roles: ADMIN_ONLY },
  update: { roles: MANAGERS },
  delete: { roles: ADMIN_ONLY },
};

export const SALES_ORDER_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_RETAIL },
  read: { roles: ALL_RETAIL },
  create: { roles: SELLERS },
  update: { roles: SELLERS },
  delete: { roles: ADMIN_ONLY },
  transitions: {
    place: { roles: SELLERS },
    fulfill: { roles: MANAGERS },
    cancel: { roles: SELLERS },
    mark_returned: { roles: MANAGERS },
  },
};

export const ORDER_LINE_PERMISSIONS: EntityPermissions = {
  list: { roles: ALL_RETAIL },
  read: { roles: ALL_RETAIL },
  create: { roles: SELLERS },
  update: { roles: SELLERS },
  delete: { roles: MANAGERS },
};

export const ERP_RETAIL_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  Product: PRODUCT_PERMISSIONS,
  Store: STORE_PERMISSIONS,
  SalesOrder: SALES_ORDER_PERMISSIONS,
  OrderLine: ORDER_LINE_PERMISSIONS,
};
