import type { CompliancePack } from "../../types.js";

export const pack: CompliancePack = {
  meta: {
    id: "hipaa",
    title: "HIPAA — Health Insurance Portability and Accountability Act",
    version: "1.0.0",
    regulator: "HHS Office for Civil Rights (US)",
    appliesTo: {
      industries: [
        "healthcare-providers",
        "health-plans",
        "healthcare-clearinghouses",
        "business-associates",
        "pharma",
      ],
      families: ["operate-pharma-healthcare", "heal"],
    },
    parameters: {
      coveredEntityType: {
        type: "enum",
        values: ["covered_entity", "business_associate", "hybrid_entity"],
        required: true,
        helpText: "HIPAA role of the tenant under 45 CFR §160.103. Drives which obligations apply.",
      },
      breachNotificationDays: {
        type: "integer",
        min: 1,
        max: 60,
        default: 60,
        helpText:
          "Maximum days from discovery to notify affected individuals. Per §164.404(b) — without unreasonable delay and in no case later than 60 calendar days.",
      },
      allowPhiInNotifications: {
        type: "boolean",
        default: false,
        helpText:
          "Whether outbound notifications (email/SMS) may contain PHI. Default false per minimum-necessary standard §164.502(b).",
      },
      minimumNecessaryStandard: {
        type: "boolean",
        default: true,
        helpText:
          "Enforce minimum-necessary access for uses and disclosures per §164.502(b). Should remain true except for treatment exceptions.",
      },
      auditRetentionYears: {
        type: "integer",
        min: 6,
        default: 6,
        helpText:
          "Years to retain audit records on PHI-tagged entities. Minimum 6 per §164.316(b)(2)(i).",
      },
      requireMfaForPhiAccess: {
        type: "boolean",
        default: true,
        helpText:
          "Require multi-factor authentication for any session that reads PHI. Strengthens §164.312(d) person-or-entity authentication.",
      },
      privacyOfficerName: {
        type: "string",
        required: true,
        helpText:
          "Designated privacy official accountable for HIPAA Privacy Rule. Required by §164.530(a)(1).",
      },
      securityOfficerName: {
        type: "string",
        required: true,
        helpText:
          "Designated security official accountable for HIPAA Security Rule. Required by §164.308(a)(2).",
      },
    },
  },
  contributions: {
    entities: [
      {
        name: "PhiAccessLog",
        fields: [
          { name: "entity_kind", type: { kind: "text", maxLength: 64 }, required: true },
          { name: "entity_id", type: { kind: "uuid" }, required: true },
          { name: "patient_id", type: { kind: "uuid" }, required: true },
          { name: "accessed_by", type: { kind: "uuid" }, required: true },
          {
            name: "accessed_at",
            type: { kind: "datetime" },
            required: true,
            default: { kind: "expression", expression: "now()" },
          },
          {
            name: "access_reason",
            type: {
              kind: "enum",
              values: ["treatment", "payment", "operations", "patient_request", "legal", "other"],
            },
            required: true,
          },
          { name: "fields_accessed", type: { kind: "json" }, required: true },
          { name: "source_ip", type: { kind: "text", maxLength: 64 } },
        ],
        traits: ["auditable"],
      },
      {
        name: "BreachIncident",
        fields: [
          {
            name: "discovered_at",
            type: { kind: "datetime" },
            required: true,
          },
          { name: "breach_description", type: { kind: "long_text" }, required: true },
          { name: "affected_record_count", type: { kind: "integer", min: 0 }, required: true },
          {
            name: "notification_status",
            type: {
              kind: "enum",
              values: [
                "pending",
                "in_progress",
                "individuals_notified",
                "hhs_notified",
                "completed",
              ],
            },
            required: true,
            default: { kind: "literal", value: "pending" },
          },
          { name: "reported_to_hhs_at", type: { kind: "datetime" } },
          { name: "individuals_notified_at", type: { kind: "datetime" } },
          {
            name: "notification_method",
            type: {
              kind: "enum",
              values: ["written", "email", "substitute_notice", "media"],
            },
          },
          { name: "remediation_summary", type: { kind: "long_text" } },
        ],
        traits: ["auditable"],
      },
      {
        name: "BusinessAssociateAgreement",
        fields: [
          { name: "vendor_name", type: { kind: "text", maxLength: 256 }, required: true },
          { name: "vendor_contact_email", type: { kind: "email" }, required: true },
          { name: "agreement_start", type: { kind: "date" }, required: true },
          { name: "agreement_end", type: { kind: "date" } },
          { name: "agreement_document_url", type: { kind: "url" }, required: true },
          { name: "permitted_uses", type: { kind: "long_text" }, required: true },
          { name: "termination_clause", type: { kind: "long_text" }, required: true },
          {
            name: "status",
            type: {
              kind: "enum",
              values: ["draft", "executed", "expired", "terminated"],
            },
            required: true,
            default: { kind: "literal", value: "draft" },
          },
        ],
        traits: ["auditable"],
      },
    ],
    traits: [
      {
        name: "phi",
        fields: [
          {
            name: "data_class",
            type: { kind: "text", maxLength: 32 },
            required: true,
            default: { kind: "literal", value: "phi" },
          },
          {
            name: "encryption_at_rest_required",
            type: { kind: "boolean" },
            required: true,
            default: { kind: "literal", value: true },
          },
        ],
      },
    ],
  },
};
