import type {
  DeliveryOutcome,
  NotificationChannel,
  ProviderKind,
} from "@crossengin/notifications";

export interface SendRequest {
  readonly dispatchId: string;
  readonly tenantId: string;
  readonly channel: NotificationChannel;
  readonly templateId: string;
  readonly locale: string;
  readonly recipientAddress: string;
  readonly attemptNumber: number;
}

export interface SendResult {
  readonly outcome: DeliveryOutcome;
  readonly provider: ProviderKind;
  readonly providerMessageId: string | null;
  readonly httpStatus: number | null;
  readonly bytesSent: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface ChannelSender {
  readonly channel: NotificationChannel;
  readonly provider: ProviderKind;
  send(request: SendRequest): Promise<SendResult>;
}

export const MAX_ERROR_MESSAGE_LENGTH = 500;

export const UNROUTED_ERROR_CODE = "no_sender_configured";
export const CHANNEL_MISMATCH_ERROR_CODE = "channel_mismatch";
export const SEND_TIMEOUT_ERROR_CODE = "send_timeout";
export const SENDER_THREW_ERROR_CODE = "sender_threw";

// The internal provider: nothing leaves the platform, so no vendor is implicated. It backs the
// in-app sender and the unrouted result, neither of which touches a third-party network.
const INTERNAL_PROVIDER: ProviderKind = "in_app_native";

export function truncateErrorMessage(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE_LENGTH
    ? message
    : message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function messageFromThrown(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return String(error);
}

export function unroutedResult(channel: NotificationChannel): SendResult {
  return {
    outcome: "failed",
    provider: INTERNAL_PROVIDER,
    providerMessageId: null,
    httpStatus: null,
    bytesSent: null,
    errorCode: UNROUTED_ERROR_CODE,
    errorMessage: truncateErrorMessage(
      `no sender configured for channel ${channel}`,
    ),
  };
}

export class UnroutableChannelSender implements ChannelSender {
  readonly channel: NotificationChannel;
  readonly provider: ProviderKind = INTERNAL_PROVIDER;

  constructor(channel: NotificationChannel) {
    this.channel = channel;
  }

  async send(request: SendRequest): Promise<SendResult> {
    return unroutedResult(request.channel);
  }
}

export class InAppSender implements ChannelSender {
  readonly channel: NotificationChannel = "in_app";
  readonly provider: ProviderKind = INTERNAL_PROVIDER;

  // An in-app notification IS the persisted dispatch row the tenant reads over
  // GET /v1/meta/notifications, so it is delivered by virtue of being persisted and readable.
  // There is no network hop to await and no provider to acknowledge it: this sender is a real
  // terminal sink, not a stub standing in for one.
  async send(request: SendRequest): Promise<SendResult> {
    if (request.channel !== "in_app") {
      return {
        outcome: "failed",
        provider: this.provider,
        providerMessageId: null,
        httpStatus: null,
        bytesSent: null,
        errorCode: CHANNEL_MISMATCH_ERROR_CODE,
        errorMessage: truncateErrorMessage(
          `in-app sender cannot send channel ${request.channel}`,
        ),
      };
    }
    return {
      outcome: "delivered",
      provider: this.provider,
      providerMessageId: request.dispatchId,
      httpStatus: null,
      bytesSent: null,
      errorCode: null,
      errorMessage: null,
    };
  }
}

export class SenderRegistry {
  private readonly senders = new Map<NotificationChannel, ChannelSender>();

  constructor(senders: readonly ChannelSender[] = []) {
    for (const sender of senders) this.register(sender);
  }

  register(sender: ChannelSender): void {
    this.senders.set(sender.channel, sender);
  }

  for(channel: NotificationChannel): ChannelSender | null {
    return this.senders.get(channel) ?? null;
  }

  channels(): readonly NotificationChannel[] {
    return [...this.senders.keys()];
  }
}

export function defaultSenderRegistry(): SenderRegistry {
  return new SenderRegistry([new InAppSender()]);
}

export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface SendTimer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_TIMER: SendTimer = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function timeoutResult(sender: ChannelSender, timeoutMs: number): SendResult {
  return {
    outcome: "failed",
    provider: sender.provider,
    providerMessageId: null,
    httpStatus: null,
    bytesSent: null,
    errorCode: SEND_TIMEOUT_ERROR_CODE,
    errorMessage: truncateErrorMessage(
      `sender for channel ${sender.channel} exceeded the ${timeoutMs}ms send budget`,
    ),
  };
}

function thrownResult(sender: ChannelSender, error: unknown): SendResult {
  return {
    outcome: "failed",
    provider: sender.provider,
    providerMessageId: null,
    httpStatus: null,
    bytesSent: null,
    errorCode: SENDER_THREW_ERROR_CODE,
    errorMessage: truncateErrorMessage(messageFromThrown(error)),
  };
}

export function sendWithTimeout(
  sender: ChannelSender,
  request: SendRequest,
  timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
  timer: SendTimer = SYSTEM_TIMER,
): Promise<SendResult> {
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const handle = timer.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(timeoutResult(sender, timeoutMs));
    }, timeoutMs);

    const settle = (result: SendResult): void => {
      if (settled) return;
      settled = true;
      timer.clearTimeout(handle);
      resolve(result);
    };

    try {
      void Promise.resolve(sender.send(request)).then(
        (result) => {
          settle(result);
        },
        (error: unknown) => {
          settle(thrownResult(sender, error));
        },
      );
    } catch (error) {
      settle(thrownResult(sender, error));
    }
  });
}
