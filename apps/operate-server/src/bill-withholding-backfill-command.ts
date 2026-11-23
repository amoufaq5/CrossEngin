import { CliUsageError, billWithholdingBackfillHelpText, parseBillWithholdingBackfillArgs } from "./cli.js";
import {
  formatBillWithholdingBackfill,
  type BillWithholdingBackfillOptions,
  type BillWithholdingBackfillReport,
} from "./bill-withholding-backfill.js";

export interface BillWithholdingBackfillCommandDeps {
  readonly run: (options: BillWithholdingBackfillOptions) => Promise<BillWithholdingBackfillReport>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * The `backfill-bill-withholding` subcommand from argv to exit code, with the runner injected so
 * the mapping is testable without a database: 2 for a usage error, 0 for help, and otherwise 0 only
 * when the report says nothing was refused at any level.
 */
export async function billWithholdingBackfillCommand(
  argv: readonly string[],
  deps: BillWithholdingBackfillCommandDeps,
): Promise<number> {
  let options: BillWithholdingBackfillOptions;
  try {
    options = parseBillWithholdingBackfillArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      deps.stderr(`error: ${err.message}\n\n${billWithholdingBackfillHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    deps.stdout(billWithholdingBackfillHelpText);
    return 0;
  }
  const report = await deps.run(options);
  deps.stdout(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatBillWithholdingBackfill(report)}\n`,
  );
  return report.ok ? 0 : 1;
}
