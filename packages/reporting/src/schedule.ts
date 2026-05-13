import { z } from "zod";

const CRON_FIELD = String.raw`(?:\*|(?:\*\/\d+)|(?:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)(?:\/\d+)?)`;
const CRON_REGEX = new RegExp(`^${CRON_FIELD}(?: ${CRON_FIELD}){4,5}$`);

export const CronExpressionSchema = z.string().regex(CRON_REGEX, {
  message: "cron must be a 5- or 6-field crontab expression",
});

export const EXPORT_FORMATS = ["pdf", "csv", "xlsx", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const ExportFormatSchema = z.enum(EXPORT_FORMATS);

export const EmailDeliverySchema = z.object({
  kind: z.literal("email"),
  recipients: z.array(z.string().email()).min(1),
  subjectTemplate: z.string().min(1).optional(),
  attachmentFormats: z.array(ExportFormatSchema).min(1).default(["pdf"]),
});

export const R2DeliverySchema = z.object({
  kind: z.literal("r2"),
  bucket: z.string().min(1),
  pathTemplate: z.string().min(1),
  formats: z.array(ExportFormatSchema).min(1).default(["pdf"]),
  signedUrlExpiry: z.string().regex(/^P(?=.)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/).default("P1D"),
});

export const WebhookDeliverySchema = z.object({
  kind: z.literal("webhook"),
  url: z.string().url(),
  format: ExportFormatSchema.default("json"),
  secretRef: z.object({ vault: z.string().min(1) }).optional(),
});

export const DeliveryChannelSchema = z.discriminatedUnion("kind", [
  EmailDeliverySchema,
  R2DeliverySchema,
  WebhookDeliverySchema,
]);
export type DeliveryChannel = z.infer<typeof DeliveryChannelSchema>;

export const ReportScheduleSchema = z
  .object({
    cron: CronExpressionSchema,
    timezone: z.string().min(1).default("UTC"),
    enabled: z.boolean().default(true),
    deliverTo: z.array(DeliveryChannelSchema).min(1),
    suppressIfEmpty: z.boolean().default(false),
    failureAlertChannel: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    const kinds = new Set<string>();
    v.deliverTo.forEach((d, i) => {
      const key = `${d.kind}:${"url" in d ? d.url : "bucket" in d ? d.bucket : d.recipients.join(",")}`;
      if (kinds.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deliverTo", i],
          message: "duplicate delivery channel",
        });
      }
      kinds.add(key);
    });
  });
export type ReportSchedule = z.infer<typeof ReportScheduleSchema>;
