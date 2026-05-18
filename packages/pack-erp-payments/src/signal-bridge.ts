import {
  FieldPathExtractor,
  WorkflowSignalBridge,
  type CorrelationExtractor,
  type SecretResolver,
  type SignalSubmitter,
  type WorkflowSignalBridgeOptions,
} from "@crossengin/workflow-signal-bridge";

export class FirstMatchingPathExtractor implements CorrelationExtractor {
  private readonly extractors: readonly CorrelationExtractor[];

  constructor(paths: readonly string[]) {
    if (paths.length === 0) {
      throw new Error("FirstMatchingPathExtractor requires at least one path");
    }
    this.extractors = paths.map((p) => new FieldPathExtractor(p));
  }

  extract(body: Record<string, unknown>): string | null {
    for (const extractor of this.extractors) {
      const value = extractor.extract(body);
      if (value !== null && value.length > 0) return value;
    }
    return null;
  }
}

export const PAYMENT_SIGNAL_NAMES = {
  CAPTURED: "payment.captured",
  SETTLED: "payment.settled",
  REFUNDED: "payment.refunded",
  FAILED: "payment.failed",
  CANCELLED: "payment.cancelled",
} as const;

export type PaymentSignalName =
  (typeof PAYMENT_SIGNAL_NAMES)[keyof typeof PAYMENT_SIGNAL_NAMES];

export const PROVIDER_EVENT_SIGNAL_MAP: Readonly<Record<string, PaymentSignalName>> = {
  "payment_intent.succeeded": PAYMENT_SIGNAL_NAMES.CAPTURED,
  "payment_intent.payment_failed": PAYMENT_SIGNAL_NAMES.FAILED,
  "payment_intent.canceled": PAYMENT_SIGNAL_NAMES.CANCELLED,
  "charge.succeeded": PAYMENT_SIGNAL_NAMES.CAPTURED,
  "charge.refunded": PAYMENT_SIGNAL_NAMES.REFUNDED,
  "charge.failed": PAYMENT_SIGNAL_NAMES.FAILED,
  AUTHORISATION: PAYMENT_SIGNAL_NAMES.CAPTURED,
  CAPTURE: PAYMENT_SIGNAL_NAMES.CAPTURED,
  SETTLEMENT: PAYMENT_SIGNAL_NAMES.SETTLED,
  REFUND: PAYMENT_SIGNAL_NAMES.REFUNDED,
  CANCELLATION: PAYMENT_SIGNAL_NAMES.CANCELLED,
};

export function resolvePaymentSignalForEvent(
  eventType: string,
): PaymentSignalName | null {
  return PROVIDER_EVENT_SIGNAL_MAP[eventType] ?? null;
}

export function paymentReferenceExtractor(): CorrelationExtractor {
  return new FirstMatchingPathExtractor([
    "data.object.id",
    "data.object.payment_intent",
    "pspReference",
    "transaction.id",
    "provider_reference",
  ]);
}

export interface BuildPaymentSignalBridgeOptions
  extends Omit<WorkflowSignalBridgeOptions, "correlationExtractor" | "signalName"> {
  readonly signalName?: PaymentSignalName;
}

export function buildPaymentSignalBridge(
  opts: BuildPaymentSignalBridgeOptions,
): WorkflowSignalBridge {
  return new WorkflowSignalBridge({
    engine: opts.engine,
    secretResolver: opts.secretResolver,
    correlationExtractor: paymentReferenceExtractor(),
    signalName: opts.signalName ?? PAYMENT_SIGNAL_NAMES.CAPTURED,
  });
}

export interface BuildPaymentBridgesByEventOptions {
  readonly engine: SignalSubmitter;
  readonly secretResolver: SecretResolver;
}

export function buildPaymentBridgesByEvent(
  opts: BuildPaymentBridgesByEventOptions,
): Readonly<Record<string, WorkflowSignalBridge>> {
  const bridges: Record<string, WorkflowSignalBridge> = {};
  for (const [eventType, signalName] of Object.entries(PROVIDER_EVENT_SIGNAL_MAP)) {
    bridges[eventType] = buildPaymentSignalBridge({
      engine: opts.engine,
      secretResolver: opts.secretResolver,
      signalName,
    });
  }
  return bridges;
}
