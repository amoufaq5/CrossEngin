import {
  TemplateContentSchema,
  TemplateVariableSchema,
  renderTemplateContent,
  type DigestBatch,
  type NotificationChannel,
  type RenderContext,
  type TemplateContent,
  type TemplateVariable,
} from "@crossengin/notifications";

import {
  digestLocale,
  summarizeDigest,
  type DigestMember,
  type DigestSummary,
} from "./digest-assembly.js";

export const DIGEST_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  TemplateVariableSchema.parse({
    name: "itemCount",
    type: "number",
    required: true,
    exampleValue: "3",
  }),
  TemplateVariableSchema.parse({
    name: "summaryLine",
    type: "string",
    required: true,
    exampleValue: "3 notifications from 2 kinds of update",
  }),
  TemplateVariableSchema.parse({
    name: "itemLines",
    type: "string",
    required: true,
    exampleValue: "2 x Design review approved",
  }),
  TemplateVariableSchema.parse({
    name: "earliestAt",
    type: "date",
    required: true,
    exampleValue: "2026-08-24T22:00:00.000Z",
  }),
  TemplateVariableSchema.parse({
    name: "latestAt",
    type: "date",
    required: true,
    exampleValue: "2026-08-25T06:30:00.000Z",
  }),
  TemplateVariableSchema.parse({
    name: "channelLabel",
    type: "string",
    required: true,
    exampleValue: "Email",
  }),
];

export const DEFAULT_DIGEST_CONTENT: TemplateContent = TemplateContentSchema.parse({
  channel: "in_app",
  title: "{{itemCount}} notifications",
  htmlBody:
    "<p>{{summaryLine}}</p>" +
    "<pre>{{itemLines}}</pre>" +
    "<p>Delivered to {{channelLabel}}. Earliest {{earliestAt}}, latest {{latestAt}}.</p>",
  actionLabel: "Open notifications",
  severity: "info",
});

export const DIGEST_TEMPLATE_LABELS: Readonly<Record<string, string>> = {
  "design_review.approved": "Design review approved",
  "design_review.rejected": "Design review rejected",
  "invoice.overdue": "Invoice overdue",
  "billing.invoice_overdue": "Invoice overdue",
  "order.shipped": "Order shipped",
};

export const DIGEST_CHANNEL_LABELS: Readonly<
  Record<NotificationChannel, string>
> = {
  email: "Email",
  sms: "SMS",
  push_mobile: "Mobile push",
  in_app: "In-app",
  webhook: "Webhook",
  voice_call: "Voice call",
};

export function templateLabel(templateId: string): string {
  return Object.prototype.hasOwnProperty.call(DIGEST_TEMPLATE_LABELS, templateId)
    ? (DIGEST_TEMPLATE_LABELS[templateId] ?? templateId)
    : templateId;
}

export function channelLabel(channel: NotificationChannel): string {
  return DIGEST_CHANNEL_LABELS[channel];
}

export interface DigestLine {
  readonly templateId: string;
  readonly count: number;
  readonly label: string;
}

export function digestLines(summary: DigestSummary): readonly DigestLine[] {
  return Object.entries(summary.templateCounts)
    .map(([templateId, count]) => ({
      templateId,
      count,
      label: templateLabel(templateId),
    }))
    .sort((a, b) =>
      a.count === b.count
        ? a.templateId.localeCompare(b.templateId)
        : b.count - a.count,
    );
}

export function digestSummaryLine(
  itemCount: number,
  kindCount: number,
): string {
  const items = itemCount === 1 ? "1 notification" : `${itemCount} notifications`;
  const kinds = kindCount === 1 ? "1 kind of update" : `${kindCount} kinds of update`;
  return `${items} from ${kinds}`;
}

export function digestItemLines(lines: readonly DigestLine[]): string {
  return lines.map((line) => `${line.count} x ${line.label}`).join("\n");
}

function assertMembers(digest: DigestBatch, members: readonly DigestMember[]): void {
  if (members.length === 0) {
    throw new Error(
      `digest ${digest.id} has no members to render; an empty digest is a bug, not a message`,
    );
  }
}

export function digestRenderContext(input: {
  readonly digest: DigestBatch;
  readonly members: readonly DigestMember[];
  readonly locale?: string;
}): RenderContext {
  assertMembers(input.digest, input.members);

  const summary = summarizeDigest(input.digest, input.members);
  const lines = digestLines(summary);

  return {
    locale: input.locale ?? digestLocale(input.members),
    variables: {
      itemCount: summary.itemCount,
      summaryLine: digestSummaryLine(summary.itemCount, lines.length),
      itemLines: digestItemLines(lines),
      earliestAt: summary.earliestQueuedAt,
      latestAt: summary.latestQueuedAt,
      channelLabel: channelLabel(input.digest.channel),
    },
  };
}

export interface RenderedDigest {
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly itemCount: number;
}

const DEFAULT_SEVERITY = "info";

export function renderDigest(input: {
  readonly digest: DigestBatch;
  readonly members: readonly DigestMember[];
  readonly content?: TemplateContent;
  readonly locale?: string;
}): RenderedDigest {
  const context = digestRenderContext(input);
  const itemCount = input.members.length;

  // INVARIANT: an override is tenant-authored, untrusted copy. It may reference variables this
  // digest never supplies, or be written for another channel entirely. A half-rendered notice
  // still carrying `{{...}}` is worse than the platform default, so any such override is dropped
  // and the built-in content renders instead.
  const override = input.content;
  if (override !== undefined && override.channel === "in_app") {
    const attempt = renderTemplateContent(override, context);
    if (attempt.missing.length === 0) {
      return {
        title: attempt.rendered.title,
        body: attempt.rendered.body,
        severity: attempt.rendered.severity ?? DEFAULT_SEVERITY,
        itemCount,
      };
    }
  }

  const fallback = renderTemplateContent(DEFAULT_DIGEST_CONTENT, context);
  return {
    title: fallback.rendered.title,
    body: fallback.rendered.body,
    severity: fallback.rendered.severity ?? DEFAULT_SEVERITY,
    itemCount,
  };
}
