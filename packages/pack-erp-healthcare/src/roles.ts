import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_CLINICIAN: RoleDefinition = {
  name: "erp_clinician",
  label: { en: "Clinician" },
  description:
    "Healthcare provider who creates encounters and records observations. PHI access scoped per tenant.",
};

export const ROLE_FRONT_DESK: RoleDefinition = {
  name: "erp_front_desk",
  label: { en: "Front desk" },
  description:
    "Schedules encounters, performs check-in / cancellation. Read-only access to Patient demographics.",
};

export const ERP_HEALTHCARE_ROLES: Readonly<Record<string, RoleDefinition>> = {
  erp_clinician: ROLE_CLINICIAN,
  erp_front_desk: ROLE_FRONT_DESK,
};
