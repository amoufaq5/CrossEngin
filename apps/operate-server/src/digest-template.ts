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
import { htmlMarkupRefusals } from "./notification-template-routes.js";

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
  /**
   * Why a tenant's override was not used, or `null` when there was none or it rendered. The
   * fallback to the platform default is the right *answer* — a half-rendered notice or one that
   * fails the markup allowlist is worse than the default — but it used to be a silent one, so a
   * tenant whose authored digest never once rendered was told nothing and the operator neither
   * (ADR-0476).
   */
  readonly overrideRefusal: DigestOverrideRefusal | null;
}

/**
 * Why an authored digest override fell back to the default. Checked in this order, and the first
 * true one is the reason: a body written for another channel is never rendered here at all, a
 * source the authoring allowlist refuses is not worth substituting into, a rendered body that still
 * carries a placeholder is half a notice, and a rendered body is re-checked because only there is
 * a placeholder in a tag or attribute name visible as markup.
 */
export const DIGEST_OVERRIDE_REFUSALS = [
  "override_channel_not_rendered",
  "override_refused_source",
  "override_missing_variables",
  "override_refused_rendered",
] as const;
export type DigestOverrideRefusal = (typeof DIGEST_OVERRIDE_REFUSALS)[number];

/** A tenant's authored override, with the identity its refusal is reported under. */
export interface DigestOverride {
  readonly content: TemplateContent;
  /** The authored template row's id — what an operator looks the template up by. */
  readonly templateRecordId: string;
  readonly version: string;
  readonly locale: string;
}

/**
 * What a refusal report carries: **no body content** — not the source, not the rendered body, not
 * the names of the missing variables (they are tenant-authored text too). The template's identity,
 * the reason and a count are enough to find and fix it.
 */
export interface DigestOverrideRefusedEvent {
  readonly tenantId: string;
  readonly templateRecordId: string;
  readonly version: string;
  readonly locale: string;
  readonly reason: DigestOverrideRefusal;
  readonly missingVariableCount: number;
}

export type DigestOverrideReporter = (event: DigestOverrideRefusedEvent) => void;

const DEFAULT_SEVERITY = "info";

type OverrideOutcome =
  | { readonly kind: "applied"; readonly rendered: { title: string; body: string; severity: string } }
  | { readonly kind: "refused"; readonly reason: DigestOverrideRefusal; readonly missing: number };

/**
 * Whether an authored override renders, and if not, why. Pure: the one place the four refusals are
 * decided, so the reason a reporter is told is the reason the body fell back.
 */
export function decideDigestOverride(
  content: TemplateContent,
  context: RenderContext,
): OverrideOutcome {
  // INVARIANT: an override is tenant-authored, untrusted copy. It may reference variables this
  // digest never supplies, or be written for another channel entirely. A half-rendered notice
  // still carrying `{{...}}` is worse than the platform default, so any such override is dropped
  // and the built-in content renders instead.
  //
  // And its rendered body must pass the authoring allowlist again, because this body reaches the
  // console's `dangerouslySetInnerHTML` and the store is not a trust boundary: the routes vet what
  // they write, and a row they did not write (stored before they existed, or by SQL) was vetted by
  // nothing. Checked twice, because each reading sees what the other cannot: the *source* is what
  // the authoring route judged, and only there can the URL rule tell a placeholder in an origin
  // (`https://app{{x}}`, refused) from one after it; the *rendered* body is the string a browser
  // parses, and only there is a placeholder in a tag or attribute name visible as markup. Dropped
  // to the default rather than sanitised, for the authoring route's reason — a sanitiser that
  // rewrites the body shows the tenant something they did not write.
  if (content.channel !== "in_app") {
    return { kind: "refused", reason: "override_channel_not_rendered", missing: 0 };
  }
  if (htmlMarkupRefusals("htmlBody", content.htmlBody).length > 0) {
    return { kind: "refused", reason: "override_refused_source", missing: 0 };
  }
  const attempt = renderTemplateContent(content, context);
  if (attempt.missing.length > 0) {
    return { kind: "refused", reason: "override_missing_variables", missing: attempt.missing.length };
  }
  if (htmlMarkupRefusals("htmlBody", attempt.rendered.body).length > 0) {
    return { kind: "refused", reason: "override_refused_rendered", missing: 0 };
  }
  return {
    kind: "applied",
    rendered: {
      title: attempt.rendered.title,
      body: attempt.rendered.body,
      severity: attempt.rendered.severity ?? DEFAULT_SEVERITY,
    },
  };
}

export function renderDigest(input: {
  readonly digest: DigestBatch;
  readonly members: readonly DigestMember[];
  /**
   * The override and its reporter travel together, so an override cannot be rendered without a
   * place its refusal is said: the reporter is required by the shape rather than by a convention.
   */
  readonly override?: {
    readonly template: DigestOverride;
    readonly onRefused: DigestOverrideReporter;
  };
  readonly locale?: string;
}): RenderedDigest {
  const context = digestRenderContext(input);
  const itemCount = input.members.length;

  let overrideRefusal: DigestOverrideRefusal | null = null;
  if (input.override !== undefined) {
    const outcome = decideDigestOverride(input.override.template.content, context);
    if (outcome.kind === "applied") {
      return { ...outcome.rendered, itemCount, overrideRefusal: null };
    }
    overrideRefusal = outcome.reason;
    input.override.onRefused({
      tenantId: input.digest.tenantId,
      templateRecordId: input.override.template.templateRecordId,
      version: input.override.template.version,
      locale: input.override.template.locale,
      reason: outcome.reason,
      missingVariableCount: outcome.missing,
    });
  }

  const fallback = renderTemplateContent(DEFAULT_DIGEST_CONTENT, context);
  return {
    title: fallback.rendered.title,
    body: fallback.rendered.body,
    severity: fallback.rendered.severity ?? DEFAULT_SEVERITY,
    itemCount,
    overrideRefusal,
  };
}

/** The most distinct refusals remembered before the memory is cleared and they are said again. */
export const DIGEST_OVERRIDE_REPORT_MEMORY = 1024;

/**
 * A reporter that says each refusal **once per template version and reason**, not once per read.
 *
 * The digest copy is rendered on every inbox read, so an unconditional reporter would log the same
 * broken template on every poll of every viewer — noise an operator filters, taking the finding
 * with it. The key is the authored row, its version and the reason, so editing the template (a new
 * version) or breaking it differently is said again. The memory is bounded and, when full, is
 * **cleared** rather than frozen: a cleared memory repeats a report, a frozen one would silence every
 * refusal after the 1024th — repetition is the honest failure, silence is not.
 */
export function onceDigestOverrideReporter(
  sink: DigestOverrideReporter,
  memory: number = DIGEST_OVERRIDE_REPORT_MEMORY,
): DigestOverrideReporter {
  const seen = new Set<string>();
  return (event) => {
    const key = JSON.stringify([
      event.tenantId,
      event.templateRecordId,
      event.version,
      event.reason,
    ]);
    if (seen.has(key)) return;
    if (seen.size >= memory) seen.clear();
    seen.add(key);
    sink(event);
  };
}
