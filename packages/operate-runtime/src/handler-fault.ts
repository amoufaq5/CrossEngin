import { ListRowUnreadable } from "./store.js";

/**
 * Where a handler puts the cause of a failure whose response body deliberately names none.
 *
 * `writeTxn` answers an unclassified write failure with a fixed `500 write_failed` body, because
 * the exception on that path is a database error naming tables, constraints and tenant ids nobody
 * chose to disclose (`tenant_data_keys_tenant_id_fkey` once reached a client that way). Its comment
 * then said the cause was "in the process log" — and nothing wrote it there: a handler that
 * *returns* a 500 is not a handler that throws, so the gateway's `onInternalError` never ran and
 * the cause was dropped. Measured live: a forced `23503` answered the fixed body and the log held
 * nothing at all for the request id the caller held. This is the seam that closes it.
 *
 * Two kinds and not one, because the second failure that answers a fixed body is a **read**: a
 * list page holding a row the store cannot represent (`ListRowUnreadable`). Naming the seam for
 * writes would have made that one either a second seam or a misnomer.
 */
export const HANDLER_FAULT_KINDS = ["write_failed", "page_unreadable"] as const;
export type HandlerFaultKind = (typeof HANDLER_FAULT_KINDS)[number];

export interface HandlerFault {
  readonly kind: HandlerFaultKind;
  readonly operationId: string;
  readonly entity: string;
  /** The id the gateway gave the request, which the caller holds in `x-request-id`. */
  readonly requestId: string;
  readonly error: unknown;
}

/**
 * **Required** on the handler context. An optional reporter defaulting to *say nothing* is the
 * defect restated as a default (ADR-0364's addendum), and it is the exact silence this exists to
 * end. A reporter must not throw; `reportHandlerFault` swallows one so a failing log cannot turn a
 * 500 into a lost response.
 */
export type HandlerFaultReporter = (fault: HandlerFault) => void;

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_MESSAGE_CHARS = 500;

/** Renders a zod path the way `kernel-pg`'s `unreadableDetail` does: keys joined by `.`. */
function zodIssuePath(path: readonly (string | number)[]): string {
  return path.length === 0 ? "<root>" : path.map((p) => String(p)).join(".");
}

function isZodLike(err: unknown): err is { readonly issues: readonly { path: (string | number)[]; code: string }[] } {
  return (
    err instanceof Error &&
    err.name === "ZodError" &&
    Array.isArray((err as { readonly issues?: unknown }).issues)
  );
}

/**
 * One operator-facing line describing what failed — **without the value that failed it**.
 *
 * The redaction is by error *shape*, because each shape carries the value in a different place:
 *
 * - A **`ZodError`**'s message is the JSON of its issues, and an `invalid_enum_value` issue carries
 *   `received`, which is the stored or submitted value. So it is reduced to field path and issue
 *   code, sorted and de-duplicated — `kernel-pg`'s `unreadableDetail` rule (ADR-0373), restated
 *   because this package cannot depend on `kernel-pg`. Detected by name rather than `instanceof`,
 *   so a `ZodError` from another copy of zod is still recognised.
 * - A **Postgres error** (a five-character SQLSTATE in `code`) carries values in `message` for the
 *   data-exception class (`invalid input syntax for type uuid: "…"`) and in `detail` for every key
 *   violation (`Key (tenant_id, id)=(…)`). Neither is printed; the structured fields are — SQLSTATE,
 *   constraint, table, column — which are names a schema chose, and are what an operator needs to
 *   find the cause. A `23503` therefore names its constraint, which is the measured case.
 * - A **`ListRowUnreadable`** names the refused rows' ids and each refusal's path and code; its rows
 *   were built from `UnreadableListRow`, which carries no value by construction.
 * - Anything else is code-authored (`RangeError: Invalid time value`, a guard's own throw) and its
 *   `name: message` is printed, bounded.
 */
export function describeHandlerFault(fault: HandlerFault): string {
  const head = `${fault.kind} ${fault.operationId} ${fault.entity}`;
  return `${head}: ${describeFaultError(fault.error)}`;
}

export function describeFaultError(err: unknown): string {
  if (err instanceof ListRowUnreadable) {
    const rows = err.rows.map((r) => `${r.identity ?? "<no id>"} (${r.detail})`).join("; ");
    return `ListRowUnreadable: ${err.rows.length.toString()} row(s) of '${err.entity}' refused: ${rows}`;
  }
  if (isZodLike(err)) {
    const issues = [...new Set(err.issues.map((i) => `${zodIssuePath(i.path)}: ${i.code}`))].sort();
    return `ZodError: ${issues.length === 0 ? "unparseable" : issues.join(", ")}`;
  }
  const code = (err as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && SQLSTATE.test(code)) {
    const fields = ["constraint", "table", "column", "schema"]
      .map((k) => [k, (err as Record<string, unknown>)[k]] as const)
      .filter((kv): kv is readonly [string, string] => typeof kv[1] === "string" && kv[1].length > 0)
      .map(([k, v]) => `${k}=${v}`);
    const name = err instanceof Error ? err.name : "error";
    return [`${name} sqlstate=${code}`, ...fields].join(" ");
  }
  if (err instanceof Error) {
    const line = `${err.name}: ${err.message}`;
    return line.length > MAX_MESSAGE_CHARS ? `${line.slice(0, MAX_MESSAGE_CHARS)}…` : line;
  }
  return `non_error_thrown (${typeof err})`;
}

/** Calls a reporter and swallows its own failure: a log that cannot be written must not lose the response. */
export function reportHandlerFault(reporter: HandlerFaultReporter, fault: HandlerFault): void {
  try {
    reporter(fault);
  } catch {
    // Deliberately empty; see above.
  }
}

/**
 * The reporter `compileOperateServer` installs when the deployment supplies no `onInternalError`:
 * one `console.error` line in the gateway's own `[5xx] <requestId>` shape, so an operator greps one
 * request id and finds both kinds of 500.
 */
export const consoleHandlerFaultReporter: HandlerFaultReporter = (fault) => {
  console.error(`[5xx] ${fault.requestId} ${describeHandlerFault(fault)}`);
};

/**
 * The error a fault is handed to the gateway's `onInternalError` as.
 *
 * That reporter prints `err.stack ?? err.message`, and the original error's stack begins with its
 * message — for a `ZodError` the very JSON this module exists to keep out of the log. So the fault
 * travels as a new error whose message is the redacted line and whose `stack` is that line alone,
 * which is also the honest stack: the frames of a handler that *returned* a 500 say nothing about
 * where the cause was raised.
 */
export class HandlerFaultReport extends Error {
  readonly fault: HandlerFault;

  constructor(fault: HandlerFault) {
    super(describeHandlerFault(fault));
    this.name = "HandlerFault";
    this.fault = fault;
    this.stack = `${this.name}: ${this.message}`;
  }
}

/**
 * Adapts the gateway's `onInternalError` into a fault reporter — `dispatch_handler` is the stage the
 * handler ran in, and `"500"` is what the caller was answered — or the console fallback without one.
 */
export function handlerFaultReporterFrom(
  onInternalError:
    | ((err: unknown, at: { readonly requestId: string; readonly stage: "dispatch_handler"; readonly answered: "500" }) => void)
    | undefined,
): HandlerFaultReporter {
  if (onInternalError === undefined) return consoleHandlerFaultReporter;
  return (fault) =>
    onInternalError(new HandlerFaultReport(fault), {
      requestId: fault.requestId,
      stage: "dispatch_handler",
      answered: "500",
    });
}
