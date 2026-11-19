import {
  renderTemplateContent,
  type NotificationChannel,
  type NotificationDispatch,
  type NotificationTemplate,
} from "@crossengin/notifications";

import type { DispatchContent } from "./delivery-senders.js";

/**
 * What a provider is asked to send for one dispatch, or why it is sent the provider's own
 * identifier-only notice instead.
 *
 * The rendering is `renderTemplateContent`'s, so the escaping is per channel by construction: an
 * email's HTML body has its values markup-escaped and its plaintext body has them raw, an SMS body is
 * plain, and a voice notice uses the template's plain fallback text because the voice sender escapes
 * what it is given into TwiML itself (rendering the SSML body here would escape it twice).
 */
export type DispatchContentResolution =
  | { readonly kind: "rendered"; readonly content: DispatchContent }
  | { readonly kind: "not_rendered"; readonly reason: DispatchContentAbsence };

/**
 * `variables_not_persisted` is the one that matters and it is a fact about the ledger rather than
 * about any template: `meta.notification_dispatches` keeps `variables_sha256` and never the
 * variables, so a template with a placeholder cannot be rendered at delivery time by anything. A
 * template whose body names no placeholder renders; one that does is declined rather than sent
 * with blanks where the values belong.
 */
export const DISPATCH_CONTENT_ABSENCES = [
  "channel_not_rendered_here",
  "no_approved_template",
  "variables_not_persisted",
  "template_unreadable",
] as const;
export type DispatchContentAbsence = (typeof DISPATCH_CONTENT_ABSENCES)[number];

/**
 * Which channels take content from a template here. Push is `false` because a push payload may not
 * vary with the notification's content (ADR-0310): it renders on a lock screen through Google's and
 * Apple's servers. In-app is `false` because the console renders the notice itself from the dispatch,
 * and webhook has no addressable recipient (`addressFor` answers `null`).
 */
export const CHANNEL_TAKES_RENDERED_CONTENT: Readonly<Record<NotificationChannel, boolean>> = {
  email: true,
  sms: true,
  voice_call: true,
  push_mobile: false,
  in_app: false,
  webhook: false,
};

export interface ApprovedTemplateLookup {
  find(
    tenantId: string,
    query: { readonly templateId: string; readonly locale: string; readonly channel: string },
  ): Promise<NotificationTemplate | null>;
}

export type DispatchContentSource = (
  dispatch: NotificationDispatch,
) => Promise<DispatchContentResolution>;

const absent = (reason: DispatchContentAbsence): DispatchContentResolution => ({
  kind: "not_rendered",
  reason,
});

export function templateContentSource(templates: ApprovedTemplateLookup): DispatchContentSource {
  return async (dispatch) => {
    if (!CHANNEL_TAKES_RENDERED_CONTENT[dispatch.channel]) {
      return absent("channel_not_rendered_here");
    }
    let template: NotificationTemplate | null;
    try {
      template = await templates.find(dispatch.tenantId, {
        templateId: dispatch.templateId,
        locale: dispatch.locale,
        channel: dispatch.channel,
      });
    } catch {
      return absent("template_unreadable");
    }
    if (template === null || template.content.channel !== dispatch.channel) {
      return absent("no_approved_template");
    }
    const { rendered, missing } = renderTemplateContent(template.content, {
      variables: {},
      locale: dispatch.locale,
    });
    if (missing.length > 0) return absent("variables_not_persisted");
    switch (rendered.channel) {
      case "email":
        return {
          kind: "rendered",
          content: { subject: rendered.title, body: rendered.plainBody ?? "", htmlBody: rendered.body },
        };
      case "sms":
        return { kind: "rendered", content: { subject: "", body: rendered.body, htmlBody: null } };
      case "voice_call":
        return {
          kind: "rendered",
          content: { subject: "", body: rendered.plainBody ?? "", htmlBody: null },
        };
      default:
        return absent("channel_not_rendered_here");
    }
  };
}
