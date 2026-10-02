import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import {
  CHANNEL_CAPABILITIES,
  CONTENT_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NotificationTemplateSchema,
  TEMPLATE_STATUSES,
  TemplateContentSchema,
  TemplateVariableSchema,
  canTransitionTemplate,
  channelSupportsCategory,
  isCategorySuppressible,
  templatePlaceholders,
  type ContentCategory,
  type NotificationChannel,
  type NotificationTemplate,
  type TemplateContent,
  type TemplateStatus,
  type TemplateVariable,
} from "@crossengin/notifications";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Notification-template authoring over HTTP (the ADR-0277 follow-up).
 *
 * `meta.notification_templates` has carried a full lifecycle since Phase 1 and nothing could reach
 * it: a tenant wanting its own invoice email had to be handed direct SQL. These routes author a
 * draft, walk it through `TEMPLATE_TRANSITIONS`, and nothing else — there is no route that writes
 * an approved template in one step, because the approval is the only part of this that matters.
 *
 * Two rules carry the weight.
 *
 * **Four-eyes.** An author may not approve their own template. The contract already refuses a
 * stored row where `approvedBy === createdBy`; the route refuses the request, and the store's
 * UPDATE carries `created_by <> $actor` as a predicate so a race cannot land one either. Three
 * layers for one rule, because the only way a privileged action stays privileged is if the check
 * holds at the layer that actually writes.
 *
 * **Authored content is executable.** A template body is rendered into an email and into the
 * in-app inbox, where `in_app.htmlBody` reaches a browser as markup. The renderer escapes
 * *substituted values*, which is the other half of the problem: the body itself is author-supplied
 * HTML, so a `<script>` tag, an `onerror=` attribute or a `javascript:` action URL in the body is
 * stored XSS against every recipient in the tenant — and `z.string().url()` accepts
 * `javascript:alert(1)` quite happily, so the contract does not stop it. These routes therefore
 * refuse content rather than storing it and hoping a reader sanitises later: a payload that is in
 * the database is a payload some other reader will eventually render.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mirrors the column CHECK and the contract's `id` pattern. */
const NTPL_ID_RE = /^ntpl_[a-z0-9]{8,32}$/;

// ---------------------------------------------------------------------------
// Store seam
// ---------------------------------------------------------------------------

export interface TemplateListQueryLike {
  readonly status?: TemplateStatus;
  readonly templateId?: string;
  readonly channel?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TemplateListPageLike {
  readonly data: readonly NotificationTemplate[];
  readonly nextCursor: string | null;
}

export interface TemplateTransitionRequestLike {
  readonly to: TemplateStatus;
  readonly actorId: string;
  readonly at: string;
}

export type TemplateTransitionOutcomeLike =
  | { readonly kind: "transitioned"; readonly template: NotificationTemplate }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "illegal_transition";
      readonly from: TemplateStatus;
      readonly to: TemplateStatus;
    }
  | { readonly kind: "four_eyes"; readonly authorId: string }
  | { readonly kind: "conflict"; readonly from: TemplateStatus };

/**
 * Structural mirror of the authoring store. Declared here rather than imported so the route layer
 * stays decoupled from Postgres — the store itself is injected, as in every other route module.
 */
export interface NotificationTemplateStoreLike {
  createDraft(
    tenantId: string,
    template: NotificationTemplate,
  ): Promise<NotificationTemplate | null>;
  get(tenantId: string, ntplId: string): Promise<NotificationTemplate | null>;
  list(tenantId: string, query: TemplateListQueryLike): Promise<TemplateListPageLike>;
  transition(
    tenantId: string,
    ntplId: string,
    request: TemplateTransitionRequestLike,
  ): Promise<TemplateTransitionOutcomeLike>;
}

export interface NotificationTemplateRoutesContext {
  readonly store: NotificationTemplateStoreLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to author and submit drafts. Fail-closed: empty ⇒ nobody. */
  readonly authorRoles: ReadonlySet<string>;
  /**
   * Roles permitted to approve, reject, deprecate and retire. Fail-closed: empty ⇒ nobody, so a
   * deployment that forgets to configure it can draft templates and never send one.
   */
  readonly approverRoles: ReadonlySet<string>;
  /**
   * Roles permitted to author a template in a NON-suppressible category (`security_alert`,
   * `transactional`). Those categories override a recipient's preferences and suppressions by
   * design, so authoring one is how a marketing blast gets delivered to someone who opted out.
   * Fail-closed: absent or empty ⇒ nobody may author one.
   */
  readonly nonSuppressibleCategoryRoles?: ReadonlySet<string>;
  /** Injected so a test can pin the id; defaults to a random `ntpl_…`. */
  readonly newTemplateId?: () => string;
  readonly clock?: () => Date;
}

// ---------------------------------------------------------------------------
// Content safety
// ---------------------------------------------------------------------------

export const CONTENT_REFUSAL_CODES = [
  "unsafe_markup",
  "undeclared_placeholder",
  "templated_sender",
  "untrusted_url",
  "redacted_variable_exposed",
  "unparseable_payload_template",
  "oversized_body",
  "category_not_permitted",
  "channel_category_unsupported",
] as const;
export type ContentRefusalCode = (typeof CONTENT_REFUSAL_CODES)[number];

export interface ContentRefusal {
  readonly code: ContentRefusalCode;
  /** The content field at fault, e.g. `content.htmlBody`. */
  readonly field: string;
  /** What is wrong, in terms of the author's own input — never another tenant's data. */
  readonly detail: string;
}

/** How a field reaches a recipient, which is what decides how it must be checked. */
export type AuthoredFieldMode = "plain" | "markup" | "ssml" | "json" | "url" | "identity";

export interface AuthoredField {
  readonly path: string;
  readonly text: string;
  readonly mode: AuthoredFieldMode;
  /**
   * Whether the field's rendered value predictably ends up somewhere outside the message body —
   * a mail subject every MTA logs, a URL that travels in a Referer, the webhook event name. A
   * variable the author marked `redactInLogs` must not be placed in one.
   */
  readonly leaksToLogs: boolean;
}

function field(
  path: string,
  text: string | undefined,
  mode: AuthoredFieldMode,
  leaksToLogs = false,
): readonly AuthoredField[] {
  return text === undefined ? [] : [{ path: `content.${path}`, text, mode, leaksToLogs }];
}

/** Every author-supplied string in a template body, tagged with how it is rendered. */
export function authoredFields(content: TemplateContent): readonly AuthoredField[] {
  switch (content.channel) {
    case "email":
      return [
        ...field("subject", content.subject, "plain", true),
        ...field("preheader", content.preheader, "plain", true),
        ...field("htmlBody", content.htmlBody, "markup"),
        ...field("plaintextBody", content.plaintextBody, "plain"),
        ...field("fromName", content.fromName, "identity", true),
        ...field("replyTo", content.replyTo, "identity", true),
      ];
    case "sms":
      return field("body", content.body, "plain");
    case "push_mobile":
      return [
        ...field("title", content.title, "plain"),
        ...field("body", content.body, "plain"),
        ...field("deepLink", content.deepLink, "url", true),
        ...field("iconAsset", content.iconAsset, "plain"),
      ];
    case "in_app":
      return [
        ...field("title", content.title, "plain"),
        ...field("htmlBody", content.htmlBody, "markup"),
        ...field("actionLabel", content.actionLabel, "plain"),
        ...field("actionUrl", content.actionUrl, "url", true),
      ];
    case "webhook":
      return [
        ...field("eventName", content.eventName, "plain", true),
        ...field("payloadJsonTemplate", content.payloadJsonTemplate, "json"),
      ];
    case "voice_call":
      return [
        ...field("ssmlBody", content.ssmlBody, "ssml"),
        ...field("fallbackTextBody", content.fallbackTextBody, "plain"),
      ];
  }
}

/**
 * The markup an author may ship. An allowlist, not a denylist: a denylist of `<script>` and
 * `onerror=` is a list of the vectors somebody remembered, and the ones nobody remembered are
 * exactly the ones that get used.
 */
const ALLOWED_MARKUP_TAGS: ReadonlySet<string> = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "hr", "i", "img",
  "li", "ol", "p", "pre", "small", "span", "strong", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul",
]);

/**
 * Attributes allowed on that markup. `style` is absent deliberately — CSS reaches `url(...)`,
 * `expression(...)` and `position: fixed` overlays, so a styled template is a styled phishing
 * page. Every `on*` handler is excluded by virtue of not being listed.
 */
const ALLOWED_MARKUP_ATTRS: ReadonlySet<string> = new Set([
  "align", "alt", "class", "colspan", "dir", "height", "href", "lang", "rel", "rowspan", "src",
  "title", "width",
]);

/** SSML has its own vocabulary; `audio` is excluded because it fetches a remote file. */
const ALLOWED_SSML_TAGS: ReadonlySet<string> = new Set([
  "break", "emphasis", "lang", "p", "phoneme", "prosody", "s", "say-as", "speak", "sub", "voice",
]);

const ALLOWED_SSML_ATTRS: ReadonlySet<string> = new Set([
  "alias", "alphabet", "format", "interpret-as", "level", "name", "ph", "pitch", "rate",
  "strength", "time", "volume", "xml:lang",
]);

const URL_ATTRS: ReadonlySet<string> = new Set(["href", "src"]);

const TAG_RE = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g;

const ATTR_RE = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * A scheme that executes, or that carries a document. Checked across the whole field as a backstop
 * to the attribute allowlist: whitespace and an entity-encoded colon are both legal inside an
 * attribute value, so the scheme is matched loosely on purpose.
 */
const EXECUTABLE_SCHEME_RE = /(?:javascript|vbscript|livescript)\s*(?::|&#x?0*3a)/i;

/**
 * `data:` is refused outright, including `data:image/png;base64,…`.
 *
 * An inline image is a convenience; `data:text/html` is a same-origin document, and telling the two
 * apart means proving where in the markup the URI sits — which this scanner, which reads tokens
 * rather than parsing a tree, cannot do. An author who needs an image hosts it.
 */
const DATA_URI_RE = /data\s*(?::|&#x?0*3a)/i;

const TRUSTED_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/|$)/;

const TRUSTED_URL_PREFIX_RE = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\//;

/**
 * Whether a URL-valued field pins its own origin.
 *
 * A templated URL is useful (`https://app.example/invoices/{{invoiceId}}`) and a templated *origin*
 * is a redirect anybody who can trigger a send controls: `https://app{{x}}` with `x` =
 * `.evil.test/login` is a phishing link wearing the tenant's template. So a value containing a
 * placeholder must have scheme, host and a path separator before the first `{{`.
 */
export function pinsTrustedOrigin(value: string): boolean {
  const placeholderAt = value.indexOf("{{");
  if (placeholderAt < 0) return TRUSTED_URL_RE.test(value);
  return TRUSTED_URL_PREFIX_RE.test(value.slice(0, placeholderAt));
}

function urlRefusals(path: string, value: string): readonly ContentRefusal[] {
  const out: ContentRefusal[] = [];
  if (/[\s<>"'`\\]/.test(value)) {
    out.push({ code: "untrusted_url", field: path, detail: "contains whitespace or markup characters" });
  }
  if (!pinsTrustedOrigin(value)) {
    out.push({
      code: "untrusted_url",
      field: path,
      detail: "must begin with a literal https:// origin, with no placeholder in scheme or host",
    });
  }
  return out;
}

function scanAttributes(
  path: string,
  raw: string,
  allowedAttrs: ReadonlySet<string>,
): readonly ContentRefusal[] {
  const out: ContentRefusal[] = [];
  for (const match of raw.matchAll(ATTR_RE)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name.length === 0) continue;
    if (!allowedAttrs.has(name)) {
      out.push({ code: "unsafe_markup", field: path, detail: `attribute not allowed: ${name}` });
      continue;
    }
    if (!URL_ATTRS.has(name)) continue;
    out.push(...urlRefusals(`${path}@${name}`, match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return out;
}

/**
 * Refuses authored markup that is not in the allowlist.
 *
 * Tag-and-attribute scanning rather than parsing: this runs on an author's own template, where the
 * question is "is every construct in here one we permit", and anything the scanner cannot read as a
 * permitted tag is refused. A real parser would be needed to *sanitise* — which is the thing this
 * deliberately does not do, because a sanitiser that silently rewrites a body leaves the author
 * believing they shipped what they wrote.
 */
export function markupRefusals(
  path: string,
  text: string,
  allowedTags: ReadonlySet<string>,
  allowedAttrs: ReadonlySet<string>,
): readonly ContentRefusal[] {
  const out: ContentRefusal[] = [];
  if (EXECUTABLE_SCHEME_RE.test(text)) {
    out.push({ code: "unsafe_markup", field: path, detail: "executable url scheme" });
  }
  if (DATA_URI_RE.test(text)) {
    out.push({ code: "unsafe_markup", field: path, detail: "data: uri" });
  }
  for (const match of text.matchAll(TAG_RE)) {
    const closing = (match[1] ?? "") === "/";
    const name = (match[2] ?? "").toLowerCase();
    if (!allowedTags.has(name)) {
      out.push({ code: "unsafe_markup", field: path, detail: `tag not allowed: ${name}` });
      continue;
    }
    if (closing) continue;
    out.push(...scanAttributes(path, match[3] ?? "", allowedAttrs));
  }
  return out;
}

/**
 * A webhook payload template must be able to produce JSON. Placeholders are substituted with a
 * scalar first, so `{"n": {{count}}}` and `{"s": "{{name}}"}` both parse — and a template that
 * cannot parse either way is refused here rather than failing at delivery, once, per recipient.
 */
export function payloadTemplateRefusals(path: string, text: string): readonly ContentRefusal[] {
  const probe = text.replace(/\{\{\s*[a-z][a-zA-Z0-9_]*\s*\}\}/g, "0");
  try {
    const parsed: unknown = JSON.parse(probe);
    if (typeof parsed !== "object" || parsed === null) {
      return [{ code: "unparseable_payload_template", field: path, detail: "must render a JSON object or array" }];
    }
    return [];
  } catch {
    return [{ code: "unparseable_payload_template", field: path, detail: "does not render valid JSON" }];
  }
}

const PLACEHOLDER_RE = /\{\{\s*([a-z][a-zA-Z0-9_]*)\s*\}\}/g;

function placeholdersIn(text: string): readonly string[] {
  PLACEHOLDER_RE.lastIndex = 0;
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Derived, never declared: an author who picks `bodySizeBytes` picks whether the cap applies. */
export function derivedBodySizeBytes(content: TemplateContent): number {
  const total = authoredFields(content).reduce(
    (sum, f) => sum + Buffer.byteLength(f.text, "utf8"),
    0,
  );
  return Math.max(1, total);
}

export interface TemplateContentCheck {
  readonly content: TemplateContent;
  readonly variables: readonly TemplateVariable[];
  readonly channel: NotificationChannel;
  readonly category: ContentCategory;
  /** Whether the caller may author a non-suppressible category. */
  readonly mayAuthorNonSuppressible: boolean;
}

/**
 * Everything the route refuses to store, as a list rather than a first failure: an author fixing
 * one escaped tag at a time learns nothing about the other four.
 */
export function validateTemplateContent(check: TemplateContentCheck): readonly ContentRefusal[] {
  const out: ContentRefusal[] = [];
  if (!isCategorySuppressible(check.category) && !check.mayAuthorNonSuppressible) {
    out.push({
      code: "category_not_permitted",
      field: "category",
      detail: `${check.category} overrides recipient suppression and needs a privileged role`,
    });
  }
  if (!channelSupportsCategory(check.channel, check.category)) {
    out.push({
      code: "channel_category_unsupported",
      field: "category",
      detail: `${check.channel} cannot carry ${check.category}`,
    });
  }
  const declared = new Set(check.variables.map((v) => v.name));
  const redacted = new Set(check.variables.filter((v) => v.redactInLogs).map((v) => v.name));
  for (const name of templatePlaceholders(check.content)) {
    if (!declared.has(name)) {
      out.push({
        code: "undeclared_placeholder",
        field: "content",
        detail: `{{${name}}} is not a declared variable`,
      });
    }
  }
  for (const f of authoredFields(check.content)) {
    const referenced = placeholdersIn(f.text);
    if (f.mode === "identity" && referenced.length > 0) {
      out.push({
        code: "templated_sender",
        field: f.path,
        detail: "sender identity cannot be chosen at render time",
      });
    }
    if (f.leaksToLogs) {
      for (const name of referenced) {
        if (redacted.has(name)) {
          out.push({
            code: "redacted_variable_exposed",
            field: f.path,
            detail: `{{${name}}} is declared redactInLogs and this field is logged or forwarded`,
          });
        }
      }
    }
    switch (f.mode) {
      case "markup":
        out.push(...markupRefusals(f.path, f.text, ALLOWED_MARKUP_TAGS, ALLOWED_MARKUP_ATTRS));
        break;
      case "ssml":
        out.push(...markupRefusals(f.path, f.text, ALLOWED_SSML_TAGS, ALLOWED_SSML_ATTRS));
        break;
      case "url":
        out.push(...urlRefusals(f.path, f.text));
        break;
      case "json":
        out.push(...payloadTemplateRefusals(f.path, f.text));
        break;
      case "plain":
      case "identity":
        break;
    }
  }
  const size = derivedBodySizeBytes(check.content);
  const cap = CHANNEL_CAPABILITIES[check.channel].maxBodyBytes;
  if (size > cap) {
    out.push({
      code: "oversized_body",
      field: "content",
      detail: `${size.toString()} bytes exceeds the ${check.channel} limit of ${cap.toString()}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/**
 * What an author may set. `.strict()` on purpose: `status`, `createdBy`, `approvedBy` and
 * `bodySizeBytes` are not the author's to send, and a 400 naming them teaches that, where silently
 * dropping them would leave an author believing they had published something.
 */
export const TemplateDraftInputSchema = z
  .object({
    templateId: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .max(120),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    channel: z.enum(NOTIFICATION_CHANNELS),
    category: z.enum(CONTENT_CATEGORIES),
    content: TemplateContentSchema,
    variables: z.array(TemplateVariableSchema).max(64).default([]),
  })
  .strict();
export type TemplateDraftInput = z.infer<typeof TemplateDraftInputSchema>;

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: NotificationTemplateRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function hasAnyRole(roles: readonly string[], allowed: ReadonlySet<string> | undefined): boolean {
  if (allowed === undefined || allowed.size === 0) return false;
  return roles.some((r) => allowed.has(r));
}

export const TEMPLATE_GRANT_KINDS = ["author", "approver"] as const;
export type TemplateGrantKind = (typeof TEMPLATE_GRANT_KINDS)[number];

/**
 * What the caller may do, resolved from their identity.
 *
 * `actorId` is the principal's own user id and is required for every grant, not only for writes:
 * `created_by` and `approved_by` are UUID references to `meta.users`, so an unidentifiable caller
 * — a service api-key, say — cannot be an author or an approver. Refusing is the only honest
 * answer; attributing their draft to nobody would make four-eyes unenforceable afterwards.
 */
export interface TemplateGrant {
  readonly kind: TemplateGrantKind;
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];
}

export function resolveTemplateGrant(
  ctx: NotificationTemplateRoutesContext,
  principal: ResolvedPrincipal | null,
): TemplateGrant | null {
  if (principal === null) return null;
  const roles = rolesOf(ctx, principal);
  const isApprover = hasAnyRole(roles, ctx.approverRoles);
  if (!isApprover && !hasAnyRole(roles, ctx.authorRoles)) return null;
  const tenantId = principal.tenantId ?? "";
  if (!UUID_RE.test(tenantId)) return null;
  const actorId = principal.principalId;
  if (!UUID_RE.test(actorId)) return null;
  return { kind: isApprover ? "approver" : "author", tenantId, actorId, roles };
}

function requireGrant(
  ctx: NotificationTemplateRoutesContext,
  principal: ResolvedPrincipal | null,
  need: TemplateGrantKind,
): TemplateGrant | HandlerOutput {
  if (principal === null) return json(401, { error: "authentication_required" });
  const grant = resolveTemplateGrant(ctx, principal);
  if (grant === null) return json(403, { error: "forbidden", detail: "insufficient role" });
  if (need === "approver" && grant.kind !== "approver") {
    return json(403, { error: "forbidden", detail: "a template decision requires an approver role" });
  }
  return grant;
}

function isGrant(value: TemplateGrant | HandlerOutput): value is TemplateGrant {
  return "tenantId" in value;
}

/** 24 hex characters, inside the column CHECK's 8–32. */
function randomTemplateId(): string {
  return `ntpl_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function issuesOf(error: z.ZodError): readonly { path: string; message: string }[] {
  // Path + message only. A zod issue can echo the received value, and a response that quotes the
  // request back is a response that quotes whatever was in it.
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function buildCreateHandler(ctx: NotificationTemplateRoutesContext): Handler {
  return async ({ principal, parsedBody }) => {
    const grant = requireGrant(ctx, principal, "author");
    if (!isGrant(grant)) return grant;
    const parsed = TemplateDraftInputSchema.safeParse(parsedBody ?? {});
    if (!parsed.success) {
      return json(400, { error: "invalid_request", detail: issuesOf(parsed.error) });
    }
    const input = parsed.data;
    const refusals = validateTemplateContent({
      content: input.content,
      variables: input.variables,
      channel: input.channel,
      category: input.category,
      mayAuthorNonSuppressible: hasAnyRole(grant.roles, ctx.nonSuppressibleCategoryRoles),
    });
    if (refusals.length > 0) {
      return json(422, { error: "template_content_rejected", refusals });
    }
    const now = (ctx.clock ?? ((): Date => new Date()))();
    const candidate = NotificationTemplateSchema.safeParse({
      id: (ctx.newTemplateId ?? randomTemplateId)(),
      tenantId: grant.tenantId,
      templateId: input.templateId,
      version: input.version,
      locale: input.locale,
      channel: input.channel,
      category: input.category,
      // Every created template is a draft. There is no route that authors an approved one.
      status: "draft",
      content: input.content,
      variables: input.variables,
      bodySizeBytes: derivedBodySizeBytes(input.content),
      createdAt: now.toISOString(),
      createdBy: grant.actorId,
      approvedAt: null,
      approvedBy: null,
      deprecatedAt: null,
      supersededByTemplateId: null,
    });
    if (!candidate.success) {
      return json(400, { error: "invalid_request", detail: issuesOf(candidate.error) });
    }
    const created = await ctx.store.createDraft(grant.tenantId, candidate.data);
    if (created === null) {
      return json(409, {
        error: "template_version_exists",
        detail: `${input.templateId} ${input.channel} ${input.locale} ${input.version}`,
      });
    }
    return json(201, { template: created });
  };
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function queryOf(input: Parameters<Handler>[0]): Record<string, string | string[]> {
  return (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
}

function presentValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

const TEMPLATE_STATUS_VALUES: readonly string[] = TEMPLATE_STATUSES;

export function readTemplateListQuery(
  input: Parameters<Handler>[0],
): TemplateListQueryLike | { readonly error: string; readonly detail: string } {
  const query = queryOf(input);
  const statusRaw = presentValue(firstQueryValue(query["status"]));
  if (statusRaw !== undefined && !TEMPLATE_STATUS_VALUES.includes(statusRaw)) {
    return { error: "invalid_request", detail: `unknown status ${statusRaw}` };
  }
  const channel = presentValue(firstQueryValue(query["channel"]));
  if (channel !== undefined && !(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
    return { error: "invalid_request", detail: `unknown channel ${channel}` };
  }
  const limitRaw = presentValue(firstQueryValue(query["limit"]));
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && !Number.isFinite(limit)) {
    return { error: "invalid_request", detail: "unparseable limit" };
  }
  return {
    ...(statusRaw === undefined ? {} : { status: statusRaw as TemplateStatus }),
    ...(presentValue(firstQueryValue(query["templateId"])) === undefined
      ? {}
      : { templateId: firstQueryValue(query["templateId"]) as string }),
    ...(channel === undefined ? {} : { channel }),
    ...(limit === undefined ? {} : { limit }),
    ...(presentValue(firstQueryValue(query["cursor"])) === undefined
      ? {}
      : { cursor: firstQueryValue(query["cursor"]) as string }),
  };
}

function buildListHandler(ctx: NotificationTemplateRoutesContext): Handler {
  return async (input) => {
    const grant = requireGrant(ctx, input.principal, "author");
    if (!isGrant(grant)) return grant;
    const query = readTemplateListQuery(input);
    if ("error" in query) return json(400, query);
    let page: TemplateListPageLike;
    try {
      page = await ctx.store.list(grant.tenantId, query);
    } catch {
      // A rejected cursor and a row the contract no longer accepts arrive the same way. Both are
      // the caller's page being refused rather than silently shortened, which is the point of
      // re-parsing every row: a template edited into an impossible state must not vanish quietly.
      return json(400, { error: "template_page_unreadable" });
    }
    return json(200, { data: page.data, page: { nextCursor: page.nextCursor } });
  };
}

function buildGetHandler(ctx: NotificationTemplateRoutesContext): Handler {
  return async ({ principal, params }) => {
    const grant = requireGrant(ctx, principal, "author");
    if (!isGrant(grant)) return grant;
    const ntplId = params["ntplId"] ?? "";
    if (!NTPL_ID_RE.test(ntplId)) return json(404, { error: "template_not_found" });
    const template = await ctx.store.get(grant.tenantId, ntplId);
    if (template === null) return json(404, { error: "template_not_found", detail: ntplId });
    return json(200, { template });
  };
}

/**
 * One lifecycle move. `to` comes from the route, never from the body, so there is no request that
 * can ask for an arbitrary status — and `actorId` comes from the principal, so an approval cannot
 * be attributed to a colleague to get around four-eyes.
 */
function buildTransitionHandler(
  ctx: NotificationTemplateRoutesContext,
  to: TemplateStatus,
  need: TemplateGrantKind,
): Handler {
  return async ({ principal, params }) => {
    const grant = requireGrant(ctx, principal, need);
    if (!isGrant(grant)) return grant;
    const ntplId = params["ntplId"] ?? "";
    if (!NTPL_ID_RE.test(ntplId)) return json(404, { error: "template_not_found" });
    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    const outcome = await ctx.store.transition(grant.tenantId, ntplId, {
      to,
      actorId: grant.actorId,
      at,
    });
    switch (outcome.kind) {
      case "transitioned":
        return json(200, { template: outcome.template });
      case "not_found":
        return json(404, { error: "template_not_found", detail: ntplId });
      case "illegal_transition":
        return json(409, {
          error: "illegal_transition",
          detail: `${outcome.from} -> ${outcome.to}`,
        });
      case "four_eyes":
        // 403, not 409: the move is legal and this actor may not make it. A conflict would invite
        // a retry, and the only retry that works is a different person.
        return json(403, {
          error: "four_eyes_violation",
          detail: "a template's author cannot approve it",
        });
      case "conflict":
        return json(409, {
          error: "template_changed",
          detail: `no longer in ${outcome.from}`,
        });
    }
  };
}

interface TransitionRoute {
  readonly op: string;
  readonly segment: string;
  readonly to: TemplateStatus;
  readonly from: readonly TemplateStatus[];
  readonly need: TemplateGrantKind;
}

/**
 * The lifecycle surface, declared against `TEMPLATE_TRANSITIONS` rather than beside it. Each
 * route's `from`/`to` pair is checked for legality when the routes are built, so a route that
 * describes a transition the contract does not have fails at wiring time, not at request time.
 */
export const TEMPLATE_TRANSITION_ROUTES: readonly TransitionRoute[] = [
  {
    op: "notificationTemplates.submit",
    segment: "submit",
    to: "in_review",
    from: ["draft"],
    need: "author",
  },
  {
    op: "notificationTemplates.approve",
    segment: "approve",
    to: "approved",
    from: ["in_review"],
    need: "approver",
  },
  {
    op: "notificationTemplates.reject",
    segment: "reject",
    to: "draft",
    from: ["in_review"],
    need: "approver",
  },
  {
    op: "notificationTemplates.deprecate",
    segment: "deprecate",
    to: "deprecated",
    from: ["approved"],
    need: "approver",
  },
  {
    op: "notificationTemplates.retire",
    segment: "retire",
    to: "retired",
    from: ["draft", "in_review", "approved", "deprecated"],
    need: "approver",
  },
];

/**
 * The notification-template authoring routes to inject via the gateway's `extraRoutes` hook.
 *
 * Not under `/v1/platform`: a template belongs to the tenant that authors it, and the grant — not
 * the path — decides whether a caller may draft one, approve one, or neither.
 */
export function buildNotificationTemplateRoutes(
  ctx: NotificationTemplateRoutesContext,
): readonly ExtraGatewayRoute[] {
  for (const t of TEMPLATE_TRANSITION_ROUTES) {
    for (const from of t.from) {
      if (!canTransitionTemplate(from, t.to)) {
        throw new Error(`route ${t.op} declares an illegal transition ${from} -> ${t.to}`);
      }
    }
  }
  const v = (
    op: string,
    method: RouteDefinition["method"],
    segs: ReadonlyArray<string | { param: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, method, segs), handler });
  const base = ["v1", "notification-templates"];
  return [
    v("notificationTemplates.list", "GET", base, buildListHandler(ctx)),
    v("notificationTemplates.create", "POST", base, buildCreateHandler(ctx)),
    v(
      "notificationTemplates.get",
      "GET",
      [...base, { param: "ntplId" }],
      buildGetHandler(ctx),
    ),
    ...TEMPLATE_TRANSITION_ROUTES.map((t) =>
      v(
        t.op,
        "POST",
        [...base, { param: "ntplId" }, t.segment],
        buildTransitionHandler(ctx, t.to, t.need),
      ),
    ),
  ];
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string"
      ? { kind: "literal", value: s }
      : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}
