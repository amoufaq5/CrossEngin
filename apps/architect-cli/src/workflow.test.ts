import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkflowDefinition } from "@crossengin/workflow-engine";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { formatValidateGhSummary, runWorkflow } from "./workflow.js";

function buffers(): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: {
      io: {
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
      },
      env: {},
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(`parse failed: ${result.error.message}`);
  return result.command;
}

const cleanDefinition: WorkflowDefinition = {
  id: "wfd_clitest123",
  tenantId: "11111111-1111-1111-1111-111111111111",
  definitionKey: "cli.test.workflow",
  version: "1.0.0",
  label: "CLI Test Workflow",
  description: "Used by workflow.test.ts",
  status: "published",
  states: [
    {
      name: "start",
      kind: "initial",
      label: "Start",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
    {
      name: "done",
      kind: "terminal_success",
      label: "Done",
      onEntryActions: [],
      onExitActions: [],
      slaSeconds: null,
    },
  ],
  transitions: [
    {
      name: "finish",
      fromState: "start",
      toState: "done",
      trigger: { kind: "automatic" },
      guards: [],
      preTransitionActions: [],
      postTransitionActions: [],
    },
  ],
  variables: [],
  timers: [],
  signals: [],
  initialState: "start",
  compensationStrategy: "no_compensation",
  timeoutSeconds: 604_800,
  createdAt: "2026-05-01T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
  publishedAt: "2026-05-02T10:00:00.000Z",
  publishedBy: "33333333-3333-3333-3333-333333333333",
  deprecatedAt: null,
  supersededByDefinitionId: null,
  sourceManifestSha256: null,
};

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crossengin-workflow-validate-"));
  const path = join(dir, "def.json");
  await writeFile(path, content);
  return path;
}

describe("runWorkflow dispatch", () => {
  it("exits 2 with usage when no action given", async () => {
    const { ctx, err } = buffers();
    const code = await runWorkflow(parsed("workflow"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("missing action");
  });

  it("exits 2 on unknown action", async () => {
    const { ctx, err } = buffers();
    const code = await runWorkflow(parsed("workflow", "audit"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("unknown action 'audit'");
  });
});

describe("runWorkflow validate", () => {
  it("exits 2 when <def.json> path is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate"), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("missing <def.json>");
  });

  it("exits 1 with clear error when the file doesn't exist", async () => {
    const { ctx, err } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", "/no/such/path.json"), ctx);
    expect(code).toBe(1);
    expect(err()).toContain("failed to read");
  });

  it("exits 2 when the file isn't valid JSON", async () => {
    const path = await tempFile("{ not valid json");
    const { ctx, err } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("not valid JSON");
  });

  it("exits 2 with schema_error when the JSON shape doesn't match the schema", async () => {
    const path = await tempFile(JSON.stringify({ id: "wfd_x" }));
    const { ctx, err } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path), ctx);
    expect(code).toBe(2);
    expect(err()).toContain("schema rejected");
    expect(err()).toContain("schema_error");
  });

  it("exits 0 + 'ok' message on a clean definition", async () => {
    const path = await tempFile(JSON.stringify(cleanDefinition));
    const { ctx, out } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("ok");
    expect(out()).toContain("wfd_clitest123");
    expect(out()).toContain("cli.test.workflow");
  });

  it("exits 3 on validation errors (unknown_variable_in_action) with code in stdout", async () => {
    const broken: WorkflowDefinition = {
      ...cleanDefinition,
      transitions: [
        {
          ...cleanDefinition.transitions[0]!,
          preTransitionActions: [
            { kind: "set_variable", parameters: { variableName: "ghost", value: 1 } },
          ],
        },
      ],
    };
    const path = await tempFile(JSON.stringify(broken));
    const { ctx, out } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path), ctx);
    expect(code).toBe(3);
    expect(out()).toContain("error[unknown_variable_in_action]");
    expect(out()).toContain("ghost");
    expect(out()).toContain("1 error(s)");
  });

  it("exits 0 with warning on unreachable state (warnings don't fail by default)", async () => {
    const withOrphan: WorkflowDefinition = {
      ...cleanDefinition,
      states: [
        ...cleanDefinition.states,
        {
          name: "orphan",
          kind: "terminal_failure",
          label: "Orphan",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    const path = await tempFile(JSON.stringify(withOrphan));
    const { ctx, out } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path), ctx);
    expect(code).toBe(0);
    expect(out()).toContain("warning[unreachable_state]");
    expect(out()).toContain("orphan");
    expect(out()).toContain("1 warning(s)");
  });

  it("--strict promotes warnings to exit 3", async () => {
    const withOrphan: WorkflowDefinition = {
      ...cleanDefinition,
      states: [
        ...cleanDefinition.states,
        {
          name: "orphan",
          kind: "terminal_failure",
          label: "Orphan",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    const path = await tempFile(JSON.stringify(withOrphan));
    const { ctx } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path, "--strict"), ctx);
    expect(code).toBe(3);
  });

  it("--format json emits structured envelope on success", async () => {
    const path = await tempFile(JSON.stringify(cleanDefinition));
    const { ctx, out } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path, "--format", "json"), ctx);
    expect(code).toBe(0);
    const env = JSON.parse(out()) as {
      action: string;
      ok: boolean;
      definitionId: string;
      definitionKey: string;
      errorCount: number;
      warningCount: number;
      issues: unknown[];
    };
    expect(env.action).toBe("workflow.validate");
    expect(env.ok).toBe(true);
    expect(env.definitionId).toBe("wfd_clitest123");
    expect(env.definitionKey).toBe("cli.test.workflow");
    expect(env.errorCount).toBe(0);
    expect(env.warningCount).toBe(0);
    expect(env.issues).toEqual([]);
  });

  it("--format json emits issues array on failure with stable shape", async () => {
    const broken: WorkflowDefinition = {
      ...cleanDefinition,
      transitions: [
        {
          ...cleanDefinition.transitions[0]!,
          preTransitionActions: [{ kind: "schedule_timer", parameters: { timerName: "phantom" } }],
        },
      ],
    };
    const path = await tempFile(JSON.stringify(broken));
    const { ctx, out } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path, "--format", "json"), ctx);
    expect(code).toBe(3);
    const env = JSON.parse(out()) as {
      ok: boolean;
      errorCount: number;
      issues: Array<{ code: string; path: string; severity: string; message: string }>;
    };
    expect(env.ok).toBe(false);
    expect(env.errorCount).toBe(1);
    expect(env.issues).toHaveLength(1);
    expect(env.issues[0]!.code).toBe("unknown_timer_in_action");
    expect(env.issues[0]!.severity).toBe("error");
    expect(env.issues[0]!.path).toBe("transitions[0].preTransitionActions[0].parameters.timerName");
  });

  it("--format json emits schemaError envelope on schema rejection", async () => {
    const path = await tempFile(JSON.stringify({ id: "wfd_x", broken: true }));
    const { ctx, out } = buffers();
    const code = await runWorkflow(parsed("workflow", "validate", path, "--format", "json"), ctx);
    expect(code).toBe(2);
    const env = JSON.parse(out()) as {
      ok: boolean;
      schemaError: boolean;
      issues: Array<{ code: string; severity: string }>;
    };
    expect(env.ok).toBe(false);
    expect(env.schemaError).toBe(true);
    expect(env.issues.length).toBeGreaterThan(0);
    expect(env.issues[0]!.code).toBe("schema_error");
    expect(env.issues[0]!.severity).toBe("error");
  });
});

// M4.15.v — `workflow validate --format gh-summary` Markdown
// rendering for CI step output. Clean definitions emit the success
// verdict; validation errors block with :x:; --strict + warnings
// block with :warning: strict; warnings alone emit a non-blocking
// :warning: passed-with-warnings note. Schema-error path uses the
// same shape with definitionId/Key marked as schema-rejected.
describe("runWorkflow validate --format gh-summary (M4.15.v)", () => {
  it("emits :white_check_mark: verdict for clean definition (no issues)", async () => {
    const { ctx, out } = buffers();
    const path = await tempFile(JSON.stringify(cleanDefinition));
    const code = await runWorkflow(
      parsed("workflow", "validate", path, "--format", "gh-summary"),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("## Workflow validate");
    expect(output).toContain(`**File:** \`${path}\``);
    expect(output).toContain(`**Definition:** \`wfd_clitest123\` (\`cli.test.workflow\`)`);
    expect(output).toContain("**Errors:** 0 | **Warnings:** 0");
    expect(output).toContain(":white_check_mark: **Definition is valid**");
    expect(output).not.toContain("| Severity | Code |");
  });

  it("emits :warning: passed-with-warnings verdict for unreachable-state warning (exit 0)", async () => {
    // Definition with an unreachable terminal state — validateDefinition
    // emits an `unreachable_state` warning (severity: "warning"), so
    // the gate stays open (exit 0) and the gh-summary verdict is the
    // non-blocking "passed with warnings" form.
    const def: WorkflowDefinition = {
      ...cleanDefinition,
      states: [
        ...cleanDefinition.states,
        {
          name: "orphan",
          kind: "terminal_failure",
          label: "Orphan",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    const { ctx, out } = buffers();
    const path = await tempFile(JSON.stringify(def));
    const code = await runWorkflow(
      parsed("workflow", "validate", path, "--format", "gh-summary"),
      ctx,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("## Workflow validate");
    expect(output).toContain("**Errors:** 0 | **Warnings:** 1");
    expect(output).toContain("### Issues (1)");
    expect(output).toContain("| Severity | Code | Path | Message |");
    expect(output).toContain(":warning: warning");
    expect(output).toContain("unreachable_state");
    expect(output).toContain(":warning: **Validation passed with warnings**");
    expect(output).toContain("1 warning(s) (non-blocking)");
  });

  it("--strict promotes warnings to strict-failure verdict (exit 3)", async () => {
    const def: WorkflowDefinition = {
      ...cleanDefinition,
      states: [
        ...cleanDefinition.states,
        {
          name: "orphan",
          kind: "terminal_failure",
          label: "Orphan",
          onEntryActions: [],
          onExitActions: [],
          slaSeconds: null,
        },
      ],
    };
    const { ctx, out } = buffers();
    const path = await tempFile(JSON.stringify(def));
    const code = await runWorkflow(
      parsed("workflow", "validate", path, "--format", "gh-summary", "--strict"),
      ctx,
    );
    expect(code).toBe(3);
    const output = out();
    expect(output).toContain(":warning: **Strict validation failed**");
    expect(output).toContain("1 warning(s) under `--strict`");
  });

  it("schema-error path emits gh-summary with (schema-rejected) definition + :x: verdict", async () => {
    const { ctx, out } = buffers();
    const path = await tempFile('{"id": "not-wfd-prefix"}');
    const code = await runWorkflow(
      parsed("workflow", "validate", path, "--format", "gh-summary"),
      ctx,
    );
    expect(code).toBe(2);
    const output = out();
    expect(output).toContain("## Workflow validate");
    expect(output).toContain("**Definition:** `(schema-rejected)` (`(schema-rejected)`)");
    expect(output).toContain(":x: error");
    expect(output).toContain("schema_error");
    expect(output).toContain(":x: **Validation failed**");
  });

  it("formatValidateGhSummary direct: warnings without --strict emit non-blocking verdict", () => {
    const md = formatValidateGhSummary({
      path: "/tmp/def.json",
      definitionId: "wfd_test",
      definitionKey: "test.workflow",
      issues: [
        {
          severity: "warning",
          code: "dead_end_state",
          path: "states[1]",
          message: "state 'pending' has no outgoing transitions",
        },
      ],
      strict: false,
    });
    expect(md).toContain("**Errors:** 0 | **Warnings:** 1");
    expect(md).toContain(":warning: warning");
    expect(md).toContain(":warning: **Validation passed with warnings**");
    expect(md).toContain("1 warning(s) (non-blocking)");
    expect(md).not.toContain(":x:");
  });

  it("formatValidateGhSummary direct: warnings with --strict emit strict-failure verdict", () => {
    const md = formatValidateGhSummary({
      path: "/tmp/def.json",
      definitionId: "wfd_test",
      definitionKey: "test.workflow",
      issues: [
        {
          severity: "warning",
          code: "dead_end_state",
          path: "states[1]",
          message: "state 'pending' has no outgoing transitions",
        },
      ],
      strict: true,
    });
    expect(md).toContain(":warning: **Strict validation failed**");
    expect(md).toContain("1 warning(s) under `--strict`");
    expect(md).not.toContain(":x:");
  });

  it("formatValidateGhSummary direct: errors-first ordering preserved in mixed-severity table", () => {
    const md = formatValidateGhSummary({
      path: "/tmp/def.json",
      definitionId: "wfd_test",
      definitionKey: "test.workflow",
      issues: [
        {
          severity: "warning",
          code: "dead_end_state",
          path: "states[1]",
          message: "warning A",
        },
        {
          severity: "error",
          code: "unreachable_state",
          path: "states[2]",
          message: "error B",
        },
        {
          severity: "warning",
          code: "dead_end_state",
          path: "states[3]",
          message: "warning C",
        },
      ],
      strict: false,
    });
    // Error should appear before warnings in the table even though
    // it's middle in input order. Find the row positions.
    const errorPos = md.indexOf("error B");
    const warningAPos = md.indexOf("warning A");
    const warningCPos = md.indexOf("warning C");
    expect(errorPos).toBeGreaterThan(-1);
    expect(errorPos).toBeLessThan(warningAPos);
    expect(errorPos).toBeLessThan(warningCPos);
    // Verdict reflects errors take precedence.
    expect(md).toContain(":x: **Validation failed** — 1 error(s) block publish.");
  });

  it("formatValidateGhSummary direct: pipe characters in message are escaped", () => {
    const md = formatValidateGhSummary({
      path: "/tmp/def.json",
      definitionId: "wfd_test",
      definitionKey: "test.workflow",
      issues: [
        {
          severity: "error",
          code: "unknown_variable_in_action",
          path: "transitions[0]",
          message: "variable a|b|c not found",
        },
      ],
      strict: false,
    });
    expect(md).toContain("variable a\\|b\\|c not found");
  });
});
