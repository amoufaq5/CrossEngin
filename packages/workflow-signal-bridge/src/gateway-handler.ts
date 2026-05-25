import { SIGNATURE_HEADER_NAME } from "@crossengin/sdk";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";

import type { WorkflowSignalBridge } from "./bridge.js";
import { bridgeStatusFor, isBridgeSuccess } from "./outcomes.js";

export interface CreateSignalBridgeHandlerOptions {
  readonly bridge: WorkflowSignalBridge;
  readonly signatureHeaderName?: string;
  readonly idempotencyHeaderName?: string;
  readonly sourceSystem?: string;
  readonly nowSeconds?: () => number;
}

const DEFAULT_IDEMPOTENCY_HEADER = "idempotency-key";

export function createSignalBridgeHandler(opts: CreateSignalBridgeHandlerOptions): Handler {
  const signatureHeader = (opts.signatureHeaderName ?? SIGNATURE_HEADER_NAME).toLowerCase();
  const idempotencyHeader = (
    opts.idempotencyHeaderName ?? DEFAULT_IDEMPOTENCY_HEADER
  ).toLowerCase();
  const clock = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return async (input: HandlerInput): Promise<HandlerOutput> => {
    const tenantId = input.principal?.tenantId ?? input.request.tenantHint ?? null;
    if (tenantId === null) {
      return {
        kind: "json",
        status: 400,
        body: {
          ok: false,
          reason: "tenant could not be resolved for signal bridge",
        },
      };
    }
    const signatureValue = pickHeader(input.request.headers, signatureHeader);
    if (signatureValue === null) {
      return {
        kind: "json",
        status: 401,
        body: {
          ok: false,
          reason: `missing ${signatureHeader} header`,
        },
      };
    }
    const bodyBytes = bodyBytesFromInput(input);
    const idempotencyKey = pickHeader(input.request.headers, idempotencyHeader);
    const outcome = await opts.bridge.handle({
      bodyBytes,
      signatureHeader: signatureValue,
      nowSeconds: clock(),
      tenantId,
      ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      ...(opts.sourceSystem !== undefined ? { sourceSystem: opts.sourceSystem } : {}),
    });
    const status = bridgeStatusFor(outcome.kind);
    return {
      kind: "json",
      status,
      body: {
        ok: isBridgeSuccess(outcome),
        outcome: outcome.kind,
        reason: outcome.reason,
        signalId: outcome.signalId,
        matchedInstanceIds: outcome.matchedInstanceIds,
        deduplicated: outcome.deduplicated,
      },
    };
  };
}

function pickHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  const lower = headers[name.toLowerCase()];
  if (typeof lower === "string") return lower;
  return null;
}

function bodyBytesFromInput(input: HandlerInput): Uint8Array | string {
  const parsed = input.parsedBody;
  if (parsed !== null) {
    return JSON.stringify(parsed);
  }
  return "";
}
