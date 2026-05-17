import { describe, expect, it } from "vitest";
import {
  DeliveryChannelSchema,
  EXPORT_FORMATS,
  ReportScheduleSchema,
} from "./schedule.js";

describe("DeliveryChannelSchema", () => {
  it("parses an email channel", () => {
    const d = DeliveryChannelSchema.parse({
      kind: "email",
      recipients: ["qa@example.com"],
    });
    if (d.kind === "email") {
      expect(d.attachmentFormats).toEqual(["pdf"]);
    }
  });

  it("parses an r2 channel with signed-url expiry", () => {
    const d = DeliveryChannelSchema.parse({
      kind: "r2",
      bucket: "crossengin-files-eu",
      pathTemplate: "reports/<tenant>/<yyyy-mm>/<report>.pdf",
      formats: ["pdf", "csv"],
    });
    if (d.kind === "r2") {
      expect(d.signedUrlExpiry).toBe("P1D");
    }
  });

  it("parses a webhook channel with vault secret", () => {
    const d = DeliveryChannelSchema.parse({
      kind: "webhook",
      url: "https://example.com/hook",
      format: "json",
      secretRef: { vault: "report.webhook.secret" },
    });
    if (d.kind === "webhook") {
      expect(d.format).toBe("json");
    }
  });

  it("rejects unknown export format", () => {
    expect(() =>
      DeliveryChannelSchema.parse({
        kind: "email",
        recipients: ["x@y.com"],
        attachmentFormats: ["docx"],
      }),
    ).toThrow();
  });

  it("EXPORT_FORMATS lists pdf/csv/xlsx/json", () => {
    expect(EXPORT_FORMATS).toEqual(["pdf", "csv", "xlsx", "json"]);
  });
});

describe("ReportScheduleSchema", () => {
  it("parses a daily cron schedule with email delivery", () => {
    const s = ReportScheduleSchema.parse({
      cron: "0 6 * * *",
      timezone: "Asia/Dubai",
      deliverTo: [{ kind: "email", recipients: ["ops@example.com"] }],
    });
    expect(s.enabled).toBe(true);
    expect(s.timezone).toBe("Asia/Dubai");
  });

  it("rejects a malformed cron", () => {
    expect(() =>
      ReportScheduleSchema.parse({
        cron: "every monday",
        deliverTo: [{ kind: "email", recipients: ["x@y.com"] }],
      }),
    ).toThrow();
  });

  it("rejects an empty deliverTo", () => {
    expect(() =>
      ReportScheduleSchema.parse({
        cron: "0 6 * * *",
        deliverTo: [],
      }),
    ).toThrow();
  });

  it("rejects duplicate delivery channels", () => {
    expect(() =>
      ReportScheduleSchema.parse({
        cron: "0 6 * * *",
        deliverTo: [
          { kind: "email", recipients: ["a@x.com"] },
          { kind: "email", recipients: ["a@x.com"] },
        ],
      }),
    ).toThrow(/duplicate delivery channel/);
  });
});
