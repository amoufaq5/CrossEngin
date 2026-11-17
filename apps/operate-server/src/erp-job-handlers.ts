import { resolvedFieldNames } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel";
import {
  approveClassTransitions,
  isApproveClassTransition,
  parseDecimal,
  ReadCeilingExceeded,
  type EntityRecord,
  type ListFilter,
  type SettingsStore,
  type SystemEntityAccess,
  type SystemWriteResult,
  type TenantEntityAccess,
} from "@crossengin/operate-runtime";
import type { JobHandlerContext, JobHandlerProvider, JobHandlerResult } from "@crossengin/workflow-runtime-pg";

/**
 * Real handlers for the `erp-core` job declarations whose work the shipped entities can express,
 * and the stated reason for every one they cannot.
 *
 * **Every write goes through the gateway's own handlers**, never the store: a job holds a
 * `TenantEntityAccess` from `@crossengin/operate-runtime`'s system writer, which dispatches to the
 * very handler a request is served by. So the double-entry guard refuses an unbalanced depreciation
 * entry, the document locks hold, a state moves only by a transition, the recognition GL posting a
 * transition triggers is posted, and the audit row is written in the write's own transaction —
 * filed under the job run, naming no person. Authority is the deployment's `--job-actor-role`,
 * checked against the manifest's grants like any principal's.
 *
 * Every handler is **idempotent by a marker on the record it writes**, because the queue retries a
 * failed run and a re-run of a half-finished one must finish it rather than repeat it: a
 * depreciation entry's memo, an invoice's notes, a stock movement's reference, a reorder PO's notes.
 */

/** Rows one read may return before the run refuses rather than act on a prefix (ADR-0367). */
export const JOB_READ_CEILING = 20_000;

/** Why a declared job has no handler in this binary. */
export interface JobHandlerAbsence {
  readonly jobId: string;
  readonly reason: string;
}

/**
 * The `erp-core` declarations this binary deliberately serves with no handler, each with the fact
 * that decides it. Written down so the boot line can say *why* rather than only *that*, and so a
 * handler is never added for one of them by someone reading "unserved" as "unfinished".
 */
export const ERP_JOB_ABSENCES: Readonly<Record<string, string>> = Object.freeze({
  "erp-core-payment-gateway-sync":
    "polls a payment gateway (Stripe/Adyen) for settled transactions; no gateway reconciliation client exists in this repository",
  "erp-core-bank-statement-import":
    "imports bank statement lines from a banking integration (Plaid/MT940); no banking client exists in this repository",
  "erp-core-fx-rate-refresh":
    "pulls rates from an external rates provider; no rates client exists in this repository",
  "erp-core-shipment-tracking-sync":
    "polls carrier APIs (FedEx/DHL/UPS); no carrier client exists in this repository",
  "erp-core-tax-calculation":
    "calls an external tax engine (Avalara/TaxJar); no tax-engine client exists in this repository",
  "erp-core-einvoice-submission":
    "submits to a clearance portal (Peppol/ZATCA/SAT); no clearance client exists in this repository, and its event name has no producer",
  "erp-core-crm-lead-enrichment":
    "calls a firmographics provider (Clearbit/ZoomInfo); no enrichment client exists in this repository",
  "erp-core-payroll-disbursement":
    "pushes disbursements to a payroll/banking provider; no such client exists, the pack declares no Payroll entity, and its event name has no producer",
  "erp-core-payment-received-handler":
    "its work — applying a payment to the invoice it names and marking the invoice paid once covered — is already done in the same transaction as the Payment write by paymentApplicationEffect, so a handler would apply every payment twice; its event name also has no producer",
});

type Operation = { readonly entity: string; readonly transition: string };

interface HandlerRequirements {
  /** Entity → the fields the handler reads or writes on it. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
  /** Lifecycle transitions the handler fires. */
  readonly transitions: readonly Operation[];
  /** Entities whose records the handler creates, which a person may later have to approve. */
  readonly creates: readonly string[];
}

/** What a handler in this module actually performs, where its declaration promises more. */
const PARTIAL_COVERAGE: Readonly<Record<string, string>> = Object.freeze({
  "erp-core-overdue-invoice-reminder":
    "moves past-due invoices to 'overdue'; the reminder email its description promises is NOT sent — an account's billing_email is not a notification recipient and no channel addresses it",
  "erp-core-depreciation-run":
    "posts straight-line depreciation only; an asset declared declining_balance or units_of_production is counted and skipped, and the run refuses until the tenant's depreciationExpenseAccountCode and accumulatedDepreciationAccountCode settings name real accounts",
  "erp-core-work-order-completion":
    "writes the issue and receipt stock movements, which move each StockLevel and post at standard cost against the inventory variance account (there is no work-in-progress account); a component issue that would take stock below zero is refused unless the tenant's inventory.allowNegativeStock is set, and the finished good is then not received until a later run consumes it, and an item with no standard_cost moves quantity and posts nothing",
});

const REQUIREMENTS: Readonly<Record<string, HandlerRequirements>> = Object.freeze({
  "erp-core-overdue-invoice-reminder": {
    fields: { Invoice: ["state", "due_date"] },
    transitions: [{ entity: "Invoice", transition: "mark_overdue" }],
    creates: [],
  },
  "erp-core-depreciation-run": {
    fields: {
      FixedAsset: [
        "state",
        "acquisition_date",
        "acquisition_cost",
        "depreciation_method",
        "useful_life_months",
        "salvage_value",
      ],
      JournalEntry: ["entry_date", "source", "memo", "state"],
      JournalLine: ["journal_entry_id", "ledger_account_id", "debit", "credit", "currency", "description"],
      LedgerAccount: ["account_code"],
    },
    transitions: [{ entity: "JournalEntry", transition: "post" }],
    creates: ["JournalEntry", "JournalLine"],
  },
  "erp-core-inventory-reorder": {
    fields: {
      Item: ["status", "reorder_point", "reorder_quantity", "name"],
      StockLevel: ["item_id", "quantity_on_hand", "quantity_reserved", "quantity_incoming"],
      PurchaseOrder: ["vendor_id", "state", "order_date", "currency", "notes", "subtotal", "total"],
      PurchaseOrderLine: ["purchase_order_id", "item_id", "quantity", "unit_price", "received_quantity", "line_total"],
    },
    transitions: [],
    creates: ["PurchaseOrder", "PurchaseOrderLine"],
  },
  "erp-core-sales-order-to-invoice": {
    fields: {
      SalesOrder: ["account_id", "state", "currency", "tax_total"],
      SalesOrderLine: ["sales_order_id", "description", "quantity", "fulfilled_quantity", "unit_price"],
      Invoice: ["account_id", "currency", "issue_date", "subtotal", "tax_total", "total", "notes"],
      InvoiceLine: ["invoice_id", "position", "description", "quantity", "unit_price", "line_total"],
    },
    transitions: [{ entity: "SalesOrder", transition: "invoice" }],
    creates: ["Invoice", "InvoiceLine"],
  },
  "erp-core-work-order-completion": {
    fields: {
      WorkOrder: ["state", "item_id", "bom_id", "warehouse_id", "completed_quantity"],
      BillOfMaterials: ["output_quantity"],
      BomLine: ["bom_id", "component_item_id", "quantity", "scrap_pct"],
      StockMovement: ["item_id", "warehouse_id", "movement_type", "quantity", "reference", "reason", "occurred_at"],
    },
    transitions: [],
    creates: ["StockMovement"],
  },
});

/** Which declarations of this manifest this binary will serve, and why each other one is not. */
export interface ErpJobCoverage {
  readonly handled: readonly string[];
  readonly declined: readonly JobHandlerAbsence[];
  /** Served declarations whose handler does less than the declaration's description says. */
  readonly partial: readonly JobHandlerAbsence[];
  readonly actorRoles: readonly string[];
}

export interface ErpJobCoverageOptions {
  /**
   * `--segregation-of-duties`. Required, because it decides what a job may finish: a record a job
   * writes has no recorded creator (a job names no person), and `makerCheckerRefusal` answers
   * `maker_checker_unverifiable` for such a record **whoever fires the approve-class transition** —
   * the job, and every person after it. A draft left "for a person to post" could never be posted.
   */
  readonly segregationOfDuties: boolean;
}

/**
 * Pure: decided from the manifest and the actor roles alone, so it can be asked before anything is
 * compiled and gives one answer on every replica of one deployment — which is what lets the
 * producers enqueue only what this binary serves without starving a worker tier.
 *
 * A requirement is checked over the resolved field set and the lifecycle transitions, so a pack
 * that replaces `WorkOrder` with one lacking `completed_quantity` (`erp-construction` does) declines
 * the handler by name instead of failing every run with a 422.
 */
export function erpJobCoverage(
  manifest: Manifest,
  actorRoles: readonly string[],
  options: ErpJobCoverageOptions,
): ErpJobCoverage {
  const approveClass = options.segregationOfDuties ? approveClassTransitions(manifest) : [];
  const declared = new Set(Object.keys(manifest.jobs ?? {}));
  const handled: string[] = [];
  const declined: JobHandlerAbsence[] = [];
  const partial: JobHandlerAbsence[] = [];
  const roleNames = new Set(Object.keys(manifest.roles ?? {}));
  const undeclaredRole = actorRoles.filter((r) => !roleNames.has(r));
  for (const jobId of [...declared].sort()) {
    const absence = ERP_JOB_ABSENCES[jobId];
    if (absence !== undefined) {
      declined.push({ jobId, reason: absence });
      continue;
    }
    const requirements = REQUIREMENTS[jobId];
    if (requirements === undefined) continue;
    if (actorRoles.length === 0 || undeclaredRole.length === actorRoles.length) {
      declined.push({
        jobId,
        reason: `--job-actor-role names no role this manifest declares (${actorRoles.join(", ") || "none"}), so no write a job made could be authorized`,
      });
      continue;
    }
    const missing = missingRequirements(manifest, requirements);
    if (missing.length > 0) {
      declined.push({ jobId, reason: `this manifest does not declare ${missing.join(", ")}` });
      continue;
    }
    if (options.segregationOfDuties) {
      const fired = requirements.transitions.filter((t) => isApproveClassTransition(t.entity, t.transition));
      if (fired.length > 0) {
        declined.push({
          jobId,
          reason:
            `--segregation-of-duties refuses ${fired.map((t) => `${t.entity}.${t.transition}`).join(", ")} to a job:` +
            " a job names no person, and what it would draft would record no creator, which the maker-checker" +
            " rule refuses for every person afterwards too (maker_checker_unverifiable) — so nothing is drafted",
        });
        continue;
      }
    }
    handled.push(jobId);
    const notes: string[] = [];
    const note = PARTIAL_COVERAGE[jobId];
    if (note !== undefined) notes.push(note);
    const unapprovable = approveClass.filter((q) => requirements.creates.includes(q.slice(0, q.indexOf("."))));
    if (unapprovable.length > 0) {
      notes.push(
        `under --segregation-of-duties the records it creates name no creator, so ${unapprovable.join(", ")}` +
          " refuses them for every person (maker_checker_unverifiable); a person must re-enter one to approve it",
      );
    }
    if (notes.length > 0) partial.push({ jobId, reason: notes.join("; ") });
  }
  return { handled, declined, partial, actorRoles };
}

function missingRequirements(manifest: Manifest, req: HandlerRequirements): string[] {
  const missing: string[] = [];
  const byName = new Map((manifest.entities ?? []).map((e) => [e.name, e]));
  for (const [entity, fields] of Object.entries(req.fields)) {
    const decl = byName.get(entity);
    if (decl === undefined) {
      missing.push(`entity ${entity}`);
      continue;
    }
    const names = resolvedFieldNames(decl, manifest.traits ?? []);
    for (const f of fields) if (!names.has(f)) missing.push(`${entity}.${f}`);
  }
  for (const { entity, transition } of req.transitions) {
    const found = Object.values(manifest.workflows ?? {}).some(
      (wf) => wf.kind === "entityLifecycle" && wf.entity === entity && wf.transitions.some((t) => t.name === transition),
    );
    if (!found) missing.push(`transition ${entity}.${transition}`);
  }
  return missing;
}

/** Where a run finds its tenant's entity layer: the deployment's gateway, or the tenant's own. */
export type JobAccessResolution =
  | { readonly kind: "access"; readonly access: SystemEntityAccess }
  | { readonly kind: "unavailable"; readonly reason: string; readonly retryable: boolean };

export type JobAccessResolver = (tenantId: string) => Promise<JobAccessResolution>;

export interface ErpJobProvidersInput {
  readonly coverage: ErpJobCoverage;
  /**
   * Asked per run, because a tenant serving its own activated manifest is served by its own
   * compiled gateway (ADR-0314): a job writing through the deployment's would write that tenant's
   * rows under another manifest's grants and guards.
   */
  readonly resolveAccess: JobAccessResolver;
  readonly settings: SettingsStore;
  readonly now?: () => Date;
}

interface Run {
  readonly ctx: JobHandlerContext;
  readonly access: TenantEntityAccess;
  readonly at: Date;
  readonly settings: SettingsStore;
  readonly tally: Tally;
}

/** A sweep's outcome per record, so one refused record does not stop the others being written. */
class Tally {
  readonly counts: Record<string, number> = {};
  readonly refused: { readonly where: string; readonly status: number; readonly error: string }[] = [];

  count(key: string, n = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + n;
  }

  refuse(where: string, r: Extract<SystemWriteResult, { kind: "refused" }>): void {
    this.refused.push({ where, status: r.status, error: r.error });
  }
}

type Impl = (run: Run) => Promise<JobHandlerResult | null>;

const IMPLEMENTATIONS: Readonly<Record<string, Impl>> = Object.freeze({
  "erp-core-overdue-invoice-reminder": overdueInvoices,
  "erp-core-depreciation-run": depreciationRun,
  "erp-core-inventory-reorder": inventoryReorder,
  "erp-core-sales-order-to-invoice": salesOrderToInvoice,
  "erp-core-work-order-completion": workOrderCompletion,
});

/** The job ids this module has an implementation for — the domain `erpJobCoverage` decides over. */
export const ERP_JOB_HANDLER_IDS: readonly string[] = Object.freeze(Object.keys(IMPLEMENTATIONS).sort());

export function buildErpJobProviders(input: ErpJobProvidersInput): readonly JobHandlerProvider[] {
  const now = input.now ?? (() => new Date());
  return input.coverage.handled.map((jobId): JobHandlerProvider => {
    const impl = IMPLEMENTATIONS[jobId];
    if (impl === undefined) throw new Error(`no implementation for covered job ${jobId}`);
    return {
      serves: "job",
      jobId,
      handler: async (ctx) => {
        let resolved: JobAccessResolution;
        try {
          resolved = await input.resolveAccess(ctx.tenantId);
        } catch {
          return failed("tenant_gateway_unresolved", "the tenant's gateway could not be resolved", true);
        }
        if (resolved.kind === "unavailable") {
          return failed("tenant_gateway_unavailable", resolved.reason, resolved.retryable);
        }
        const access = resolved.access.forTenant(ctx.tenantId, {
          roles: input.coverage.actorRoles,
          origin: { kind: "job", jobId: ctx.jobDefinitionId, runId: ctx.runId },
        });
        const tally = new Tally();
        try {
          const early = await impl({ ctx, access, at: fireTime(ctx, now), settings: input.settings, tally });
          return early ?? conclude(tally);
        } catch (err) {
          // A ceiling is a property of the tenant's data and will be there next attempt too, so it
          // is a non-retryable failure rather than a throw — a throw leaves the run pending and
          // re-claimed for ever, re-reading the same 20,000 rows every poll.
          if (err instanceof ReadCeilingExceeded) {
            return failed("read_ceiling_exceeded", err.message, false);
          }
          throw err;
        }
      },
    };
  });
}

function failed(code: string, message: string, retryable: boolean): JobHandlerResult {
  return { status: "failed", error: { code, message }, retryable };
}

/**
 * A sweep that wrote what it could and was refused on some records fails, naming each refusal by
 * record and code — never by value. A refusal at 5xx is retried; a 4xx is a fact about the data
 * that a retry would meet again. The writes that landed stay landed and the markers make the retry
 * skip them.
 */
function conclude(tally: Tally): JobHandlerResult {
  if (tally.refused.length === 0) return { status: "completed", output: tally.counts };
  const transient = tally.refused.some((r) => r.status >= 500);
  const shown = tally.refused
    .slice(0, 5)
    .map((r) => `${r.where} ${r.status.toString()} ${r.error}`)
    .join("; ");
  const more = tally.refused.length > 5 ? ` (+${(tally.refused.length - 5).toString()} more)` : "";
  return failed(
    transient ? "writes_failed" : "writes_refused",
    `${tally.refused.length.toString()} write(s) refused: ${shown}${more}; done: ${JSON.stringify(tally.counts)}`,
    transient,
  );
}

function fireTime(ctx: JobHandlerContext, now: () => Date): Date {
  const trigger = ctx.trigger;
  if (trigger !== null && typeof trigger === "object") {
    const fireAt = (trigger as { fireAt?: unknown }).fireAt;
    if (typeof fireAt === "string") {
      const t = new Date(fireAt);
      if (!Number.isNaN(t.getTime())) return t;
    }
  }
  return now();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function str(r: EntityRecord | null | undefined, field: string): string | null {
  const v = r?.[field];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A decimal at `scale` as integer units, rounded half away from zero; null when not a numeral. */
export function units(value: unknown, scale: number): bigint | null {
  if (value === null || value === undefined) return null;
  const d = parseDecimal(value);
  if (d === null) return null;
  let u = d.units;
  if (d.scale < scale) u = u * 10n ** BigInt(scale - d.scale);
  else if (d.scale > scale) u = divRound(u, 10n ** BigInt(d.scale - scale));
  return d.negative ? -u : u;
}

/** `a / b` for non-negative `a` and positive `b`, rounded half away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b) * 2n >= b ? q + 1n : q;
}

/** `a * b`, each at its own scale, rounded to `scale`. */
function mul(a: bigint, aScale: number, b: bigint, bScale: number, scale: number): bigint {
  const raw = a * b;
  const from = aScale + bScale;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const r = from > scale ? divRound(abs, 10n ** BigInt(from - scale)) : abs * 10n ** BigInt(scale - from);
  return negative ? -r : r;
}

export function renderUnits(u: bigint, scale: number): string {
  const negative = u < 0n;
  const text = (negative ? -u : u).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? text : `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  return negative ? `-${body}` : body;
}

function aborted(run: Run): JobHandlerResult | null {
  return run.ctx.signal.aborted ? failed("cancelled", "the run was cancelled while it ran", false) : null;
}

async function readAll(run: Run, entity: string, filters: readonly ListFilter[], computing: string) {
  return run.access.readAll(entity, { filters }, { ceiling: JOB_READ_CEILING, computing });
}

// ---- overdue invoices ---------------------------------------------------------------------------

async function overdueInvoices(run: Run): Promise<JobHandlerResult | null> {
  const today = isoDate(run.at);
  const due = await readAll(
    run,
    "Invoice",
    [
      { field: "state", value: "sent" },
      { field: "due_date", op: "lt", value: today },
    ],
    "the invoices past their due date",
  );
  for (const inv of due) {
    const stop = aborted(run);
    if (stop !== null) return stop;
    const id = str(inv, "id");
    if (id === null) continue;
    const r = await run.access.transition("Invoice", id, "mark_overdue");
    if (r.kind === "written") run.tally.count("marked_overdue");
    else if (r.status === 409) run.tally.count("moved_by_someone_else");
    else run.tally.refuse(`Invoice ${id} mark_overdue`, r);
  }
  run.tally.count("examined", due.length);
  return null;
}

// ---- depreciation -------------------------------------------------------------------------------

/** The month before the fire month, as `YYYY-MM`, and its last day. */
export function depreciationPeriod(at: Date): { readonly key: string; readonly year: number; readonly month: number; readonly endDate: string } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth(); // 0-based: the previous month is m, 1-based
  const year = m === 0 ? y - 1 : y;
  const month = m === 0 ? 12 : m;
  const endDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { key: `${year.toString()}-${String(month).padStart(2, "0")}`, year, month, endDate };
}

/**
 * One period's straight-line charge, in units at scale 2, or null when the asset is not
 * depreciating in that period.
 *
 * The convention is the first full month: an asset acquired in March is first charged for April,
 * and charged for exactly `life` months. Each month carries `round(depreciable / life)` and the last
 * carries the remainder, so the charges sum to the depreciable amount exactly — rounding is not
 * allowed to leave a cent on the books or take one too many.
 */
export function straightLineCharge(input: {
  readonly acquisitionDate: string;
  readonly cost: bigint;
  readonly salvage: bigint;
  readonly lifeMonths: number;
  readonly year: number;
  readonly month: number;
}): bigint | null {
  const acq = /^(\d{4})-(\d{2})-\d{2}$/.exec(input.acquisitionDate);
  if (acq === null || input.lifeMonths <= 0) return null;
  const k = input.year * 12 + input.month - (Number(acq[1]) * 12 + Number(acq[2]));
  if (k < 1 || k > input.lifeMonths) return null;
  const depreciable = input.cost - input.salvage;
  if (depreciable <= 0n) return null;
  const life = BigInt(input.lifeMonths);
  const monthly = divRound(depreciable, life);
  const before = monthly * BigInt(k - 1);
  const remaining = depreciable - before;
  const charge = k === input.lifeMonths ? remaining : monthly < remaining ? monthly : remaining;
  return charge > 0n ? charge : null;
}

const DEPRECIATING_STATES = new Set(["in_service", "under_maintenance"]);

async function depreciationRun(run: Run): Promise<JobHandlerResult | null> {
  const period = depreciationPeriod(run.at);
  const assets = await readAll(run, "FixedAsset", [], "the fixed assets to depreciate");
  const charges: { readonly asset: EntityRecord; readonly amount: bigint }[] = [];
  for (const asset of assets) {
    if (!DEPRECIATING_STATES.has(str(asset, "state") ?? "")) continue;
    const method = str(asset, "depreciation_method") ?? "straight_line";
    if (method === "none") continue;
    if (method !== "straight_line") {
      run.tally.count(`method_unsupported_${method}`);
      continue;
    }
    const cost = units(asset["acquisition_cost"], 2);
    const life = asset["useful_life_months"];
    const acquired = str(asset, "acquisition_date");
    if (cost === null || typeof life !== "number" || acquired === null) {
      run.tally.count("missing_depreciation_basis");
      continue;
    }
    const amount = straightLineCharge({
      acquisitionDate: acquired,
      cost,
      salvage: units(asset["salvage_value"], 2) ?? 0n,
      lifeMonths: life,
      year: period.year,
      month: period.month,
    });
    if (amount !== null) charges.push({ asset, amount });
  }
  run.tally.count("charges_due", charges.length);
  if (charges.length === 0) return null;

  const settings = await run.settings.get(run.access.tenantId);
  const expenseCode = settings.finance?.depreciationExpenseAccountCode;
  const accumulatedCode = settings.finance?.accumulatedDepreciationAccountCode;
  const expense = expenseCode === undefined ? null : await accountId(run, expenseCode);
  const accumulated = accumulatedCode === undefined ? null : await accountId(run, accumulatedCode);
  if (expense === null || accumulated === null) {
    return failed(
      "depreciation_accounts_unconfigured",
      `${charges.length.toString()} asset(s) are due a charge for ${period.key} and the tenant's finance settings` +
        " do not name both depreciationExpenseAccountCode and accumulatedDepreciationAccountCode as existing" +
        " LedgerAccount codes; nothing was posted",
      false,
    );
  }
  const currency = settings.defaults?.currency;

  const existing = await readAll(
    run,
    "JournalEntry",
    [
      { field: "source", value: "depreciation" },
      { field: "entry_date", value: period.endDate },
    ],
    "this period's depreciation entries",
  );
  const byMarker = new Map<string, EntityRecord>();
  for (const je of existing) {
    const memo = str(je, "memo");
    const m = memo === null ? null : /\[depreciation:[^\]]+\]/.exec(memo);
    if (m !== null) byMarker.set(m[0], je);
  }

  for (const { asset, amount } of charges) {
    const stop = aborted(run);
    if (stop !== null) return stop;
    const assetId = str(asset, "id") as string;
    const marker = `[depreciation:${assetId}:${period.key}]`;
    let entry: EntityRecord | null = byMarker.get(marker) ?? null;
    if (entry !== null && str(entry, "state") !== "draft") {
      run.tally.count("already_posted");
      continue;
    }
    if (entry === null) {
      const created = await run.access.create("JournalEntry", {
        entry_date: period.endDate,
        source: "depreciation",
        memo: `Depreciation ${period.key} — ${str(asset, "name") ?? str(asset, "asset_tag") ?? assetId} ${marker}`,
      });
      if (created.kind !== "written" || created.record === null) {
        if (created.kind === "refused") run.tally.refuse(`FixedAsset ${assetId} entry`, created);
        continue;
      }
      entry = created.record;
    }
    const entryId = str(entry, "id") as string;
    const lines = await readAll(
      run,
      "JournalLine",
      [{ field: "journal_entry_id", value: entryId }],
      "a depreciation entry's lines",
    );
    const has = new Set(lines.map((l) => str(l, "ledger_account_id")));
    const value = renderUnits(amount, 2);
    const wanted: readonly [string, Record<string, unknown>][] = [
      [expense, { debit: value, credit: "0" }],
      [accumulated, { debit: "0", credit: value }],
    ];
    let linesOk = true;
    for (const [account, side] of wanted) {
      if (has.has(account)) continue;
      const line = await run.access.create("JournalLine", {
        journal_entry_id: entryId,
        ledger_account_id: account,
        description: `Depreciation ${period.key}`,
        ...side,
        ...(currency !== undefined ? { currency } : {}),
      });
      if (line.kind === "refused") {
        run.tally.refuse(`JournalEntry ${entryId} line`, line);
        linesOk = false;
      }
    }
    if (!linesOk) continue;
    const posted = await run.access.transition("JournalEntry", entryId, "post");
    if (posted.kind === "written") run.tally.count("posted");
    else if (posted.status === 409) run.tally.count("moved_by_someone_else");
    else run.tally.refuse(`JournalEntry ${entryId} post`, posted);
  }
  return null;
}

async function accountId(run: Run, code: string): Promise<string | null> {
  const rows = await readAll(run, "LedgerAccount", [{ field: "account_code", value: code }], "a ledger account by code");
  return rows.length === 1 ? str(rows[0], "id") : null;
}

// ---- inventory reorder --------------------------------------------------------------------------

const OPEN_PO_STATES = ["draft", "submitted", "approved"] as const;
const QTY_SCALE = 3;
const PRICE_SCALE = 4;

async function inventoryReorder(run: Run): Promise<JobHandlerResult | null> {
  const items = await readAll(run, "Item", [{ field: "status", value: "active" }], "the active items");
  const watched = items.filter((i) => units(i["reorder_point"], QTY_SCALE) !== null);
  run.tally.count("items_with_reorder_point", watched.length);
  if (watched.length === 0) return null;

  const levels = await readAll(run, "StockLevel", [], "the stock levels");
  const projected = new Map<string, bigint>();
  for (const l of levels) {
    const item = str(l, "item_id");
    if (item === null) continue;
    const p =
      (units(l["quantity_on_hand"], QTY_SCALE) ?? 0n) -
      (units(l["quantity_reserved"], QTY_SCALE) ?? 0n) +
      (units(l["quantity_incoming"], QTY_SCALE) ?? 0n);
    projected.set(item, (projected.get(item) ?? 0n) + p);
  }

  const openPos = await readAll(
    run,
    "PurchaseOrder",
    [{ field: "state", op: "in", value: [...OPEN_PO_STATES] }],
    "the open purchase orders",
  );
  const openPoIds = new Set(openPos.map((p) => str(p, "id")));
  const openPoLines = openPoIds.size === 0 ? [] : await linesOf(run, [...openPoIds].filter((x): x is string => x !== null));
  const onOrder = new Set<string>();
  for (const line of openPoLines) {
    const outstanding = (units(line["quantity"], QTY_SCALE) ?? 0n) - (units(line["received_quantity"], QTY_SCALE) ?? 0n);
    const item = str(line, "item_id");
    if (item !== null && outstanding > 0n) onOrder.add(item);
  }

  const groups = new Map<string, { vendor: string; currency: string; lines: Record<string, unknown>[] }>();
  for (const item of watched) {
    const itemId = str(item, "id") as string;
    const point = units(item["reorder_point"], QTY_SCALE) as bigint;
    const level = projected.get(itemId) ?? 0n;
    if (level >= point) continue;
    run.tally.count("below_reorder_point");
    if (onOrder.has(itemId)) {
      run.tally.count("already_on_order");
      continue;
    }
    const supplier = await lastSupplier(run, itemId);
    if (supplier === null) {
      run.tally.count("no_supplier_history");
      continue;
    }
    const configured = units(item["reorder_quantity"], QTY_SCALE);
    const qty = configured !== null && configured > 0n ? configured : point - level;
    if (qty <= 0n) continue;
    const key = `${supplier.vendor}\u0000${supplier.currency}`;
    const group = groups.get(key) ?? { vendor: supplier.vendor, currency: supplier.currency, lines: [] };
    group.lines.push({
      item_id: itemId,
      description: str(item, "name") ?? itemId,
      quantity: renderUnits(qty, QTY_SCALE),
      unit_price: renderUnits(supplier.unitPrice, PRICE_SCALE),
      line_total: renderUnits(mul(qty, QTY_SCALE, supplier.unitPrice, PRICE_SCALE, 2), 2),
    });
    groups.set(key, group);
  }

  const today = isoDate(run.at);
  const marker = `[reorder:${today}]`;
  for (const group of groups.values()) {
    const stop = aborted(run);
    if (stop !== null) return stop;
    const subtotal = group.lines.reduce((s, l) => s + (units(l["line_total"], 2) ?? 0n), 0n);
    // A previous attempt of this run may have created the header and not every line; finishing that
    // draft rather than opening a second is what makes the retry a retry.
    const reuse = openPos.find(
      (p) =>
        str(p, "state") === "draft" &&
        str(p, "vendor_id") === group.vendor &&
        str(p, "currency") === group.currency &&
        (str(p, "notes") ?? "").includes(marker),
    );
    let poId = reuse === undefined ? null : str(reuse, "id");
    if (poId === null) {
      const po = await run.access.create("PurchaseOrder", {
        vendor_id: group.vendor,
        order_date: today,
        currency: group.currency,
        subtotal: renderUnits(subtotal, 2),
        total: renderUnits(subtotal, 2),
        notes: `Drafted by the reorder-point sweep ${marker}`,
      });
      if (po.kind === "refused" || po.record === null) {
        if (po.kind === "refused") run.tally.refuse(`PurchaseOrder for vendor ${group.vendor}`, po);
        continue;
      }
      poId = str(po.record, "id");
      run.tally.count("purchase_orders_drafted");
    }
    for (const line of group.lines) {
      const r = await run.access.create("PurchaseOrderLine", { purchase_order_id: poId, ...line });
      if (r.kind === "written") run.tally.count("lines_drafted");
      else run.tally.refuse(`PurchaseOrderLine item ${String(line["item_id"])}`, r);
    }
  }
  return null;
}

async function linesOf(run: Run, poIds: readonly string[]): Promise<EntityRecord[]> {
  const out: EntityRecord[] = [];
  for (let i = 0; i < poIds.length; i += 200) {
    out.push(
      ...(await readAll(
        run,
        "PurchaseOrderLine",
        [{ field: "purchase_order_id", op: "in", value: poIds.slice(i, i + 200) }],
        "the open purchase order lines",
      )),
    );
  }
  return out;
}

/**
 * The vendor, currency and price of the latest non-cancelled purchase of an item. `Item` declares
 * no preferred vendor, so the purchase history is the only evidence of who supplies it — and an item
 * never bought is reported rather than drafted against a vendor nobody chose.
 */
async function lastSupplier(
  run: Run,
  itemId: string,
): Promise<{ vendor: string; currency: string; unitPrice: bigint } | null> {
  const lines = await readAll(run, "PurchaseOrderLine", [{ field: "item_id", value: itemId }], "an item's purchase history");
  if (lines.length === 0) return null;
  const poIds = [...new Set(lines.map((l) => str(l, "purchase_order_id")).filter((x): x is string => x !== null))];
  const pos: EntityRecord[] = [];
  for (let i = 0; i < poIds.length; i += 200) {
    pos.push(
      ...(await readAll(run, "PurchaseOrder", [{ field: "id", op: "in", value: poIds.slice(i, i + 200) }], "an item's purchase orders")),
    );
  }
  const byId = new Map(pos.filter((p) => str(p, "state") !== "cancelled").map((p) => [str(p, "id"), p]));
  let best: { po: EntityRecord; line: EntityRecord } | null = null;
  for (const line of lines) {
    const po = byId.get(str(line, "purchase_order_id"));
    if (po === undefined) continue;
    if (best === null || orderKey(po) > orderKey(best.po)) best = { po, line };
  }
  if (best === null) return null;
  const vendor = str(best.po, "vendor_id");
  const currency = str(best.po, "currency");
  const unitPrice = units(best.line["unit_price"], PRICE_SCALE);
  return vendor === null || currency === null || unitPrice === null ? null : { vendor, currency, unitPrice };
}

function orderKey(po: EntityRecord): string {
  return `${str(po, "order_date") ?? ""}|${str(po, "created_at") ?? ""}|${str(po, "id") ?? ""}`;
}

// ---- sales order → invoice ----------------------------------------------------------------------

function eventRecordId(ctx: JobHandlerContext): string | null {
  const input = ctx.input;
  if (input === null || typeof input !== "object") return null;
  const id = (input as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function salesOrderToInvoice(run: Run): Promise<JobHandlerResult | null> {
  const soId = eventRecordId(run.ctx);
  if (soId === null) return failed("event_record_missing", "the event names no sales order id", false);
  const so = await run.access.read("SalesOrder", soId);
  if (so === null) return failed("sales_order_not_found", `sales order ${soId} does not exist in this tenant`, false);
  const state = str(so, "state");
  if (state === "invoiced" || state === "closed") {
    run.tally.count("already_invoiced");
    return null;
  }
  if (state !== "fulfilled") {
    run.tally.count(`skipped_state_${state ?? "unknown"}`);
    return null;
  }

  const lines = [
    ...(await readAll(run, "SalesOrderLine", [{ field: "sales_order_id", value: soId }], "a sales order's lines")),
  ].sort(
    (a, b) => `${str(a, "created_at") ?? ""}|${str(a, "id") ?? ""}`.localeCompare(`${str(b, "created_at") ?? ""}|${str(b, "id") ?? ""}`),
  );
  const fulfilled = lines.filter((l) => (units(l["fulfilled_quantity"], QTY_SCALE) ?? 0n) > 0n);
  if (fulfilled.length === 0) {
    // `fulfilled_quantity` defaults to 0; a shipment entering `shipped` advances it for a stocked
    // item's line, and nothing advances it for a service line or a line with no item — a person
    // does. An order marked fulfilled with none recorded is not evidence of what was delivered, and
    // invoicing the ordered quantity instead would bill a figure nobody confirmed.
    return failed(
      "nothing_fulfilled",
      `sales order ${soId} is 'fulfilled' and none of its lines records a fulfilled_quantity; nothing was invoiced`,
      false,
    );
  }
  const partial = fulfilled.length < lines.length || fulfilled.some((l) => (units(l["fulfilled_quantity"], QTY_SCALE) ?? 0n) < (units(l["quantity"], QTY_SCALE) ?? 0n));
  const soTax = units(so["tax_total"], 2) ?? 0n;
  if (partial && soTax !== 0n) {
    // The order carries tax at the header only, with no rate on any line, so the share of it a
    // partial delivery owes is not recorded anywhere; apportioning it by value would invent a tax
    // figure on a document that is a tax record.
    return failed(
      "partial_fulfilment_tax_unallocable",
      `sales order ${soId} is partly fulfilled and carries header-level tax with no per-line rate; its invoice needs a person`,
      false,
    );
  }

  const invoiceLines = fulfilled.map((l, i) => {
    const qty = units(l["fulfilled_quantity"], QTY_SCALE) as bigint;
    const price = units(l["unit_price"], PRICE_SCALE) ?? 0n;
    return {
      position: i,
      description: str(l, "description") ?? `Line ${(i + 1).toString()}`,
      quantity: renderUnits(qty, QTY_SCALE),
      unit_price: renderUnits(price, PRICE_SCALE),
      line_total: renderUnits(mul(qty, QTY_SCALE, price, PRICE_SCALE, 2), 2),
    };
  });
  const subtotal = invoiceLines.reduce((s, l) => s + (units(l.line_total, 2) ?? 0n), 0n);
  const tax = partial ? 0n : soTax;

  const marker = `[sales_order:${soId}]`;
  const accountIdOf = str(so, "account_id");
  const candidates =
    accountIdOf === null
      ? []
      : await readAll(run, "Invoice", [{ field: "account_id", value: accountIdOf }], "the account's invoices");
  let invoice = candidates.find((i) => (str(i, "notes") ?? "").includes(marker)) ?? null;
  if (invoice === null) {
    const created = await run.access.create("Invoice", {
      account_id: accountIdOf,
      currency: str(so, "currency"),
      issue_date: isoDate(run.at),
      subtotal: renderUnits(subtotal, 2),
      tax_total: renderUnits(tax, 2),
      total: renderUnits(subtotal + tax, 2),
      notes: `Generated from sales order ${str(so, "so_number") ?? soId} ${marker}`,
    });
    if (created.kind === "refused" || created.record === null) {
      if (created.kind === "refused") run.tally.refuse(`Invoice for SalesOrder ${soId}`, created);
      return null;
    }
    invoice = created.record;
    run.tally.count("invoices_created");
  } else {
    run.tally.count("invoice_resumed");
  }
  const invoiceId = str(invoice, "id") as string;
  const present = await readAll(run, "InvoiceLine", [{ field: "invoice_id", value: invoiceId }], "an invoice's lines");
  const positions = new Set(present.map((l) => l["position"]));
  for (const line of invoiceLines) {
    if (positions.has(line.position)) continue;
    const r = await run.access.create("InvoiceLine", { invoice_id: invoiceId, ...line });
    if (r.kind === "written") run.tally.count("lines_created");
    else run.tally.refuse(`InvoiceLine ${line.position.toString()} of ${invoiceId}`, r);
  }
  if (run.tally.refused.length > 0) return null;
  const moved = await run.access.transition("SalesOrder", soId, "invoice");
  if (moved.kind === "written") run.tally.count("sales_order_invoiced");
  else if (moved.status === 409) run.tally.count("moved_by_someone_else");
  else run.tally.refuse(`SalesOrder ${soId} invoice`, moved);
  return null;
}

// ---- work order completion ----------------------------------------------------------------------

async function workOrderCompletion(run: Run): Promise<JobHandlerResult | null> {
  const woId = eventRecordId(run.ctx);
  if (woId === null) return failed("event_record_missing", "the event names no work order id", false);
  const wo = await run.access.read("WorkOrder", woId);
  if (wo === null) return failed("work_order_not_found", `work order ${woId} does not exist in this tenant`, false);
  if (str(wo, "state") !== "completed") {
    run.tally.count(`skipped_state_${str(wo, "state") ?? "unknown"}`);
    return null;
  }
  const completed = units(wo["completed_quantity"], QTY_SCALE) ?? 0n;
  if (completed <= 0n) {
    return failed(
      "no_completed_quantity",
      `work order ${woId} is 'completed' with no completed_quantity recorded; nothing was moved`,
      false,
    );
  }
  const warehouse = str(wo, "warehouse_id");
  if (warehouse === null) {
    return failed("work_order_has_no_warehouse", `work order ${woId} names no warehouse to move stock in`, false);
  }
  const bomId = str(wo, "bom_id");
  if (bomId === null) {
    // An item may have several bills of materials (versions, drafts); choosing one for the work
    // order would consume stock by a recipe nobody named.
    return failed("work_order_has_no_bom", `work order ${woId} names no bill of materials`, false);
  }
  const bom = await run.access.read("BillOfMaterials", bomId);
  const output = units(bom?.["output_quantity"], QTY_SCALE) ?? 0n;
  if (bom === null || output <= 0n) {
    return failed("bom_unusable", `bill of materials ${bomId} is missing or has no output quantity`, false);
  }
  const bomLines = await readAll(run, "BomLine", [{ field: "bom_id", value: bomId }], "a bill of materials' lines");

  const reference = `WO:${woId}`;
  const existing = await readAll(run, "StockMovement", [{ field: "reference", value: reference }], "a work order's movements");
  const done = new Set(existing.map((m) => `${str(m, "movement_type") ?? ""}|${str(m, "item_id") ?? ""}`));
  const occurredAt = run.at.toISOString();
  // One issue per component, summed: the idempotency marker is (movement type, item), so two BOM
  // lines naming one component written as two movements would read as one already moved on a retry
  // that found only the first, and the second would never be issued.
  const issues = new Map<string, bigint>();
  for (const line of bomLines) {
    const component = str(line, "component_item_id");
    const per = units(line["quantity"], 4);
    if (component === null || per === null) continue;
    const scrap = units(line["scrap_pct"], 2) ?? 0n;
    // per × completed / output × (1 + scrap/100), exact and rounded once. Scales: per 4 + completed
    // 3 − output 3 = 4, and the trailing ×10 in the divisor brings it to the movement's 3. Scrap is
    // at scale 2 so 5.00% is 500, and (10000 + 500) / 10000 is the 1.05 it means.
    const qty = divRound(per * completed * (10000n + scrap), output * 10000n * 10n);
    issues.set(component, (issues.get(component) ?? 0n) + qty);
  }
  const movements: Record<string, unknown>[] = [...issues].map(([component, qty]) => ({
    item_id: component,
    movement_type: "issue",
    quantity: renderUnits(qty, QTY_SCALE),
    reason: "Consumed by work order",
  }));
  movements.push({
    item_id: str(wo, "item_id"),
    movement_type: "receipt",
    quantity: renderUnits(completed, QTY_SCALE),
    reason: "Produced by work order",
  });
  let issueRefused = false;
  for (const m of movements) {
    const key = `${String(m["movement_type"])}|${String(m["item_id"])}`;
    if (done.has(key)) {
      run.tally.count("already_moved");
      continue;
    }
    // The finished good is received only once every component was consumed: a receipt beside a
    // refused issue would put stock on hand (and its value in the inventory account) that nothing
    // was used to make. A later run writes it beside the issue that was missing.
    if (m["movement_type"] === "receipt" && issueRefused) {
      run.tally.count("receipt_withheld");
      continue;
    }
    const r = await run.access.create("StockMovement", {
      ...m,
      warehouse_id: warehouse,
      reference,
      occurred_at: occurredAt,
    });
    if (r.kind === "written") run.tally.count(`${String(m["movement_type"])}_movements`);
    else {
      if (m["movement_type"] === "issue") issueRefused = true;
      run.tally.refuse(`StockMovement ${key}`, r);
    }
  }
  return null;
}
