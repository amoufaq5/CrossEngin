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
  } else {
    renderHumanResult(ctx, definition.id, definition.definitionKey, result.issues);
  }

  if (errorCount > 0) return 3;
  if (strict && warningCount > 0) return 3;
  return 0;
}

function renderSchemaErrors(
  command: ParsedCommand,
  ctx: RunContext,
  path: string,
  err: z.ZodError,
): number {
  if (command.format === "json") {
    printJson(ctx.io, {
      action: "workflow.validate",
      path,
      ok: false,
      schemaError: true,
      issues: err.issues.map((i) => ({
        code: "schema_error",
        path: i.path.join("."),
        message: i.message,
        severity: "error",
      })),
    });
  } else {
    ctx.io.stderr.write(`workflow validate: schema rejected ${path}\n`);
    for (const i of err.issues) {
      const pathStr = i.path.length > 0 ? i.path.join(".") : "(root)";
      ctx.io.stderr.write(`  schema_error at ${pathStr}: ${i.message}\n`);
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
