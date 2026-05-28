import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkflowDefinition } from "@crossengin/workflow-engine";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import { runWorkflow } from "./workflow.js";

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
