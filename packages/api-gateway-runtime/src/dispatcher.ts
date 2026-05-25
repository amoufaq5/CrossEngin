import type { IncomingRequest, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";

import {
  type OutgoingResponse,
  outgoingResponseFromJson,
  emptyOutgoingResponse,
} from "./adapters.js";

export interface HandlerInput {
  readonly request: IncomingRequest;
  readonly route: RouteDefinition;
  readonly principal: ResolvedPrincipal | null;
  readonly params: Readonly<Record<string, string>>;
  readonly parsedBody: Record<string, unknown> | null;
}

export type HandlerOutput =
  | {
      readonly kind: "json";
      readonly status: number;
      readonly headers?: Record<string, string>;
      readonly body: unknown;
    }
  | { readonly kind: "empty"; readonly status: number; readonly headers?: Record<string, string> }
  | {
      readonly kind: "bytes";
      readonly status: number;
      readonly headers?: Record<string, string>;
      readonly bodyBytes: Uint8Array;
    };

export type Handler = (input: HandlerInput) => Promise<HandlerOutput> | HandlerOutput;

export class HandlerRegistry {
  private readonly handlers: Map<string, Handler> = new Map();

  register(operationId: string, handler: Handler): this {
    this.handlers.set(operationId, handler);
    return this;
  }

  resolve(operationId: string): Handler | null {
    return this.handlers.get(operationId) ?? null;
  }

  has(operationId: string): boolean {
    return this.handlers.has(operationId);
  }

  size(): number {
    return this.handlers.size;
  }
}

export function handlerOutputToResponse(output: HandlerOutput): OutgoingResponse {
  switch (output.kind) {
    case "json":
      return outgoingResponseFromJson({
        status: output.status,
        headers: output.headers,
        body: output.body,
      });
    case "empty":
      return emptyOutgoingResponse(output.status, output.headers ?? {});
    case "bytes": {
      const headers = { ...(output.headers ?? {}) };
      headers["content-length"] = output.bodyBytes.byteLength.toString();
      return { status: output.status, headers, bodyBytes: output.bodyBytes };
    }
  }
}

export function notImplementedHandler(): Handler {
  return ({ route }) => ({
    kind: "json",
    status: 501,
    body: { error: "not_implemented", operationId: route.operationId },
  });
}
