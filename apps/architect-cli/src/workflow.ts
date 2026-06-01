import { readFile } from "node:fs/promises";

import {
  validateDefinition,
  WorkflowDefinitionSchema,
  type WorkflowValidationIssue,
} from "@crossengin/workflow-engine";
import type { z } from "zod";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson } from "./format.js";

export async function runWorkflow(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(ctx.io, "workflow: missing action. usage: crossengin workflow validate <def.json>");
    return 2;
  }
  if (action === "validate") {
    return runWorkflowValidate(command, ctx);
  }
  printError(ctx.io, `workflow: unknown action '${action}'. expected: validate`);
  return 2;
}

async function runWorkflowValidate(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const path = command.positional[1];
  if (path === undefined) {
    printError(ctx.io, "workflow validate: missing <def.json> path");
    return 2;
  }
  const strict = getBooleanFlag(command, "strict");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    printError(
      ctx.io,
      `workflow validate: failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    printError(
      ctx.io,
      `workflow validate: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  const parseResult = WorkflowDefinitionSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    return renderSchemaErrors(command, ctx, path, parseResult.error);
  }
  const definition = parseResult.data;
  const result = validateDefinition(definition);

  const errorCount = result.issues.filter((i) => i.severity === "error").length;
  const warningCount = result.issues.filter((i) => i.severity === "warning").length;

  if (command.format === "json") {
    printJson(ctx.io, {
      action: "workflow.validate",
      path,
      ok: result.ok,
      definitionId: definition.id,
      definitionKey: definition.definitionKey,
      errorCount,
      warningCount,
      issues: result.issues,
    });
  } else if (command.format === "gh-summary") {
    // M4.15.v — Markdown summary for CI step output. Operators
    // redirect `crossengin workflow validate def.json --format
    // gh-summary >> $GITHUB_STEP_SUMMARY` to surface validation
    // issues in the run UI with a clear verdict emoji. Same shape
    // conventions as M4.15.e/i (## header + metadata + table +
    // verdict footer). The verdict reflects the exit-code semantic
    // (errors → :x: gate failed; --strict + warnings → :warning:
    // strict gate failed; clean → :white_check_mark:).
    ctx.io.stdout.write(
      formatValidateGhSummary({
        path,
        definitionId: definition.id,
        definitionKey: definition.definitionKey,
        issues: result.issues,
        strict,
      }),
    );
  } else {
    renderHumanResult(ctx, definition.id, definition.definitionKey, result.issues);
  }

  if (errorCount > 0) return 3;
  if (strict && warningCount > 0) return 3;
  return 0;
}

// M4.15.v — gh-summary Markdown for `workflow validate`. Renders
// a 4-col table (Severity | Code | Path | Message). Errors first,
// then warnings (operators triaging in CI see the blocking issues
// at the top of the table). Verdict footer reflects the gate
// semantic — pristine, error, or strict-warning failure.
// Subset of WorkflowValidationIssue that's permissive enough to
// accept synthetic schema_error issues (whose code is the string
// "schema_error", outside the WorkflowValidationCode literal union).
// Renderer only needs severity/code/path/message — full Issue type
// coupling would force the schema-error path to fabricate a fake
// validation code.
export interface ValidationIssueLike {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export function formatValidateGhSummary(input: {
  readonly path: string;
  readonly definitionId: string;
  readonly definitionKey: string;
  readonly issues: readonly ValidationIssueLike[];
  readonly strict: boolean;
}): string {
  const lines: string[] = [];
  const errors = input.issues.filter((i) => i.severity === "error");
  const warnings = input.issues.filter((i) => i.severity === "warning");
  lines.push(`## Workflow validate`);
  lines.push("");
  lines.push(`**File:** \`${input.path}\`  `);
  lines.push(`**Definition:** \`${input.definitionId}\` (\`${input.definitionKey}\`)  `);
  lines.push(`**Errors:** ${errors.length} | **Warnings:** ${warnings.length}`);
  lines.push("");
  if (errors.length === 0 && warnings.length === 0) {
    lines.push(`:white_check_mark: **Definition is valid** — no issues found.`);
    return lines.join("\n") + "\n";
  }
  lines.push(`### Issues (${input.issues.length})`);
  lines.push("");
  lines.push(`| Severity | Code | Path | Message |`);
  lines.push(`|----------|------|------|---------|`);
  // Errors first so blocking issues surface at the top of the table.
  for (const issue of errors) {
    lines.push(formatValidateRow(issue));
  }
  for (const issue of warnings) {
    lines.push(formatValidateRow(issue));
  }
  lines.push("");
  if (errors.length > 0) {
    lines.push(`:x: **Validation failed** — ${errors.length} error(s) block publish.`);
  } else if (input.strict && warnings.length > 0) {
    lines.push(
      `:warning: **Strict validation failed** — ${warnings.length} warning(s) under \`--strict\`.`,
    );
  } else {
    lines.push(
      `:warning: **Validation passed with warnings** — ${warnings.length} warning(s) (non-blocking).`,
    );
  }
  return lines.join("\n") + "\n";
}

function formatValidateRow(issue: ValidationIssueLike): string {
  // Markdown pipe-escape in message (paths + codes are kebab-case so
  // no escaping needed in those cells).
  const safeMsg = issue.message.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const severityCell = issue.severity === "error" ? ":x: error" : ":warning: warning";
  return `| ${severityCell} | \`${issue.code}\` | \`${issue.path}\` | ${safeMsg} |`;
}

function renderSchemaErrors(
  command: ParsedCommand,
  ctx: RunContext,
  path: string,
  err: z.ZodError,
): number {
  const schemaIssues = err.issues.map((i) => ({
    code: "schema_error",
    path: i.path.length > 0 ? i.path.join(".") : "(root)",
    message: i.message,
    severity: "error" as const,
  }));
  if (command.format === "json") {
    printJson(ctx.io, {
      action: "workflow.validate",
      path,
      ok: false,
      schemaError: true,
      issues: schemaIssues,
    });
  } else if (command.format === "gh-summary") {
    // M4.15.v — schema-error path renders the same gh-summary
    // shape (## header + table + verdict) but with definitionId/Key
    // unknown (the schema parse failed before they could be read).
    // Verdict is always :x: since schema errors are unconditionally
    // blocking. issues come from ZodError mapped to the
    // WorkflowValidationIssue shape.
    ctx.io.stdout.write(
      formatValidateGhSummary({
        path,
        definitionId: "(schema-rejected)",
        definitionKey: "(schema-rejected)",
        issues: schemaIssues,
        strict: false,
      }),
    );
  } else {
    ctx.io.stderr.write(`workflow validate: schema rejected ${path}\n`);
    for (const i of schemaIssues) {
      ctx.io.stderr.write(`  schema_error at ${i.path}: ${i.message}\n`);
    }
  }
  return 2;
}

function renderHumanResult(
  ctx: RunContext,
  definitionId: string,
  definitionKey: string,
  issues: readonly WorkflowValidationIssue[],
): void {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (errors.length === 0 && warnings.length === 0) {
    ctx.io.stdout.write(`workflow validate: ok — ${definitionId} (${definitionKey})\n`);
    return;
  }

  const summary = `${errors.length} error(s), ${warnings.length} warning(s)`;
  ctx.io.stdout.write(`workflow validate: ${definitionId} (${definitionKey}) — ${summary}\n`);
  for (const issue of errors) {
    ctx.io.stdout.write(`  error[${issue.code}] ${issue.path}: ${issue.message}\n`);
  }
  for (const issue of warnings) {
    ctx.io.stdout.write(`  warning[${issue.code}] ${issue.path}: ${issue.message}\n`);
  }
}
