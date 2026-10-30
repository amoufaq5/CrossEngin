import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

import {
  buildOpenApiDocument,
  OPENAPI_MEDIA_TYPE,
  type OpenApiEmit,
  type OpenApiEmitInput,
} from "./openapi.js";

export {
  OPENAPI_MEDIA_TYPE,
  OPENAPI_OPERATION_ID,
  OPENAPI_PATH,
  OPENAPI_PATH_SEGMENTS,
} from "./openapi.js";

// Spelled here as it is in `handlers.ts` and `ui-schema.ts`, which is this package's convention for
// a two-line response builder. Deliberate rather than overlooked: there is no *fact* in it that two
// copies could come to disagree about, which is the test the one-spelling rule applies.
function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

export interface OpenApiHandlerContext {
  /**
   * Assembles the emitter's input, called **at request time and not at compile time**.
   *
   * That is the whole of why this is a thunk. The document describes a route registry, and the
   * registry is still being filled when this handler is registered — `extraRoutes` land after it,
   * and on the shipped compose those are 38 of the 375 routes a request can reach. A snapshot taken
   * at registration would describe 337 of them and omit the rest *silently*, which is the
   * falsely-complete direction (ADR-0337) and is exactly the defect register P1.17 names from the
   * other end: it points at `CompiledOperateServer.routeSpecs`, a strict subset. A thunk closing
   * over the live registry makes registration order irrelevant by construction rather than by a
   * comment asking the next person to register this last.
   */
  readonly describe: () => OpenApiEmitInput;
}

/**
 * Serves this deployment's own API description.
 *
 * **Memoised on the first request**, which composes with the thunk above rather than fighting it:
 * by the time any request arrives, registration is complete, so one computation is both correct and
 * the only one. The measured cost settles it — 948.4 KiB of JSON over 338 routes and 155 schemas
 * for `erp-core`, and 1033.4 KiB for `erp-grocery`, the widest of the seven — so per-request assembly
 * would hand a poller a megabyte of work for a document that
 * cannot change while the process lives. A refusal is memoised too, because it is a property of the
 * route set and the route set is fixed.
 *
 * A principal is **required**, and the reason is a measured comparison rather than caution: the
 * document names entity and field names, which under per-tenant manifests (ADR-0314) is a tenant's
 * own business model — while `meta.schema.read`, which is registered beside it and already serves
 * every authenticated principal, discloses *strictly more* (its `UiEntityAccess` carries per-entity
 * role lists with no per-role filtering). So this is the weaker of two surfaces with one audience,
 * and treating it differently would be a distinction neither surface supports.
 *
 * The check is a **backstop** and is not claimed to be reachable: the gateway's auth stage refuses
 * an anonymous request two stages before `match_route` (`authenticate` is stage 5 and `match_route`
 * is stage 7), so on the real pipeline a handler never sees a null principal. An earlier draft said
 * "seven stages before", which transposed that stage's own 1-based ordinal into a distance. It is kept for `dischargeAbac`'s reason — a guard a path can no longer
 * reach is still the thing that makes the handler correct when called directly, which every test
 * and every future embedder does.
 *
 * A refusal answers **500 and not 503**: a template collision or a wildcard route is a permanent
 * property of this deployment's route set, and 503 invites a retry that cannot help (ADR-0359's
 * inverted mapping, one status over). The detail travels in the body, which is free here by
 * ADR-0367's own test — it names operation ids and a path template, both of which the document
 * itself publishes, so it carries no row, no value and no tenant.
 */
export function buildOpenApiHandler(ctx: OpenApiHandlerContext): Handler {
  let memo: OpenApiEmit | null = null;
  return ({ principal }): HandlerOutput => {
    if (principal === null) return json(401, { error: "credential_required" });
    memo ??= buildOpenApiDocument(ctx.describe());
    if (memo.refused !== null) {
      return json(500, {
        error: `openapi_${memo.refused.kind}`,
        detail: memo.refused.detail,
        operationIds: memo.refused.operationIds,
      });
    }
    return {
      kind: "json",
      status: 200,
      headers: { "content-type": OPENAPI_MEDIA_TYPE },
      body: memo.document,
    };
  };
}
