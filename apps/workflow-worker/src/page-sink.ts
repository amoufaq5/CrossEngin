import type { Severity } from "@crossengin/incident-response";
import type { PageDirective } from "@crossengin/observability-runtime";

/** Why a page is being delivered: the incident was just declared, or its severity rose. */
export type PageReason = "declared" | "escalated";

export interface PageContext {
  readonly incidentId: string;
  readonly severity: Severity;
  readonly reason: PageReason;
}

/**
 * Delivers a resolved `PageDirective` to on-call. The real transport (PagerDuty /
 * Opsgenie / Slack) implements this seam; `LoggingPageDeliverer` is the default a
 * deployment without a wired transport gets. The monitor produces the directives
 * (from the alert policy at the current severity); this delivers them.
 */
export interface PageDeliverer {
  deliver(directive: PageDirective, context: PageContext): void | Promise<void>;
}

/** A single human-readable line describing a page directive + its delivery reason. */
export function formatPageLine(directive: PageDirective, context: PageContext): string {
  const channels = directive.channels.map((c) => c.kind).join(", ");
  return `[workflow-worker] PAGE (${context.reason}) ${context.incidentId} ${directive.severity}/${directive.alertSeverity} → ${channels.length > 0 ? channels : "(no channels)"}`;
}

/** Default `PageDeliverer` — writes one line per directive to a sink (stdout by default). */
export class LoggingPageDeliverer implements PageDeliverer {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`)) {
    this.write = write;
  }

  deliver(directive: PageDirective, context: PageContext): void {
    this.write(formatPageLine(directive, context));
  }
}

/** Delivers every directive resolved for one incident lifecycle event, in order. */
export async function deliverPages(
  deliverer: PageDeliverer,
  directives: readonly PageDirective[],
  context: PageContext,
): Promise<void> {
  for (const directive of directives) {
    await deliverer.deliver(directive, context);
  }
}
