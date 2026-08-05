import type { RoleDefinition } from "@crossengin/auth";

export const ROLE_GOV_ADMIN: RoleDefinition = {
  name: "gov_admin",
  label: { en: "Government Administrator" },
  description: "Full CRUD on citizens, cases, and permits, including regulated identifiers.",
};

export const ROLE_CASE_WORKER: RoleDefinition = {
  name: "case_worker",
  label: { en: "Case Worker" },
  description: "Opens and advances citizen cases through their review lifecycle.",
};

export const ROLE_PERMIT_OFFICER: RoleDefinition = {
  name: "permit_officer",
  label: { en: "Permit Officer" },
  description: "Issues and manages permits; reads citizens but not their national ID.",
};

export const ROLE_GOV_AUDITOR: RoleDefinition = {
  name: "gov_auditor",
  label: { en: "Government Auditor" },
  description: "Read-only oversight across citizens, cases, and permits for compliance.",
};

export const ERP_GOVERNMENT_ROLES: Readonly<Record<string, RoleDefinition>> = {
  gov_admin: ROLE_GOV_ADMIN,
  case_worker: ROLE_CASE_WORKER,
  permit_officer: ROLE_PERMIT_OFFICER,
  gov_auditor: ROLE_GOV_AUDITOR,
};
