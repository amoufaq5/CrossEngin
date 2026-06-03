import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_GROCERY_ADMIN: RoleDefinition = {
  name: "grocery_admin",
  label: { en: "Grocery Administrator" },
  description: "Full CRUD on suppliers and perishable lots, including lot cost.",
};

export const ROLE_RECEIVING_CLERK: RoleDefinition = {
  name: "receiving_clerk",
  label: { en: "Receiving Clerk" },
  description:
    "Receives and shelves perishable lots; reads suppliers but not lot cost.",
};

export const ERP_GROCERY_ROLES: Readonly<Record<string, RoleDefinition>> = {
  grocery_admin: ROLE_GROCERY_ADMIN,
  receiving_clerk: ROLE_RECEIVING_CLERK,
};
