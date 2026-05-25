import { verifyWebhookDelivery, type SignedWebhookDelivery } from "@crossengin/sdk";

import type { CorrelationExtractor } from "./correlation.js";
import type { BridgeOutcome } from "./outcomes.js";
import type { SecretResolver } from "./secret-resolver.js";

export interface SignalSubmitter {
  submitSignal(input: {
    readonly signalName: string;
    readonly correlationKey: string;
    readonly tenantId: string;
    readonly payload?: Record<string, unknown>;
    readonly idempotencyKey?: string;
    readonly sourceSystem?: string;
  }): Promise<{
    readonly deduplicated: boolean;
    readonly matchedInstanceIds: readonly string[];
    readonly signalId: string | null;
  }>;
}

export interface BridgeHandleInput {
  readonly bodyBytes: Uint8Array | string;
  readonly signatureHeader: string;
  readonly nowSeconds: number;
  readonly tenantId: string;
  readonly sourceSystem?: string;
  readonly idempotencyKey?: string;
  readonly hint?: string;
}

export interface WorkflowSignalBridgeOptions {
  readonly engine: SignalSubmitter;
  readonly secretResolver: SecretResolver;
  readonly correlationExtractor: CorrelationExtractor;
  readonly signalName: string;
}

export class WorkflowSignalBridge {
  private readonly engine: SignalSubmitter;
  private readonly secretResolver: SecretResolver;
  private readonly correlationExtractor: CorrelationExtractor;
  private readonly signalName: string;

  constructor(opts: WorkflowSignalBridgeOptions) {
    if (opts.signalName.length === 0) {
      throw new Error("WorkflowSignalBridge requires a non-empty signalName");
    }
    this.engine = opts.engine;
    this.secretResolver = opts.secretResolver;
    this.correlationExtractor = opts.correlationExtractor;
    this.signalName = opts.signalName;
  }

  async handle(input: BridgeHandleInput): Promise<BridgeOutcome> {
    const secret = await this.secretResolver.resolve({
      tenantId: input.tenantId,
      sourceSystem: input.sourceSystem ?? null,
      hint: input.hint ?? null,
    });
    if (secret === null) {
      return outcome({
        kind: "secret_not_found",
        reason: `no webhook secret for tenant=${input.tenantId} source=${input.sourceSystem ?? "<unset>"}`,
      });
    }
    const verifyResult = verifyWebhookDelivery({
      secretBytes: secret.secretBytes,
      body: input.bodyBytes,
      signatureHeader: input.signatureHeader,
      opts: { nowSeconds: input.nowSeconds, toleranceSeconds: secret.toleranceSeconds },
    });
    if (!verifyResult.ok) {
      if (verifyResult.reason === "malformed_header") {
        return outcome({ kind: "signature_malformed", reason: "signature header is malformed" });
      }
      if (verifyResult.reason === "timestamp_outside_tolerance") {
        return outcome({
          kind: "timestamp_outside_tolerance",
          reason: `signature timestamp outside ±${secret.toleranceSeconds.toString()}s tolerance`,
        });
      }
      return outcome({ kind: "signature_invalid", reason: "signature does not verify" });
    }

    const bodyString =
      typeof input.bodyBytes === "string"
        ? input.bodyBytes
        : new TextDecoder().decode(input.bodyBytes);
    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(bodyString) as unknown;
      if (json === null || typeof json !== "object" || Array.isArray(json)) {
        return outcome({
          kind: "body_not_json",
          reason: "webhook body must parse as a JSON object",
        });
      }
      parsed = json as Record<string, unknown>;
    } catch (err) {
      return outcome({
        kind: "body_not_json",
        reason: err instanceof Error ? err.message : "webhook body is not valid JSON",
      });
    }

    const correlationKey = this.correlationExtractor.extract(parsed);
    if (correlationKey === null || correlationKey.length === 0) {
      return outcome({
        kind: "correlation_missing",
        reason: "correlation key extractor returned null or empty",
      });
    }

    try {
      const result = await this.engine.submitSignal({
        signalName: this.signalName,
        correlationKey,
        tenantId: input.tenantId,
        payload: parsed,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.sourceSystem !== undefined ? { sourceSystem: input.sourceSystem } : {}),
      });
      if (result.deduplicated) {
        return {
          kind: "deduplicated",
          reason: "signal already processed (exactly_once_idempotent dedup)",
          signalId: result.signalId,
          matchedInstanceIds: result.matchedInstanceIds,
          deduplicated: true,
        };
      }
      if (result.matchedInstanceIds.length === 0) {
        return {
          kind: "no_matching_instance",
          reason: `no running instance matched signal=${this.signalName} correlationKey=${correlationKey}`,
          signalId: result.signalId,
          matchedInstanceIds: [],
          deduplicated: false,
        };
      }
      return {
        kind: "advanced",
        reason: `signal delivered to ${result.matchedInstanceIds.length.toString()} instance(s)`,
        signalId: result.signalId,
        matchedInstanceIds: result.matchedInstanceIds,
        deduplicated: false,
      };
    } catch (err) {
      return outcome({
        kind: "engine_error",
        reason: err instanceof Error ? err.message : "workflow engine threw",
      });
    }
  }
}

function outcome(input: {
  readonly kind: BridgeOutcome["kind"];
  readonly reason: string;
}): BridgeOutcome {
  return {
    kind: input.kind,
    reason: input.reason,
    signalId: null,
    matchedInstanceIds: [],
    deduplicated: false,
  };
}

export type { SignedWebhookDelivery };
