import { NOTIFICATION_CHANNELS, type NotificationChannel } from "@crossengin/notifications";

import type { StoreKind } from "./cli.js";
import { planRetry } from "./delivery-plan.js";
import { UNROUTED_ERROR_CODE, unroutedResult } from "./delivery-senders.js";

/**
 * Whether this deployment can deliver a notification on each channel — the question the old
 * `[notify] channels: …` line was read as answering and did not.
 *
 * That line listed the channels with a registered *sender*. A sender is only the last hop: a
 * message also needs something that writes a dispatch on its channel, a durable store to write it
 * into, and a drain to hand it to the sender. Measured with the workspace SQL scanner, there is one
 * `INSERT` into `meta.notification_dispatches` (`PostgresNotificationStore.record`) and its two
 * callers are a design-review decision, whose channel is the literal `in_app`, and the digest
 * summary, whose channel is copied from the dispatches it pools. So an operator who filled the SES
 * and Twilio variables read `[notify] channels: in_app, email, sms` and no email or SMS was ever
 * sent, because nothing could ask for one.
 *
 * Every input is required and none defaults (ADR-0413's rule: a survey that assumes its producers
 * are mounted prints the reassuring answer on exactly the deployment that does not mount them).
 */

/**
 * The code paths in this binary that *originate* a dispatch. The digest summary is not one: it
 * re-emits the channel of dispatches already written, so it can never put a message on a channel
 * nothing else reaches.
 */
export type DispatchProducer = "design_review_decision";

const PRODUCER_DESCRIPTION: Readonly<Record<DispatchProducer, string>> = {
  design_review_decision:
    "a design-review decision, mounted by --design-review or --require-design-review",
};

/** Total over the channels, so a seventh channel is a compile error here rather than a silence. */
const CHANNEL_DISPATCH_PRODUCERS: Readonly<
  Record<NotificationChannel, readonly DispatchProducer[]>
> = {
  in_app: ["design_review_decision"],
  email: [],
  sms: [],
  push_mobile: [],
  webhook: [],
  voice_call: [],
};

/**
 * Where the drain takes each channel's recipient address from (`addressFor` in
 * `delivery-drain.ts`, which this mirrors and which a test holds to it). `null` is the claim that
 * no address source exists: a recipient on that channel is recorded `dropped` with
 * `recipient_unaddressable` rather than handed to a provider. Before, sms and voice were handed the
 * recipient's email and push the user's id.
 */
export const CHANNEL_ADDRESS_SOURCE: Readonly<Record<NotificationChannel, string | null>> = {
  in_app: "the user id",
  email: "meta.users.email",
  sms: "meta.users.phone_e164",
  voice_call: "meta.users.phone_e164",
  push_mobile: null,
  webhook: null,
};

const NO_ADDRESS_REASON: Readonly<Record<NotificationChannel, string>> = {
  in_app: "",
  email: "",
  sms: "",
  voice_call: "",
  push_mobile: "no device-token table exists, so no push recipient has an address",
  webhook: "no per-recipient webhook endpoint is modelled",
};

export type NotificationChannelVerdict =
  | "delivers"
  | "no_durable_store"
  | "producer_unmounted"
  | "no_drain"
  | "produced_without_sender"
  | "registered_without_producer"
  | "not_registered";

/**
 * How loudly each verdict is said. `warn` is reserved for the two states an operator configured
 * into and cannot see from the sender list: a sender for a channel nothing produces, and a produced
 * channel with no sender. `no_drain` is info here because the drain-absence warning beside this
 * line already says it, and saying it twice at warn would make the two read as two faults.
 */
export const NOTIFICATION_CHANNEL_VERDICT_DISPOSITION: Readonly<
  Record<NotificationChannelVerdict, "silent" | "info" | "warn">
> = {
  delivers: "info",
  no_durable_store: "info",
  producer_unmounted: "info",
  no_drain: "info",
  produced_without_sender: "warn",
  registered_without_producer: "warn",
  not_registered: "silent",
};

const VERDICT_PHRASE: Readonly<Record<NotificationChannelVerdict, string>> = {
  delivers: "delivers to the recipients each audience resolves to",
  no_durable_store: "nothing is enqueued, because --store memory has no notification store",
  producer_unmounted: "nothing is enqueued, because its producer is not mounted",
  no_drain: "enqueued and never delivered, because no delivery drain is running",
  produced_without_sender: "produced with no sender registered",
  registered_without_producer: "sender registered, no producer in this binary",
  not_registered: "not registered",
};

export interface NotificationChannelSurveyInput {
  readonly registeredChannels: readonly NotificationChannel[];
  /** The empty set is the claim that nothing here writes a dispatch, not a default. */
  readonly mountedProducers: ReadonlySet<DispatchProducer>;
  readonly drainMounted: boolean;
  readonly storeKind: StoreKind;
}

export interface NotificationChannelReach {
  readonly channel: NotificationChannel;
  readonly verdict: NotificationChannelVerdict;
  /** Whether a sender is registered, which the verdict does not always say. */
  readonly registered: boolean;
}

export interface NotificationChannelSurvey {
  /** In `NOTIFICATION_CHANNELS` order, one per channel. */
  readonly channels: readonly NotificationChannelReach[];
}

function verdictFor(
  channel: NotificationChannel,
  input: NotificationChannelSurveyInput,
  registered: ReadonlySet<NotificationChannel>,
): NotificationChannelVerdict {
  const producers = CHANNEL_DISPATCH_PRODUCERS[channel];
  // Checked first because it is the one no configuration changes: a registered sender for a
  // channel nothing produces stays idle whatever the store, the drain or the flags say.
  if (producers.length === 0) {
    return registered.has(channel) ? "registered_without_producer" : "not_registered";
  }
  if (input.storeKind === "memory") return "no_durable_store";
  if (!producers.some((p) => input.mountedProducers.has(p))) return "producer_unmounted";
  if (!input.drainMounted) return "no_drain";
  if (!registered.has(channel)) return "produced_without_sender";
  return "delivers";
}

export function surveyNotificationChannels(
  input: NotificationChannelSurveyInput,
): NotificationChannelSurvey {
  const registered = new Set(input.registeredChannels);
  return {
    channels: NOTIFICATION_CHANNELS.map((channel) => ({
      channel,
      verdict: verdictFor(channel, input, registered),
      registered: registered.has(channel),
    })),
  };
}

/**
 * Seconds of backoff an unrouted delivery survives before the drain records it `dropped`, derived
 * from the drain's own retry planner at the defaults `node.ts` runs it with (it passes no
 * `maxAttempts`), so the figure in the boot line cannot drift from the ladder.
 */
function unroutedLifetimeSeconds(): number {
  const outcome = unroutedResult("email").outcome;
  const epoch = new Date(0);
  let total = 0;
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const retry = planRetry({ outcome, attemptNumber: attempt, now: epoch });
    if (!retry.shouldRetry || retry.nextRetryAt === null) return total;
    total += (Date.parse(retry.nextRetryAt) - epoch.getTime()) / 1000;
  }
  return total;
}

export interface NotificationSurveyLine {
  readonly level: "info" | "warn";
  readonly line: string;
}

export function formatNotificationChannelSurvey(
  survey: NotificationChannelSurvey,
): readonly NotificationSurveyLine[] {
  const shown = survey.channels.filter(
    (c) => NOTIFICATION_CHANNEL_VERDICT_DISPOSITION[c.verdict] !== "silent",
  );
  const groups = new Map<NotificationChannelVerdict, NotificationChannel[]>();
  for (const c of shown) groups.set(c.verdict, [...(groups.get(c.verdict) ?? []), c.channel]);
  const summary =
    groups.size === 0
      ? "no channel is produced or registered"
      : [...groups]
          .map(([verdict, chans]) => `${chans.join(", ")}: ${VERDICT_PHRASE[verdict]}`)
          .join("; ");
  const lines: NotificationSurveyLine[] = [
    { level: "info", line: `[notify] channels — ${summary}` },
  ];

  const unmounted = groups.get("producer_unmounted") ?? [];
  if (unmounted.length > 0) {
    const producers = [...new Set(unmounted.flatMap((c) => CHANNEL_DISPATCH_PRODUCERS[c]))].map(
      (p) => PRODUCER_DESCRIPTION[p],
    );
    lines.push({
      level: "info",
      line: `[notify] ${unmounted.join(", ")} is produced in this binary only by ${producers.join("; or ")}`,
    });
  }

  const idle = groups.get("registered_without_producer") ?? [];
  if (idle.length > 0) {
    const produced = NOTIFICATION_CHANNELS.filter((c) => CHANNEL_DISPATCH_PRODUCERS[c].length > 0);
    const reach =
      produced.length === 0
        ? "nothing in this binary writes a dispatch on any channel"
        : `every dispatch this binary writes is on ${produced.join(", ")}`;
    lines.push({
      level: "warn",
      line:
        `[notify] ${idle.join(", ")}: a sender is registered and no message will ever be sent on ` +
        `${idle.length === 1 ? "it" : "them"} — ${reach}. No flag or environment variable changes that.`,
    });
  }

  const unaddressable = survey.channels
    .filter((c) => c.registered && CHANNEL_ADDRESS_SOURCE[c.channel] === null)
    .map((c) => c.channel);
  if (unaddressable.length > 0) {
    lines.push({
      level: "warn",
      line:
        `[notify] ${unaddressable.join(", ")}: ` +
        unaddressable.map((c) => NO_ADDRESS_REASON[c]).join("; ") +
        " — a recipient there is recorded dropped (recipient_unaddressable), never sent.",
    });
  }

  const unsent = groups.get("produced_without_sender") ?? [];
  if (unsent.length > 0) {
    const seconds = unroutedLifetimeSeconds();
    lines.push({
      level: "warn",
      line:
        `[notify] ${unsent.join(", ")}: dispatches are produced and no sender is registered, so each ` +
        `delivery fails ${UNROUTED_ERROR_CODE}, is retried for about ${seconds.toString()}s of ` +
        "backoff and is then recorded dropped — a sender configured after that delivers none of it.",
    });
  }
  return lines;
}
