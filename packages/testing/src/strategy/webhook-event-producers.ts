import { stripComments } from "./pg-column-coverage.js";
import type { WorkspaceSourceFile } from "./workspace-sql-scan.js";

/**
 * The rule: **every event `@crossengin/sdk` declares a webhook consumer can subscribe to has a
 * producer, or the declaration that says it has none is current.**
 *
 * `WEBHOOK_EVENTS` is an eighteen-member enum and the outbound-webhook tables are declared writerless
 * in `pg-storeless-tables.ts` with the consequence that none of the eighteen has a producer. That
 * sentence is a claim about the whole workspace, and a declared reason is checked for its shape and
 * never for its truth — so the census is taken here and the sentence is compared against it. A
 * producer literal appearing anywhere outside the declaration is the edit that makes the sentence
 * false, and it is the edit this fires on; a nineteenth event is the other one.
 *
 * `manifest-event-names.ts`' relationship between a declaration and its producer, one vocabulary
 * across, and read from disk as text for that rule's reason: `@crossengin/sdk` devDepends on this
 * package, so importing it would make the build graph cyclic.
 *
 * **What it cannot see**, stated so a zero is not read as more than it is: a name assembled at
 * runtime (`` `tenant.${verb}` ``), and any file outside a member's `src/` or not `.ts` — which is
 * `readWorkspaceSources`' reach, so `apps/operate-web` is outside it. A producer of a platform event
 * belongs on the server, which is inside it.
 */

/** The one file that may spell a declared event as a literal without producing it. */
export const WEBHOOK_EVENT_DECLARATION_FILE = "packages/sdk/src/webhooks.ts";

/**
 * Reads `WEBHOOK_EVENTS` out of the declaration's source text. **Throws** rather than answering an
 * empty list, because an empty declared set makes every census vacuously clean.
 */
export function readDeclaredWebhookEvents(source: string): readonly string[] {
  const code = stripComments(source);
  const match = /export const WEBHOOK_EVENTS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(code);
  if (match === null) {
    throw new Error(
      `${WEBHOOK_EVENT_DECLARATION_FILE}: WEBHOOK_EVENTS is no longer an 'as const' array literal`,
    );
  }
  const events = [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  if (events.length === 0) {
    throw new Error(`${WEBHOOK_EVENT_DECLARATION_FILE}: WEBHOOK_EVENTS parsed to no members`);
  }
  return events;
}

export interface WebhookEventProducerSite {
  readonly event: string;
  readonly file: string;
}

export interface WebhookEventCensus {
  readonly declared: readonly string[];
  /** Every quoted occurrence of a declared event outside the declaration file. */
  readonly sites: readonly WebhookEventProducerSite[];
  /** The declared events with at least one site, in declaration order. */
  readonly produced: readonly string[];
}

function quotedLiteral(event: string): RegExp {
  const escaped = event.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(["'\`])${escaped}\\1`);
}

/**
 * Counts, per declared event, the non-declaration files that spell it as a quoted literal.
 *
 * Comments are stripped first so a doc comment naming an event is not a producer. A string that
 * merely *mentions* one inside longer text is not counted either: a producer passes the name itself.
 */
export function censusWebhookEventProducers(
  declared: readonly string[],
  files: readonly WorkspaceSourceFile[],
): WebhookEventCensus {
  const sites: WebhookEventProducerSite[] = [];
  const patterns = declared.map((event) => ({ event, pattern: quotedLiteral(event) }));
  for (const source of files) {
    if (source.file === WEBHOOK_EVENT_DECLARATION_FILE) continue;
    const code = stripComments(source.text);
    for (const { event, pattern } of patterns) {
      if (pattern.test(code)) sites.push({ event, file: source.file });
    }
  }
  const producedSet = new Set(sites.map((s) => s.event));
  return { declared, sites, produced: declared.filter((e) => producedSet.has(e)) };
}

/**
 * Reads the `<produced> of the <declared> declared WEBHOOK_EVENTS` figure out of a declared
 * consequence, so the census can be compared against the sentence rather than against a copy of it.
 * `null` when the sentence carries no such figure.
 */
export function statedWebhookEventFigure(
  consequence: string,
): { readonly produced: number; readonly declared: number } | null {
  const match = /(\d+) of the (\d+) declared WEBHOOK_EVENTS/.exec(consequence);
  if (match === null) return null;
  return { produced: Number(match[1]), declared: Number(match[2]) };
}
