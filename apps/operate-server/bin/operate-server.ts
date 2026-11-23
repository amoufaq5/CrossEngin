#!/usr/bin/env node

import {
  CliUsageError,
  helpText,
  columnSchemaHelpText,
  documentIndexesHelpText,
  parseColumnSchemaArgs,
  parseDocumentIndexesArgs,
  parsePruneArgs,
  parseServeArgs,
  parseVerifyChainArgs,
  pruneHelpText,
  verifyChainHelpText,
  parseReplayArgs,
  replayHelpText,
  parseRekeyArgs,
  rekeyHelpText,
  parseSetCredentialArgs,
  setCredentialCliHelpText,
} from "../src/cli.js";
import { formatMultiTenantReport } from "../src/link-sweep.js";
import { formatChainVerification } from "../src/chain-verify.js";
import {
  anchorAuditHasFindings,
  formatAnchorAudit,
  formatChainTruncation,
  verificationExaminedNothing,
} from "../src/anchor-audit.js";
import {
  runColumnSchema,
  runDocumentIndexes,
  runPruneLinks,
  runBillWithholdingBackfill,
  runRekey,
  runReplay,
  runVerifyChain,
  serve,
} from "../src/node.js";
import { formatReplayReport } from "../src/replay.js";
import { resolveHttpListenerSettings } from "../src/http-listener.js";
import { installProcessLifecycle } from "../src/process-lifecycle.js";

/** The time a shutdown may spend past the listener's grace on the drains and the pool's close. */
const SHUTDOWN_DRAIN_ALLOWANCE_MS = 2_000;
import { formatRekeyColumnKeys, formatRekeyResult, formatRekeySurvey, formatRewrapKek } from "../src/rekey.js";
import { formatSetCredentialReport, runSetCredential } from "../src/set-credential.js";
import { billWithholdingBackfillCommand } from "../src/bill-withholding-backfill-command.js";
import {
  aiPseudonymLookupHelpText,
  formatAiPseudonymLookupReport,
  parseAiPseudonymLookupArgs,
  runAiPseudonymLookup,
} from "../src/ai-pseudonym-lookup.js";

const CLI_VERSION = "0.0.0";

async function runPrune(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parsePruneArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${pruneHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(pruneHelpText);
    return 0;
  }
  const report = await runPruneLinks(options);
  process.stdout.write(formatMultiTenantReport(report));
  return 0;
}

/**
 * `document-indexes`: the owner's one-shot that builds --store pg's unique indexes before the API,
 * which cannot (it owns nothing). Every index outcome is printed; duplicates already in the table
 * are a warning and exit 0 (ADR-0360: deduplicating is an operator's act, and the API still serves),
 * while any other failure exits 1 so compose does not start an API whose guarantee was never built.
 */
async function runDocIndexes(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseDocumentIndexesArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${documentIndexesHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(documentIndexesHelpText);
    return 0;
  }
  const report = await runDocumentIndexes(options);
  let fatal = 0;
  for (const r of report.results) {
    const name = `${r.index.entity}.${r.index.field}`;
    if (r.outcome === "enforced") {
      process.stdout.write(`[document-indexes] ${name}: enforced (${r.index.name})\n`);
    } else if (r.outcome === "existing_duplicates") {
      process.stderr.write(
        `[document-indexes] ${name}: NOT enforced — rows already hold duplicates. Deduplicate, then re-run.` +
          ` Statement: ${r.index.sql}\n`,
      );
    } else {
      fatal += 1;
      process.stderr.write(`[document-indexes] ${name}: NOT enforced (${r.outcome}): ${r.detail ?? ""}\n`);
    }
  }
  for (const stale of report.stale) {
    process.stderr.write(
      `[document-indexes] ${stale.name} is no longer declared by this manifest and is left in place: ${stale.dropSql}\n`,
    );
  }
  process.stdout.write(
    `[document-indexes] ${report.results.length.toString()} declared unique field(s);` +
      ` ${report.results.filter((r) => r.outcome === "enforced").length.toString()} enforced\n`,
  );
  return fatal === 0 ? 0 : 1;
}

/**
 * `column-schema`: the owner's one-shot that applies --store pg-columns' tables and grants the
 * serving role its DML, which the API cannot do as a role that owns nothing. A failed statement or
 * grant throws (exit 1); a unique index blocked by existing duplicates is printed and does not.
 */
async function runColumnSchemaCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseColumnSchemaArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${columnSchemaHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(columnSchemaHelpText);
    return 0;
  }
  const report = await runColumnSchema(options);
  for (const r of report.uniqueIndexRefusals) {
    process.stderr.write(
      `[column-schema] ${r.entity}: a declared unique field is NOT enforced (${r.detail}). Deduplicate, then run: ${r.sql}\n`,
    );
  }
  process.stdout.write(
    `[column-schema] schema '${report.schema ?? "(none)"}' applied; ${report.grants.length.toString()} grant statement(s)` +
      `${options.grantTo.length > 0 ? ` to ${options.grantTo.join(", ")}` : ""}\n`,
  );
  return 0;
}

async function runVerify(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseVerifyChainArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${verifyChainHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(verifyChainHelpText);
    return 0;
  }
  const report = await runVerifyChain(options);
  // The headline is this command's verdict, so it is composed here rather than taken from
  // `formatChainVerification`, which can only speak for the fold. A fold over zero entries is
  // vacuously valid on both halves, so that function printed `OK` for a scope whose history was
  // destroyed — with `signatures: valid (0 checked)` one line below it, which is the honest half
  // contradicting the headline.
  const examinedNothing = verificationExaminedNothing(
    report.chain.signatures.checked,
    report.truncation,
  );
  const verdict = report.truncation.truncated
    ? "TRUNCATED"
    : examinedNothing
      ? "NO HISTORY — nothing was examined"
      : null;
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${report.trust}\n${formatChainVerification(report.chain)}\n${[
          ...formatAnchorAudit(report.anchors),
          ...formatChainTruncation(report.truncation),
        ]
          .map((l) => `  ${l}`)
          .join("\n")}\n${verdict === null ? "" : `  verdict: ${verdict}\n`}`,
  );
  // `chain.ok` is not the whole verdict, and ADR-0374's own Option B rejection says why: a full fold
  // over a sound chain answers `ok: true`, so a pass whose stored **anchor** is a finding reads as a
  // healthy verification. That increment closed it for the hourly `proveScopeIntegrity` and patched
  // it here by reading `fullBecause` through `anchoringWouldBury` — which is a statement about the
  // **newest** anchor alone, so a refused or relocated row anywhere else still exited 0 printing
  // "OK", and `verify-chain` without `--from-checkpoint` could not see one at all, because
  // `verifyChainFull` never read that table. The weaker command caught it and the stronger did not.
  //
  // `anchorAuditHasFindings` is the predicate, and it is the **wider** of the audit's two: this
  // command is a by-hand auditor whose help text frames the exit code as the verdict, so a scan the
  // ceiling stopped must not exit 0 either — it did not read the whole table, and reporting a
  // verdict over a set it did not read is the claim ADR-0372 is about. `proveScopeIntegrity` grades
  // the same condition `unproven` rather than `compromised`, for the same reason and with a third
  // answer available to it that an exit code does not have.
  // The truncation check joins the conjunction, and it is the one of the three that this command
  // did not compute at all. A fold cannot see truncation and the anchor audit deliberately does not
  // call a witness the chain fails to reach a *disagreement* (that is this check's subject), so the
  // condition separating "nothing happened" from "the history was destroyed" fell between them:
  // measured live, a scope with a checkpoint at sequence 7 and zero entries printed `witness 7`
  // beside `signatures: valid (0 checked)` and exited 0 saying OK.
  //
  // `examinedNothing` deliberately does **not** join it. A scope with no witness and no entries is a
  // question nobody can answer from these two tables — a new tenant and a tenant whose chain *and*
  // checkpoints were deleted are byte-identical here — so it is named in the output and exits 0,
  // because failing it would fail every scope before its first audited request and the repo's exit
  // vocabulary has no third value (2 is a usage error). ADR-0375's open end 2 is what would close
  // it, and it needs the chain's memory of a prior witness.
  return report.chain.ok &&
    !anchorAuditHasFindings(report.anchors) &&
    !report.truncation.truncated
    ? 0
    : 1;
}

async function runReplayCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseReplayArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${replayHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(replayHelpText);
    return 0;
  }
  const report = await runReplay(options);
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReplayReport(report)}\n`,
  );
  // Non-zero for a refused or failed section as well as for a finding: "0 findings" from a
  // subsystem that could not be read must not exit 0, or a maintenance job launders an unread
  // subsystem into a pass. `summarizeReplay` carries that rule; this is just its exit code.
  return report.ok ? 0 : 1;
}

async function runRekeyCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseRekeyArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${rekeyHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(rekeyHelpText);
    return 0;
  }
  const report = await runRekey(options);
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    // The column-key pre-flight first (ADR-0460): on a refusal it is the only thing that ran.
    process.stdout.write(`${formatRekeyColumnKeys(report.keyConsistency)}\n`);
    // The survey either way, including after a completed rekey: it is what names the columns and
    // the row counts, and a result printed alone would not say what was examined.
    if (report.rewrap !== null) {
      process.stdout.write(`${formatRewrapKek(report.rewrap, options.plan)}\n`);
    } else if (report.survey !== null && report.writeStatus !== null) {
      process.stdout.write(`${formatRekeySurvey(report.survey, report.writeStatus)}\n`);
    }
    if (report.result !== null) {
      process.stdout.write(`\n${formatRekeyResult(report.result, report.staleKeyWindowMs, report.staleKeyWindowStated)}\n`);
    }
  }
  // A refused survey exits 1 and a clean plan exits 0, following `replay`: a plan that printed
  // nothing actionable must not be indistinguishable from a refusal nobody read.
  return report.ok ? 0 : 1;
}

async function runSetCredentialCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseSetCredentialArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${setCredentialCliHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(setCredentialCliHelpText);
    return 0;
  }
  const report = await runSetCredential(options);
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatSetCredentialReport(report)}\n`,
  );
  return report.ok ? 0 : 1;
}

/** `ai-pseudonym-lookup`: a vendor report's `ctp_` pseudonym back to the tenant (ADR-0461). */
async function runAiPseudonymLookupCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseAiPseudonymLookupArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${aiPseudonymLookupHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(aiPseudonymLookupHelpText);
    return 0;
  }
  const report = await runAiPseudonymLookup(options);
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatAiPseudonymLookupReport(report)}\n`,
  );
  return report.ok ? 0 : 1;
}

async function main(): Promise<number> {

  const argv = process.argv.slice(2);
  if (argv[0] === "document-indexes") {
    return runDocIndexes(argv.slice(1));
  }
  if (argv[0] === "column-schema") {
    return runColumnSchemaCommand(argv.slice(1));
  }
  if (argv[0] === "prune-links") {
    return runPrune(argv.slice(1));
  }
  if (argv[0] === "rekey") {
    return runRekeyCommand(argv.slice(1));
  }
  if (argv[0] === "backfill-bill-withholding") {
    return billWithholdingBackfillCommand(argv.slice(1), {
      run: (options) => runBillWithholdingBackfill(options),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  }
  if (argv[0] === "verify-chain") {
    return runVerify(argv.slice(1));
  }
  if (argv[0] === "replay") {
    return runReplayCommand(argv.slice(1));
  }
  if (argv[0] === "set-credential") {
    return runSetCredentialCommand(argv.slice(1));
  }
  if (argv[0] === "ai-pseudonym-lookup") {
    return runAiPseudonymLookupCommand(argv.slice(1));
  }

  let options;
  try {
    options = parseServeArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${helpText}`);
      return 2;
    }
    throw err;
  }

  if (options.help) {
    process.stdout.write(helpText);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const running = await serve(options);
  const source = options.pack !== null ? `pack ${options.pack}` : `manifest ${options.manifestPath ?? ""}`;
  process.stdout.write(
    `operate-server listening on http://localhost:${running.port.toString()} (${source}, store=${options.store})\n`,
  );

  installProcessLifecycle(process, {
    close: () => running.close(),
    log: (line) => process.stderr.write(`${line}\n`),
    deadlineMs: resolveHttpListenerSettings(options.httpListener).shutdownGraceMs + SHUTDOWN_DRAIN_ALLOWANCE_MS,
  });
  return -1; // keep the process alive; the server holds the event loop
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${detail}\n`);
    process.exit(1);
  });
