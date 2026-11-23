/**
 * The `backfill-bill-withholding` maintenance subcommand's own module: its options, the derivation
 * of a legacy bill's withholding from its posted recognition entry, the pass over one tenant's bills,
 * and the report an operator reads.
 *
 * ## What it corrects
 *
 * Bill recognition has always posted accounts payable net of withholding (the control line is the
 * total less the withheld tax) while recording the withheld figure nowhere on the bill. Every reader
 * of what is owed therefore read the gross total, so a bill paid at the net never settled. The
 * running server now stamps `withholding_total` at approval; a bill approved before that carries no
 * stamp, and the field is server-owned, so neither a client nor `mark_paid` can supply it. This pass
 * stamps it from the bill's own `<bill_number>-GL` entry, which is what accounts payable actually
 * says — never from today's tax codes, whose rates may have moved since.
 *
 * ## How the figure is read
 *
 * In document currency (`debit`/`credit`), never `functional_*`: the bill's `total` is in its own
 * currency and so are those columns. The control line is found by its description and the
 * withholding lines by their label prefix, both imported from the effect that wrote them. Never by
 * account: before ADR-0465 an uncoded withholding group posted to the input-tax account, so an
 * account-based reading would miss exactly the legacy lines this pass exists for. And the figure is
 * accepted only when it is the difference the entry itself implies, `total − control == Σ withholding`;
 * anything else means the entry no longer describes the bill, and the bill is refused by name.
 *
 * It never settles a bill. It reports what the stamp makes owed against what has been applied, so an
 * operator knows which bills `mark_paid` will now accept, and leaves settlement to that transition,
 * which runs the guards and writes its own audit row.
 */

import type { ClassifiedField } from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel";
import {
  APPLIED_PAYMENT_EPSILON,
  BILL_CONTROL_DESCRIPTION,
  WITHHOLDING_LINE_DESCRIPTION_PREFIX,
  defaultEffectStamps,
  drainList,
  entityAuditPayloads,
  isEntityAuditUnrecorded,
  moneyUnits,
  readAppliedToDocument,
  renderMoney,
  settlementIsCovered,
  unitsToNumber,
  type EntityRecord,
  type EntityStore,
  type EntityWriteAuditor,
  type SystemWriteOrigin,
  type TransactionalEntityStore,
} from "@crossengin/operate-runtime";

/** Options for the `backfill-bill-withholding` subcommand. Parsed in `cli.ts`; shaped here. */
export interface BillWithholdingBackfillOptions {
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly store: "pg" | "pg-columns";
  readonly schema: string | null;
  readonly tenantId: string | null;
  readonly allTenants: boolean;
  readonly plan: boolean;
  readonly auditChainConfig: string | null;
  readonly format: "human" | "json";
  readonly help: boolean;
}

/** The field this pass stamps, and the one the running server's recognition stamps. */
export const BACKFILL_STAMP_FIELD = "withholding_total";

/** The recognition entry's number is the bill's number plus this suffix (`compile.ts`). */
export const BILL_RECOGNITION_ENTRY_SUFFIX = "-GL";

/** The states in which a bill has been recognised and not reversed: draft has no entry, void reversed it. */
export const BACKFILL_ELIGIBLE_BILL_STATES = ["approved", "overdue", "paid"] as const;

/** How many lines one recognition entry may carry before the read is refused rather than truncated. */
export const RECOGNITION_ENTRY_LINE_CEILING = 1000;

/** Payment application's own ceiling for one document's instalments, so the two read the same set. */
export const BILL_PAYMENT_CEILING = 10_000;

/** How many eligible bills one tenant may hold before the tenant is refused rather than half-read. */
export const TENANT_BILL_CEILING = 100_000;

/** Why the whole run did nothing. */
export const BACKFILL_RUN_REFUSALS = [
  "not_stamped_here",
  "schema_not_provisioned",
  "encrypted_column_unsupported",
] as const;
export type BackfillRunRefusal = (typeof BACKFILL_RUN_REFUSALS)[number];

/** Why one tenant was skipped; the run goes on to the next. */
export const BACKFILL_TENANT_REFUSALS = [
  "tenant_manifest_unsupported",
  "tenant_manifest_unreadable",
  "bills_unreadable",
] as const;
export type BackfillTenantRefusal = (typeof BACKFILL_TENANT_REFUSALS)[number];

/** What to do about each refused tenant; total for the bill map's reason. */
export const BACKFILL_TENANT_REFUSAL_REMEDY: Readonly<Record<BackfillTenantRefusal, string>> = {
  tenant_manifest_unsupported:
    "not covered: this pass reads the deployment's pack only, so this tenant's bills approved before" +
    " the upgrade stay unstamped and one paid at the net stays open; no subcommand stamps them yet," +
    " and this tenant is refused on every run",
  tenant_manifest_unreadable:
    "the tenant's activated-manifest row could not be read; check the role's grant on" +
    " meta.operate_tenant_manifests, then re-run",
  bills_unreadable:
    "the tenant's bills could not be listed (the detail names the error class and SQLSTATE); check the" +
    " role's privileges and the tenant's context, then re-run",
};

/** Why one bill was not stamped; the pass goes on to the next. */
export const BACKFILL_BILL_REFUSALS = [
  "bill_absent",
  "bill_unreadable",
  "bill_total_unreadable",
  "bill_number_shared",
  "recognition_entry_absent",
  "recognition_entry_ambiguous",
  "entry_not_posted",
  "entry_source_mismatch",
  "entry_lines_unreadable",
  "line_amount_unreadable",
  "control_line_absent",
  "control_line_ambiguous",
  "currency_mismatch",
  "derivation_disagrees",
  "audit_unrecorded",
] as const;
export type BackfillBillRefusal = (typeof BACKFILL_BILL_REFUSALS)[number];

/**
 * What to do about each refused bill. A total map, so a new refusal is a compile error until it says
 * what an operator should do — a refusal with no remedy is a sentence nobody can act on.
 */
export const BACKFILL_BILL_REFUSAL_REMEDY: Readonly<Record<BackfillBillRefusal, string>> = {
  bill_absent: "the bill was removed after it was listed; nothing to do",
  bill_unreadable:
    "the bill could not be read, locked or written (the detail names the error class and SQLSTATE: a lock" +
    " timeout, a refused privilege, a row the contract refuses); correct the cause, then re-run",
  bill_total_unreadable: "the bill's total is not a decimal; correct the row, then re-run",
  bill_number_shared:
    "another bill carries the same number, so its -GL entry cannot be attributed; renumber one and re-run",
  recognition_entry_absent:
    "no -GL entry carries this bill's number, though recognition posts one for every bill with a positive" +
    " total; check whether the entry was renumbered or removed, then re-run",
  recognition_entry_ambiguous: "more than one -GL entry carries this bill's number; reverse the duplicate, then re-run",
  entry_not_posted: "the bill's -GL entry is not posted (a draft or reversed entry is not what accounts payable says)",
  entry_source_mismatch: "the entry numbered for this bill was not written by bill recognition; check it by hand",
  entry_lines_unreadable: "the entry's lines could not be read in full; check it by hand",
  line_amount_unreadable: "a line's debit or credit is not a decimal; correct the line, then re-run",
  control_line_absent:
    "the entry carries no accounts-payable control line under the description recognition writes; check it by hand",
  control_line_ambiguous: "the entry carries more than one accounts-payable control line; check it by hand",
  currency_mismatch: "the entry's lines are not in the bill's currency; check it by hand",
  derivation_disagrees:
    "total less the control line is not the sum of the withholding lines, so the entry no longer describes the bill; check it by hand",
  audit_unrecorded: "the audit row could not be written, so the stamp was rolled back; fix the audit table and re-run",
};

/** What the stamp makes owed against what completed payments have applied. */
export type BillCoverage =
  | { readonly kind: "now_covered"; readonly owed: string; readonly applied: string }
  | { readonly kind: "settled"; readonly owed: string; readonly applied: string }
  | { readonly kind: "still_open"; readonly owed: string; readonly applied: string; readonly outstanding: string }
  | { readonly kind: "overpaid"; readonly owed: string; readonly applied: string; readonly overpaidBy: string }
  | { readonly kind: "unread" };

export type BillBackfillOutcome =
  | {
      readonly kind: "stamped";
      readonly billId: string;
      readonly billNumber: string;
      readonly withholding: string;
      /** False under `--plan`: what would be written, nothing written. */
      readonly written: boolean;
      /**
       * The figure the bill carried before, when it disagreed with the ledger; null when it carried
       * none. The ledger wins, as recognition's own stamp does: a figure no entry supports is either a
       * client's write from before the field was server-owned or a stamp the entry was edited away
       * from, and every reader would otherwise trust it.
       */
      readonly replaced: string | null;
      /** Null for a bill whose total is not positive, which recognition posts no entry for. */
      readonly entryId: string | null;
      readonly controlLineId: string | null;
      readonly withholdingLineIds: readonly string[];
      readonly coverage: BillCoverage;
    }
  | {
      readonly kind: "already_stamped";
      readonly billId: string;
      readonly billNumber: string;
      readonly withholding: string;
      readonly coverage: BillCoverage;
    }
  | { readonly kind: "nothing_withheld"; readonly billId: string; readonly billNumber: string }
  | { readonly kind: "state_changed"; readonly billId: string; readonly billNumber: string; readonly state: string }
  | {
      readonly kind: "refused";
      readonly billId: string;
      readonly billNumber: string;
      readonly reason: BackfillBillRefusal;
      readonly detail: string;
    };

export interface TenantBackfillReport {
  readonly tenantId: string;
  readonly refusal: { readonly reason: BackfillTenantRefusal; readonly detail: string } | null;
  readonly bills: readonly BillBackfillOutcome[];
}

export interface BillWithholdingBackfillReport {
  readonly runId: string;
  readonly plan: boolean;
  readonly store: "pg" | "pg-columns";
  /** Whether the audit rows written are anchored into the chain; meaningless under `--plan`. */
  readonly anchored: boolean;
  readonly refusal: { readonly reason: BackfillRunRefusal; readonly detail: string } | null;
  readonly tenants: readonly TenantBackfillReport[];
  /** True only when nothing was refused at any level: a refused bill must not exit 0. */
  readonly ok: boolean;
}

/**
 * Whether this manifest's running server stamps a bill's withholding. Read off the effect wiring's
 * own stamp list rather than restated, so the backfill writes the field exactly where recognition
 * would and nowhere else.
 */
export function billWithholdingStampedFor(manifest: Manifest): boolean {
  return defaultEffectStamps(manifest).some((s) => s.entity === "Bill" && s.field === BACKFILL_STAMP_FIELD);
}

/** The derivation's answer for one entry's lines. */
export type WithholdingDerivation =
  | {
      readonly kind: "derived";
      readonly withholdingUnits: bigint;
      readonly controlUnits: bigint;
      readonly controlLineId: string | null;
      readonly withholdingLineIds: readonly string[];
    }
  | { readonly kind: "refused"; readonly reason: BackfillBillRefusal; readonly detail: string };

interface ReadLine {
  readonly id: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

/**
 * A legacy bill's withholding, from the lines of its recognition entry. Pure.
 *
 * A bill withheld in full has **no** control line, because recognition drops a zero-amount line; it
 * is accepted only when the withholding lines alone sum to the total, which is the same identity
 * with the control at zero.
 */
export function deriveBillWithholding(input: {
  readonly total: unknown;
  readonly currency: unknown;
  readonly lines: readonly EntityRecord[];
}): WithholdingDerivation {
  const totalUnits = moneyUnits(input.total);
  if (totalUnits === null) {
    return { kind: "refused", reason: "bill_total_unreadable", detail: "the bill's total is not a decimal" };
  }
  const controls: ReadLine[] = [];
  const withholding: ReadLine[] = [];
  for (const line of input.lines) {
    const description = typeof line["description"] === "string" ? line["description"] : "";
    const isControl = description === BILL_CONTROL_DESCRIPTION;
    const isWithholding = description.startsWith(WITHHOLDING_LINE_DESCRIPTION_PREFIX);
    if (!isControl && !isWithholding) continue;
    const id = String(line["id"] ?? "");
    const debit = moneyUnits(line["debit"] ?? 0);
    const credit = moneyUnits(line["credit"] ?? 0);
    if (debit === null || credit === null) {
      return { kind: "refused", reason: "line_amount_unreadable", detail: `line ${id}'s debit or credit is not a decimal` };
    }
    const lineCurrency = line["currency"];
    if (typeof input.currency === "string" && typeof lineCurrency === "string" && lineCurrency !== input.currency) {
      return {
        kind: "refused",
        reason: "currency_mismatch",
        detail: `line ${id} is in ${lineCurrency} and the bill in ${input.currency}`,
      };
    }
    (isControl ? controls : withholding).push({ id, debit, credit });
  }

  // Bill recognition posts the control and the withholding on the credit side. A debit on either is
  // not something recognition wrote, so the entry is not describing what it is assumed to describe.
  const offSide = [...controls, ...withholding].find((l) => l.debit !== 0n);
  if (offSide !== undefined) {
    return {
      kind: "refused",
      reason: "derivation_disagrees",
      detail: `line ${offSide.id} carries a debit where recognition posts a credit`,
    };
  }
  if (controls.length > 1) {
    return {
      kind: "refused",
      reason: "control_line_ambiguous",
      detail: `${controls.length.toString()} lines are described "${BILL_CONTROL_DESCRIPTION}"`,
    };
  }
  const withholdingUnits = withholding.reduce((sum, l) => sum + l.credit, 0n);
  const control = controls[0];
  if (control === undefined && !(withholding.length > 0 && withholdingUnits === totalUnits)) {
    return {
      kind: "refused",
      reason: "control_line_absent",
      detail: `no line is described "${BILL_CONTROL_DESCRIPTION}"`,
    };
  }
  const controlUnits = control?.credit ?? 0n;
  if (totalUnits - controlUnits !== withholdingUnits) {
    return {
      kind: "refused",
      reason: "derivation_disagrees",
      detail:
        `total ${renderMoney(totalUnits)} less control ${renderMoney(controlUnits)} is ` +
        `${renderMoney(totalUnits - controlUnits)}, and the withholding lines sum to ${renderMoney(withholdingUnits)}`,
    };
  }
  return {
    kind: "derived",
    withholdingUnits,
    controlUnits,
    controlLineId: control?.id ?? null,
    withholdingLineIds: withholding.map((l) => l.id),
  };
}

/**
 * How an existing value compares with the derived one. An unreadable value disagrees rather than
 * reading as absent: absent would let this pass overwrite a figure it cannot read.
 */
export function compareStoredWithholding(stored: unknown, derivedUnits: bigint): "absent" | "equal" | "disagrees" {
  if (stored === undefined || stored === null) return "absent";
  const units = moneyUnits(stored);
  if (units === null) return "disagrees";
  return units === derivedUnits ? "equal" : "disagrees";
}

/** What the stamp makes owed against what has been applied. Pure. */
export function classifyCoverage(input: {
  readonly totalUnits: bigint;
  readonly withholdingUnits: bigint;
  readonly applied: number;
  readonly state: string;
}): Exclude<BillCoverage, { kind: "unread" }> {
  const owedUnits = input.totalUnits - input.withholdingUnits;
  const appliedUnits = moneyUnits(input.applied) ?? 0n;
  const owed = renderMoney(owedUnits);
  const applied = renderMoney(appliedUnits);
  if (appliedUnits - owedUnits > 0n && unitsToNumber(appliedUnits - owedUnits) > APPLIED_PAYMENT_EPSILON) {
    return { kind: "overpaid", owed, applied, overpaidBy: renderMoney(appliedUnits - owedUnits) };
  }
  if (settlementIsCovered(unitsToNumber(owedUnits), input.applied)) {
    return input.state === "paid" ? { kind: "settled", owed, applied } : { kind: "now_covered", owed, applied };
  }
  return { kind: "still_open", owed, applied, outstanding: renderMoney(owedUnits - appliedUnits) };
}

export interface TenantBackfillInput {
  readonly store: TransactionalEntityStore;
  readonly tenantId: string;
  readonly plan: boolean;
  readonly auditor: EntityWriteAuditor;
  readonly origin: Extract<SystemWriteOrigin, { kind: "maintenance" }>;
  /** Bill's classified fields, so a classified `withholding_total` is redacted in the audit row. */
  readonly classified: readonly ClassifiedField[];
  /** The entity completed payments are read from, or null when the manifest declares none. */
  readonly paymentEntity: string | null;
  readonly now: () => Date;
  readonly newRequestId: () => string;
}

/**
 * One tenant's pass: every eligible bill, each in its own transaction under its own row lock, so a
 * refused bill costs only itself and a stamp commits with its audit row or not at all.
 */
export async function backfillTenantBills(input: TenantBackfillInput): Promise<TenantBackfillReport> {
  const ids: string[] = [];
  let listed;
  try {
    listed = await drainList(
      input.store,
      input.tenantId,
      "Bill",
      { sort: [], filters: [{ field: "state", op: "in", value: [...BACKFILL_ELIGIBLE_BILL_STATES] }] },
      { ceiling: TENANT_BILL_CEILING },
      (rows) => {
        for (const r of rows) if (isEligibleState(r["state"])) ids.push(String(r["id"]));
      },
    );
  } catch (err) {
    return { tenantId: input.tenantId, refusal: { reason: "bills_unreadable", detail: describeError(err) }, bills: [] };
  }
  if (!listed.complete) {
    return {
      tenantId: input.tenantId,
      refusal: {
        reason: "bills_unreadable",
        detail: `more than ${TENANT_BILL_CEILING.toString()} eligible bills; nothing was stamped rather than a prefix`,
      },
      bills: [],
    };
  }
  const bills: BillBackfillOutcome[] = [];
  for (const id of ids) bills.push(await backfillOneBill(input, id));
  return { tenantId: input.tenantId, refusal: null, bills };
}

async function backfillOneBill(input: TenantBackfillInput, billId: string): Promise<BillBackfillOutcome> {
  let billNumber = billId;
  try {
    return await input.store.withTransaction(input.tenantId, async (tx) => {
      // The lock serialises this against recognition and any other store write to the bill, so the
      // comparison and the stamp are one act with respect to those. Payment application reads the
      // bill without a lock, so a payment completing during the pass is judged against the unstamped
      // bill and may be missing from the coverage read here; the report says to re-run for that.
      const bill = input.plan
        ? await tx.get(input.tenantId, "Bill", billId)
        : await tx.getLocked(input.tenantId, "Bill", billId, "exclusive");
      if (bill === null) return refuse(billId, billNumber, "bill_absent", "no such bill");
      billNumber = typeof bill["bill_number"] === "string" ? bill["bill_number"] : billId;
      const state = String(bill["state"] ?? "");
      if (!isEligibleState(state)) return { kind: "state_changed", billId, billNumber, state };
      const totalUnits = moneyUnits(bill["total"]);
      if (totalUnits === null) {
        return refuse(billId, billNumber, "bill_total_unreadable", "the bill's total is not a decimal");
      }
      // Recognition posts nothing for a total of zero or less, so there is no entry to read and
      // nothing withheld; refusing it for the absent entry would fail every run on a bill that is right.
      if (totalUnits <= 0n) {
        const stored = bill[BACKFILL_STAMP_FIELD];
        if (compareStoredWithholding(stored, 0n) === "disagrees") {
          const coverage = await coverageOf(tx, input, billId, { totalUnits, withholdingUnits: 0n, state });
          return await stamp(tx, input, { billId, billNumber, stored, units: 0n, coverage, entryId: null, controlLineId: null, withholdingLineIds: [] });
        }
        return { kind: "nothing_withheld", billId, billNumber };
      }

      if (typeof bill["bill_number"] === "string") {
        const sharing = await countMatching(tx, input.tenantId, "Bill", "bill_number", billNumber);
        if (sharing.count > 1 || !sharing.complete) {
          return refuse(billId, billNumber, "bill_number_shared", `bills numbered ${billNumber}: more than one`);
        }
      }
      const entryNumber = `${billNumber}${BILL_RECOGNITION_ENTRY_SUFFIX}`;
      const entries: EntityRecord[] = [];
      const entryRead = await drainList(
        tx,
        input.tenantId,
        "JournalEntry",
        { sort: [], filters: [{ field: "entry_number", op: "eq", value: entryNumber }] },
        { ceiling: 10 },
        (rows) => {
          for (const r of rows) if (r["entry_number"] === entryNumber) entries.push(r);
        },
      );
      if (!entryRead.complete || entries.length > 1) {
        return refuse(billId, billNumber, "recognition_entry_ambiguous", `more than one entry is numbered ${entryNumber}`);
      }
      const entry = entries[0];
      if (entry === undefined) {
        return refuse(billId, billNumber, "recognition_entry_absent", `no entry is numbered ${entryNumber}`);
      }
      const entryId = String(entry["id"]);
      if (entry["state"] !== "posted") {
        return refuse(billId, billNumber, "entry_not_posted", `entry ${entryId} is ${String(entry["state"] ?? "unset")}`);
      }
      if (entry["source"] !== "bill") {
        return refuse(
          billId,
          billNumber,
          "entry_source_mismatch",
          `entry ${entryId} has source ${String(entry["source"] ?? "unset")}`,
        );
      }
      const lines: EntityRecord[] = [];
      const lineRead = await drainList(
        tx,
        input.tenantId,
        "JournalLine",
        { sort: [], filters: [{ field: "journal_entry_id", op: "eq", value: entryId }] },
        { ceiling: RECOGNITION_ENTRY_LINE_CEILING },
        (rows) => {
          for (const r of rows) if (String(r["journal_entry_id"] ?? "") === entryId) lines.push(r);
        },
      );
      if (!lineRead.complete) {
        return refuse(
          billId,
          billNumber,
          "entry_lines_unreadable",
          `entry ${entryId} carries more than ${RECOGNITION_ENTRY_LINE_CEILING.toString()} lines`,
        );
      }

      const derived = deriveBillWithholding({ total: bill["total"], currency: bill["currency"], lines });
      if (derived.kind === "refused") return refuse(billId, billNumber, derived.reason, derived.detail);
      const stored = bill[BACKFILL_STAMP_FIELD];
      const comparison = compareStoredWithholding(stored, derived.withholdingUnits);
      if (comparison === "absent" && derived.withholdingUnits === 0n) {
        return { kind: "nothing_withheld", billId, billNumber };
      }
      const coverage = await coverageOf(tx, input, billId, {
        totalUnits,
        withholdingUnits: derived.withholdingUnits,
        state,
      });
      const withholding = renderMoney(derived.withholdingUnits);
      if (comparison === "equal") return { kind: "already_stamped", billId, billNumber, withholding, coverage };

      return await stamp(tx, input, {
        billId,
        billNumber,
        stored,
        units: derived.withholdingUnits,
        coverage,
        entryId,
        controlLineId: derived.controlLineId,
        withholdingLineIds: derived.withholdingLineIds,
      });
    });
  } catch (err) {
    if (isEntityAuditUnrecorded(err)) return refuse(billId, billNumber, "audit_unrecorded", err.message);
    return refuse(billId, billNumber, "bill_unreadable", describeError(err));
  }
}

/**
 * Writes the ledger's figure (or, under `--plan`, says it would) and records the act in the same
 * transaction, so no audit row means no stamp. `stored` is what the bill carried, rendered into the
 * audit row's `before` and into `replaced` when it was present.
 */
async function stamp(
  tx: EntityStore,
  input: TenantBackfillInput,
  s: {
    readonly billId: string;
    readonly billNumber: string;
    readonly stored: unknown;
    readonly units: bigint;
    readonly coverage: BillCoverage;
    readonly entryId: string | null;
    readonly controlLineId: string | null;
    readonly withholdingLineIds: readonly string[];
  },
): Promise<BillBackfillOutcome> {
  const withholding = renderMoney(s.units);
  const replaced = s.stored === undefined || s.stored === null ? null : renderStored(s.stored);
  if (!input.plan) {
    const updatedAt = input.now().toISOString();
    const written = await tx.update(input.tenantId, "Bill", s.billId, {
      [BACKFILL_STAMP_FIELD]: unitsToNumber(s.units),
      updated_at: updatedAt,
    });
    if (written === null) return refuse(s.billId, s.billNumber, "bill_absent", "the bill vanished under its own lock");
    const payloads = entityAuditPayloads(
      { [BACKFILL_STAMP_FIELD]: replaced },
      { [BACKFILL_STAMP_FIELD]: withholding },
      input.classified,
    );
    // Thrown out of the transaction on failure, so the stamp rolls back with the row it lacks.
    await input.auditor.record({
      requestId: input.newRequestId(),
      operationId: "bill.withholding_backfill",
      action: "update",
      entity: "Bill",
      tenantId: input.tenantId,
      recordId: s.billId,
      actorUserId: null,
      detail:
        s.entryId === null
          ? "no entry: the bill's total is not positive"
          : `entry ${s.entryId} control ${s.controlLineId ?? "none"}`,
      origin: input.origin,
      before: payloads.before,
      after: payloads.after,
      diff: payloads.diff,
      inTransaction: true,
    });
  }
  return {
    kind: "stamped",
    billId: s.billId,
    billNumber: s.billNumber,
    withholding,
    written: !input.plan,
    replaced,
    entryId: s.entryId,
    controlLineId: s.controlLineId,
    withholdingLineIds: s.withholdingLineIds,
    coverage: s.coverage,
  };
}

/** A stored figure for a report or an audit row: the money rendering when it reads as one, else a marker. */
function renderStored(stored: unknown): string {
  const units = moneyUnits(stored);
  return units === null ? "(unreadable)" : renderMoney(units);
}

async function coverageOf(
  tx: EntityStore,
  input: TenantBackfillInput,
  billId: string,
  amounts: { readonly totalUnits: bigint; readonly withholdingUnits: bigint; readonly state: string },
): Promise<BillCoverage> {
  if (input.paymentEntity === null) return classifyCoverage({ ...amounts, applied: 0 });
  const read = await readAppliedToDocument(tx, input.tenantId, "bill_id", billId, {
    paymentEntity: input.paymentEntity,
    ceiling: BILL_PAYMENT_CEILING,
  });
  if (!read.complete) return { kind: "unread" };
  return classifyCoverage({ ...amounts, applied: read.applied });
}

async function countMatching(
  tx: EntityStore,
  tenantId: string,
  entity: string,
  field: string,
  value: string,
): Promise<{ readonly count: number; readonly complete: boolean }> {
  let count = 0;
  const outcome = await drainList(
    tx,
    tenantId,
    entity,
    { sort: [], filters: [{ field, op: "eq", value }] },
    { ceiling: 10 },
    (rows) => {
      for (const r of rows) if (r[field] === value) count += 1;
    },
  );
  return { count, complete: outcome.complete };
}

function isEligibleState(state: unknown): boolean {
  return (BACKFILL_ELIGIBLE_BILL_STATES as readonly unknown[]).includes(state);
}

function refuse(
  billId: string,
  billNumber: string,
  reason: BackfillBillRefusal,
  detail: string,
): BillBackfillOutcome {
  return { kind: "refused", billId, billNumber, reason, detail };
}

/** A name and a SQLSTATE and never a message: a driver message can quote a value from the row. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${err.name} ${code}` : err.name;
  }
  return "unknown error";
}

/** Whether anything at any level was refused, which is what a non-zero exit means. */
export function backfillRefusedAnything(
  refusal: BillWithholdingBackfillReport["refusal"],
  tenants: readonly TenantBackfillReport[],
): boolean {
  return (
    refusal !== null ||
    tenants.some((t) => t.refusal !== null || t.bills.some((b) => b.kind === "refused"))
  );
}

function coverageLine(c: BillCoverage): string {
  switch (c.kind) {
    case "now_covered":
      return `now covered: completed payments of ${c.applied} meet the ${c.owed} owed, so mark_paid will be accepted`;
    case "settled":
      return `already paid, and ${c.applied} applied meets the ${c.owed} owed`;
    case "still_open":
      return `still open: ${c.outstanding} of ${c.owed} owed is unpaid (${c.applied} applied)`;
    case "overpaid":
      return (
        `overpaid by ${c.overpaidBy}: ${c.applied} applied against ${c.owed} owed — accounts payable is in` +
        " debit by that amount and nothing here corrects it"
      );
    case "unread":
      return "coverage unread: the bill's payments could not be read in full";
  }
}

function billLine(outcome: BillBackfillOutcome, plan: boolean): string {
  const who = `${outcome.billNumber} (${outcome.billId})`;
  switch (outcome.kind) {
    case "stamped":
      return (
        `${who}: ${plan ? "would stamp" : "stamped"} ${outcome.withholding}` +
        (outcome.entryId === null ? " (total not positive, so nothing is withheld)" : ` from entry ${outcome.entryId}`) +
        (outcome.replaced === null ? "" : `, replacing ${outcome.replaced} that no entry supports`) +
        ` — ${coverageLine(outcome.coverage)}`
      );
    case "already_stamped":
      return `${who}: already stamped ${outcome.withholding} — ${coverageLine(outcome.coverage)}`;
    case "nothing_withheld":
      return `${who}: nothing withheld, nothing to stamp`;
    case "state_changed":
      return `${who}: now ${outcome.state}, so not examined`;
    case "refused":
      return `${who}: REFUSED ${outcome.reason} — ${outcome.detail}; ${BACKFILL_BILL_REFUSAL_REMEDY[outcome.reason]}`;
  }
}

/** The human report. Prints ids, numbers, amounts and this module's own sentences; no row contents. */
export function formatBillWithholdingBackfill(report: BillWithholdingBackfillReport): string {
  const out: string[] = [];
  const mode = report.plan ? "plan: nothing written" : "applied";
  out.push(
    `[backfill-bill-withholding] run ${report.runId} (${mode}), store ${report.store}` +
      (report.plan
        ? ""
        : report.anchored
          ? ", audit rows anchored into the chain"
          : ", audit rows UNANCHORED (no AUDIT_CHAIN_SIGNING_KEY or --audit-chain-config)"),
  );
  if (report.refusal !== null) {
    out.push(`REFUSED ${report.refusal.reason}: ${report.refusal.detail}`);
    return out.join("\n");
  }
  if (report.tenants.length === 0) out.push("no tenant to examine");
  for (const tenant of report.tenants) {
    if (tenant.refusal !== null) {
      out.push(
        `tenant ${tenant.tenantId}: REFUSED ${tenant.refusal.reason} — ${tenant.refusal.detail};` +
          ` ${BACKFILL_TENANT_REFUSAL_REMEDY[tenant.refusal.reason]}`,
      );
      continue;
    }
    const count = (kind: BillBackfillOutcome["kind"]): number => tenant.bills.filter((b) => b.kind === kind).length;
    out.push(
      `tenant ${tenant.tenantId}: ${tenant.bills.length.toString()} bill(s) examined — ` +
        `${count("stamped").toString()} ${report.plan ? "would be stamped" : "stamped"}, ` +
        `${count("already_stamped").toString()} already stamped, ` +
        `${count("nothing_withheld").toString()} with nothing withheld, ` +
        `${count("refused").toString()} refused`,
    );
    for (const bill of tenant.bills) {
      if (bill.kind === "nothing_withheld") continue;
      out.push(`  ${billLine(bill, report.plan)}`);
    }
  }
  const stampedAny = report.tenants.some((t) => t.bills.some((b) => b.kind === "stamped"));
  if (!report.plan && stampedAny) {
    out.push(
      "note: payment application does not wait on this pass's lock, so a payment completed while it ran" +
        " was judged against the unstamped bill; re-run to re-check the coverage of bills paid meanwhile",
    );
  }
  out.push(report.ok ? "verdict: OK" : "verdict: REFUSED — see the lines above; nothing refused was written");
  return out.join("\n");
}
