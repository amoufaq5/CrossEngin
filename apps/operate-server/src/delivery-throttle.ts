import { sha256 } from "@crossengin/crypto";
import {
  DIGEST_FREQUENCIES,
  QuietHoursConfigSchema,
  decideQuietHoursAction,
  type ContentCategory,
  type DigestBatch,
  type DigestFrequency,
  type NotificationChannel,
  type PriorityLevel,
  type QuietHoursConfig,
} from "@crossengin/notifications";
import { z } from "zod";

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MIN_DIGEST_MAX_ITEMS = 1;
export const MAX_DIGEST_MAX_ITEMS = 1000;

export const DIGEST_WINDOW_MINUTES: Readonly<
  Record<DigestFrequency, number | null>
> = {
  immediate: null,
  every_15_minutes: 15,
  hourly: 60,
  daily: DAY_MINUTES,
  weekly: DAY_MINUTES * 7,
  never: null,
};

export interface NotificationPolicy {
  readonly quietHours: QuietHoursConfig | null;
  readonly digestFrequency: DigestFrequency;
  readonly digestMaxItems: number;
}

export const NotificationPolicySchema = z.object({
  quietHours: QuietHoursConfigSchema.nullable(),
  digestFrequency: z.enum(DIGEST_FREQUENCIES),
  digestMaxItems: z
    .number()
    .int()
    .min(MIN_DIGEST_MAX_ITEMS)
    .max(MAX_DIGEST_MAX_ITEMS),
});

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  quietHours: null,
  digestFrequency: "immediate",
  digestMaxItems: 50,
};

const DigestFrequencySchema = z.enum(DIGEST_FREQUENCIES);
const DigestMaxItemsSchema = z
  .number()
  .int()
  .min(MIN_DIGEST_MAX_ITEMS)
  .max(MAX_DIGEST_MAX_ITEMS);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseNotificationPolicy(raw: unknown): NotificationPolicy {
  if (!isPlainObject(raw)) return DEFAULT_NOTIFICATION_POLICY;

  // INVARIANT: policy parsing is fail-open-to-no-policy. Tenant settings are an
  // untrusted JSONB document, so anything malformed degrades to "no quiet hours"
  // rather than throwing or inventing a window that would silently drop notices.
  const quiet = QuietHoursConfigSchema.safeParse(raw.quietHours);
  const quietHours = quiet.success ? quiet.data : null;

  let digestFrequency = DEFAULT_NOTIFICATION_POLICY.digestFrequency;
  let digestMaxItems = DEFAULT_NOTIFICATION_POLICY.digestMaxItems;
  if (isPlainObject(raw.digest)) {
    const frequency = DigestFrequencySchema.safeParse(raw.digest.frequency);
    if (frequency.success) digestFrequency = frequency.data;
    const maxItems = DigestMaxItemsSchema.safeParse(raw.digest.maxItems);
    if (maxItems.success) digestMaxItems = maxItems.data;
  }

  return { quietHours, digestFrequency, digestMaxItems };
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

const buildFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTER_CACHE.get(timezone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = buildFormatter(timezone);
  } catch {
    formatter = buildFormatter("UTC");
  }
  FORMATTER_CACHE.set(timezone, formatter);
  return formatter;
}

export function localMinutesSinceMidnight(now: Date, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(now);
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number.parseInt(part.value, 10);
    else if (part.type === "minute") minute = Number.parseInt(part.value, 10);
  }
  if (!Number.isFinite(hour)) hour = 0;
  if (!Number.isFinite(minute)) minute = 0;
  return (hour % 24) * 60 + minute;
}

function hhmmToMinutes(hhmm: string): number {
  if (!HHMM.test(hhmm)) {
    throw new Error(`expected a HH:MM time of day, got ${hhmm}`);
  }
  return (
    Number.parseInt(hhmm.slice(0, 2), 10) * 60 + Number.parseInt(hhmm.slice(3, 5), 10)
  );
}

export function isBatchableFrequency(frequency: DigestFrequency): boolean {
  return DIGEST_WINDOW_MINUTES[frequency] !== null;
}

export function nextDigestDispatchAt(
  frequency: DigestFrequency,
  now: Date,
): string {
  const windowMinutes = DIGEST_WINDOW_MINUTES[frequency];
  if (windowMinutes === null) {
    throw new Error(
      `digest frequency ${frequency} is not batchable; gate on isBatchableFrequency before scheduling a digest window`,
    );
  }
  return new Date(now.getTime() + windowMinutes * MINUTE_MS).toISOString();
}

export interface DigestWindow {
  readonly windowStart: string;
  readonly scheduledDispatchAt: string;
}

/**
 * The window is quantized to a fixed grid, not measured from `now` — `digestIdFor` derives the
 * digest id from its start, so two notices arriving a minute apart must land on the same boundary
 * or each would open its own pool instead of joining one.
 */
export function digestWindowFor(frequency: DigestFrequency, now: Date): DigestWindow {
  const windowMinutes = DIGEST_WINDOW_MINUTES[frequency];
  if (windowMinutes === null) {
    throw new Error(
      `digest frequency ${frequency} is not batchable; gate on isBatchableFrequency before scheduling a digest window`,
    );
  }
  const windowMs = windowMinutes * MINUTE_MS;
  const startMs = Math.floor(now.getTime() / windowMs) * windowMs;
  return {
    windowStart: new Date(startMs).toISOString(),
    scheduledDispatchAt: new Date(startMs + windowMs).toISOString(),
  };
}

export function nextQuietHoursEnd(config: QuietHoursConfig, now: Date): string {
  const target = hhmmToMinutes(config.endTime);
  const baseMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const current = localMinutesSinceMidnight(new Date(baseMs), config.timezone);
  const delta = (target - current + DAY_MINUTES) % DAY_MINUTES;
  const candidate = new Date(
    baseMs + (delta === 0 ? DAY_MINUTES : delta) * MINUTE_MS,
  );
  if (
    candidate.getTime() > now.getTime() &&
    localMinutesSinceMidnight(candidate, config.timezone) === target
  ) {
    return candidate.toISOString();
  }

  // INVARIANT: a DST shift in the configured zone can move the wall clock so the
  // minute arithmetic above overshoots or repeats endTime; walk the zone forward
  // minute by minute instead of trusting a fixed offset.
  for (let step = 1; step <= DAY_MINUTES * 2 + 180; step += 1) {
    const probe = new Date(baseMs + step * MINUTE_MS);
    if (probe.getTime() <= now.getTime()) continue;
    if (localMinutesSinceMidnight(probe, config.timezone) === target) {
      return probe.toISOString();
    }
  }

  throw new Error(
    `unable to resolve the next occurrence of ${config.endTime} in ${config.timezone}`,
  );
}

export interface ThrottleDecision {
  readonly action: "send_now" | "defer" | "batch" | "drop";
  readonly reason: string;
  /** When a deferred/batched notice should be retried. Null for send_now and drop. */
  readonly releaseAt: string | null;
}

export function decideThrottle(input: {
  readonly policy: NotificationPolicy;
  readonly category: ContentCategory;
  readonly priority: PriorityLevel;
  readonly now: Date;
}): ThrottleDecision {
  const config = input.policy.quietHours;
  if (config === null) {
    const open = decideQuietHoursAction({
      config: null,
      category: input.category,
      priority: input.priority,
      localMinutesSinceMidnight: 0,
    });
    return { action: open.action, reason: open.reason, releaseAt: null };
  }

  const decision = decideQuietHoursAction({
    config,
    category: input.category,
    priority: input.priority,
    localMinutesSinceMidnight: localMinutesSinceMidnight(
      input.now,
      config.timezone,
    ),
  });

  switch (decision.action) {
    case "send_now":
    case "drop":
      return {
        action: decision.action,
        reason: decision.reason,
        releaseAt: null,
      };
    case "defer":
      return {
        action: "defer",
        reason: decision.reason,
        releaseAt: nextQuietHoursEnd(config, input.now),
      };
    case "batch":
      return {
        action: "batch",
        reason: decision.reason,
        releaseAt: isBatchableFrequency(input.policy.digestFrequency)
          ? nextDigestDispatchAt(input.policy.digestFrequency, input.now)
          : nextQuietHoursEnd(config, input.now),
      };
  }
}

export function digestIdFor(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly channel: NotificationChannel;
  readonly frequency: DigestFrequency;
  readonly windowStart: string;
}): string {
  const digest = sha256(
    [
      input.tenantId,
      input.userId,
      input.channel,
      input.frequency,
      input.windowStart,
    ].join("|"),
  );
  return `dgst_${digest.slice(0, 32)}`;
}

export function buildDigestBatch(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly channel: NotificationChannel;
  readonly frequency: DigestFrequency;
  readonly openedAt: string;
  readonly scheduledDispatchAt: string;
  readonly maxItems: number;
  readonly itemCount?: number;
}): DigestBatch {
  if (!isBatchableFrequency(input.frequency)) {
    throw new Error(
      `cannot open a digest batch at frequency ${input.frequency}; only batchable frequencies carry a digest window`,
    );
  }
  return {
    id: digestIdFor({
      tenantId: input.tenantId,
      userId: input.userId,
      channel: input.channel,
      frequency: input.frequency,
      windowStart: input.openedAt,
    }),
    tenantId: input.tenantId,
    userId: input.userId,
    channel: input.channel,
    frequency: input.frequency,
    status: "open",
    openedAt: input.openedAt,
    scheduledDispatchAt: input.scheduledDispatchAt,
    assembledAt: null,
    dispatchedAt: null,
    itemCount: input.itemCount ?? 0,
    maxItems: input.maxItems,
    dedupSha256: null,
  };
}
