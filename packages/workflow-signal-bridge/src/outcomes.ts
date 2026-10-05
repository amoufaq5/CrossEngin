export const BRIDGE_OUTCOME_KINDS = [
  "advanced",
  "deduplicated",
  "no_matching_instance",
  "secret_not_found",
  "signature_invalid",
  "timestamp_outside_tolerance",
  "signature_malformed",
  "body_not_json",
  "correlation_missing",
  "engine_error",
] as const;
export type BridgeOutcomeKind = (typeof BRIDGE_OUTCOME_KINDS)[number];

export const BRIDGE_SUCCESS_KINDS: ReadonlySet<BridgeOutcomeKind> = new Set([
  "advanced",
  "deduplicated",
  "no_matching_instance",
]);

export const BRIDGE_AUTH_FAILURE_KINDS: ReadonlySet<BridgeOutcomeKind> = new Set([
  "secret_not_found",
  "signature_invalid",
  "timestamp_outside_tolerance",
  "signature_malformed",
]);

export const BRIDGE_CLIENT_ERROR_KINDS: ReadonlySet<BridgeOutcomeKind> = new Set([
  "body_not_json",
  "correlation_missing",
]);

/** One instance the signal reached, with the signal id recorded for *that* instance. */
export interface BridgeSignalDelivery {
  readonly instanceId: string;
  readonly signalId: string;
}

export interface BridgeOutcome {
  readonly kind: BridgeOutcomeKind;
  readonly reason: string;
  /**
   * Replaces the single `signalId` this carried. A submit that correlates to N instances records N
   * signals — one per instance, each with its own id — so one id was either a lie about the other
   * N-1 or an arbitrary pick among them. A caller that wants the pre-fan-out handle has the
   * `Idempotency-Key` it sent, which is now stored on every one of these rows.
   */
  readonly deliveries: readonly BridgeSignalDelivery[];
  readonly matchedInstanceIds: readonly string[];
  readonly deduplicated: boolean;
}

export function bridgeStatusFor(kind: BridgeOutcomeKind): number {
  if (BRIDGE_SUCCESS_KINDS.has(kind)) return 202;
  if (BRIDGE_AUTH_FAILURE_KINDS.has(kind)) return 401;
  if (BRIDGE_CLIENT_ERROR_KINDS.has(kind)) return 400;
  if (kind === "engine_error") return 503;
  return 500;
}

export function isBridgeSuccess(outcome: BridgeOutcome): boolean {
  return BRIDGE_SUCCESS_KINDS.has(outcome.kind);
}
