import type { CompliancePack } from "../../types.js";

export const pack: CompliancePack = {
  meta: {
    id: "21-cfr-part-11",
    title: "21 CFR Part 11 — Electronic Records and Electronic Signatures",
    version: "1.0.0",
    regulator: "FDA (US)",
    appliesTo: {
      industries: ["pharma", "medical-devices", "biotech"],
      families: ["operate-pharma-healthcare", "heal"],
    },
    parameters: {
      signatureMethod: {
        type: "enum",
        values: ["username-password-otp", "smart-card-pin", "biometric-fingerprint"],
        default: "username-password-otp",
        helpText:
          "Method used to challenge users during electronic signature. Per §11.10(g) and §11.200.",
      },
      auditRetentionYears: {
        type: "integer",
        min: 7,
        default: 7,
        helpText:
          "Years to retain audit records on gxp_signed entities. Minimum 7 per §11.10(e).",
      },
      signatureMeaningStatement: {
        type: "localized-string",
        required: true,
        helpText:
          "Statement displayed during e-sign indicating intent (e.g. { en: 'I approve' }). Per §11.50(a).",
      },
    },
  },
  contributions: {
    entities: [
      {
        name: "Signature",
        fields: [
          {
            name: "method",
            type: {
              kind: "enum",
              values: ["username-password-otp", "smart-card-pin", "biometric-fingerprint"],
            },
            required: true,
          },
          {
            name: "challenge_id",
            type: { kind: "text", maxLength: 64 },
            required: true,
            unique: true,
          },
          {
            name: "signed_at",
            type: { kind: "datetime" },
            required: true,
            default: { kind: "expression", expression: "now()" },
          },
          {
            name: "signed_by",
            type: { kind: "uuid" },
            required: true,
          },
          {
            name: "meaning_statement",
            type: { kind: "long_text" },
            required: true,
          },
          {
            name: "entity_kind",
            type: { kind: "text", maxLength: 64 },
            required: true,
          },
          {
            name: "entity_id",
            type: { kind: "uuid" },
            required: true,
          },
        ],
        traits: ["auditable"],
      },
    ],
  },
};
