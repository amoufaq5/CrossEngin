import type {
  ArchitectMessageRecord,
  ArchitectProposalRecord,
  ArchitectSessionRecord,
  ArchitectToolInvocationRecord,
} from "@crossengin/ai-architect";
import {
  PostgresArchitectMessageStore,
  PostgresArchitectProposalStore,
  PostgresArchitectSessionStore,
  PostgresArchitectToolInvocationStore,
} from "@crossengin/ai-architect-pg";
import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";

import { DEFAULT_TENANT_ID } from "./chat.js";
import type { ParsedCommand } from "./cli.js";
import { getStringFlag } from "./cli.js";
import type { RunContext } from "./commands.js";
import { printError, printJson, printSuccess } from "./format.js";

const DEFAULT_LIST_LIMIT = 20;

export interface SessionsStores {
  readonly sessions: PostgresArchitectSessionStore;
  readonly messages: PostgresArchitectMessageStore;
  readonly toolInvocations: PostgresArchitectToolInvocationStore;
  readonly proposals: PostgresArchitectProposalStore;
}

export interface SessionsContext extends RunContext {
  readonly storesOverride?: SessionsStores;
}

interface ResolvedHandle {
  readonly stores: SessionsStores;
  readonly close: () => Promise<void>;
}

export async function runSessions(
  command: ParsedCommand,
  ctx: SessionsContext,
): Promise<number> {
  const action = command.positional[0];
  if (action === undefined) {
    printError(
      ctx.io,
      "sessions: missing action. usage: crossengin sessions <list|show|replay> [args]",
    );
    return 2;
  }
  const handle = await resolveStores(ctx);
  if (handle === null) return 1;
  try {
    switch (action) {
      case "list":
        return await runSessionsList(command, ctx, handle.stores);
      case "show":
        return await runSessionsShow(command, ctx, handle.stores);
      case "replay":
        return await runSessionsReplay(command, ctx, handle.stores);
      default:
        printError(
          ctx.io,
          `sessions: unknown action '${action}'. expected one of: list, show, replay`,
        );
        return 2;
    }
  } finally {
    await handle.close();
  }
}

async function resolveStores(ctx: SessionsContext): Promise<ResolvedHandle | null> {
  if (ctx.storesOverride !== undefined) {
    return { stores: ctx.storesOverride, close: async () => undefined };
  }
  let conn: PgConnection;
  try {
    const config = parsePgEnvConfig(ctx.env);
    conn = createNodePgConnection(config);
  } catch (err) {
    printError(
      ctx.io,
      `sessions: requires PG env vars (PGHOST/PGDATABASE/...): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const stores: SessionsStores = {
    sessions: new PostgresArchitectSessionStore(conn),
    messages: new PostgresArchitectMessageStore(conn),
    toolInvocations: new PostgresArchitectToolInvocationStore(conn),
    proposals: new PostgresArchitectProposalStore(conn),
  };
  return {
    stores,
    close: async () => {
      await conn.close().catch(() => undefined);
    },
  };
}

async function runSessionsList(
  command: ParsedCommand,
  ctx: RunContext,
  stores: SessionsStores,
): Promise<number> {
  const tenantId = getStringFlag(command, "tenant-id") ?? DEFAULT_TENANT_ID;
  const limitFlag = getStringFlag(command, "limit");
  const limit =
    limitFlag !== null ? Number.parseInt(limitFlag, 10) : DEFAULT_LIST_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    printError(ctx.io, `sessions list: invalid --limit: ${limitFlag ?? ""}`);
    return 2;
  }
  const records = await stores.sessions.listForTenant({ tenantId, limit });
  if (command.format === "json") {
    printJson(ctx.io, { tenantId, count: records.length, sessions: records });
    return 0;
  }
  if (records.length === 0) {
    printSuccess(ctx.io, `no sessions for tenant ${tenantId}`);
    return 0;
  }
  ctx.io.stdout.write(formatSessionsTable(records) + "\n");
  return 0;
}

async function runSessionsShow(
  command: ParsedCommand,
  ctx: RunContext,
  stores: SessionsStores,
): Promise<number> {
  const sessionRef = command.positional[1];
  if (sessionRef === undefined) {
    printError(
      ctx.io,
      "sessions show: missing session id. usage: crossengin sessions show <session-id>",
    );
    return 2;
  }
  const tenantId = getStringFlag(command, "tenant-id") ?? DEFAULT_TENANT_ID;
  const session = await resolveSession(stores, tenantId, sessionRef);
  if (session === null) {
    printError(ctx.io, `sessions show: no session '${sessionRef}' for tenant ${tenantId}`);
    return 1;
  }
  const [messages, invocations, proposals] = await Promise.all([
    stores.messages.listForSession(session.id),
    stores.toolInvocations.listForSession(session.id),
    stores.proposals.listForSession(session.id),
  ]);
  if (command.format === "json") {
    printJson(ctx.io, { session, messages, invocations, proposals });
    return 0;
  }
  ctx.io.stdout.write(formatSessionShow({ session, messages, invocations, proposals }));
  return 0;
}

async function runSessionsReplay(
  command: ParsedCommand,
  ctx: RunContext,
  stores: SessionsStores,
): Promise<number> {
  const sessionRef = command.positional[1];
  if (sessionRef === undefined) {
    printError(
      ctx.io,
      "sessions replay: missing session id. usage: crossengin sessions replay <session-id>",
    );
    return 2;
  }
  const tenantId = getStringFlag(command, "tenant-id") ?? DEFAULT_TENANT_ID;
  const session = await resolveSession(stores, tenantId, sessionRef);
  if (session === null) {
    printError(ctx.io, `sessions replay: no session '${sessionRef}' for tenant ${tenantId}`);
    return 1;
  }
  const messages = await stores.messages.listForSession(session.id);
  if (command.format === "json") {
    printJson(ctx.io, { session, messages });
    return 0;
  }
  ctx.io.stdout.write(formatSessionReplay({ session, messages }));
  return 0;
}

async function resolveSession(
  stores: SessionsStores,
  tenantId: string,
  ref: string,
): Promise<ArchitectSessionRecord | null> {
  if (isUuid(ref)) {
    const byId = await stores.sessions.getById(ref);
    if (byId !== null && byId.tenantId === tenantId) return byId;
  }
  return stores.sessions.getBySessionId({ tenantId, sessionId: ref });
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function formatSessionsTable(records: readonly ArchitectSessionRecord[]): string {
  const headers = ["session_id", "model", "started_at", "turns", "cost_usd", "status"];
  const rows = records.map((r) => [
    r.sessionId,
    r.model,
    r.startedAt,
    r.turnCount.toString(),
    r.costUsd.toFixed(6),
    r.endedAt === null ? "in_progress" : "ended",
  ]);
  return renderTable(headers, rows);
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const lines: string[] = [];
  lines.push(headers.map((h, i) => h.padEnd(widths[i]!)).join("  "));
  lines.push(sep);
  for (const row of rows) {
    lines.push(row.map((c, i) => c.padEnd(widths[i]!)).join("  "));
  }
  return lines.join("\n");
}

export interface SessionDetail {
  readonly session: ArchitectSessionRecord;
  readonly messages: readonly ArchitectMessageRecord[];
  readonly invocations: readonly ArchitectToolInvocationRecord[];
  readonly proposals: readonly ArchitectProposalRecord[];
}

export function formatSessionShow(detail: SessionDetail): string {
  const { session, messages, invocations, proposals } = detail;
  const lines: string[] = [];
  lines.push(`Session: ${session.sessionId} (${session.id})`);
  lines.push(`  tenant:       ${session.tenantId}`);
  lines.push(`  model:        ${session.model}`);
  lines.push(`  started_at:   ${session.startedAt}`);
  lines.push(`  ended_at:     ${session.endedAt ?? "(in progress)"}`);
  lines.push(`  turns:        ${session.turnCount.toString()}`);
  lines.push(
    `  tokens:       in=${session.inputTokens.toString()} out=${session.outputTokens.toString()} cached=${session.cachedInputTokens.toString()}`,
  );
  lines.push(`  cost_usd:     ${session.costUsd.toFixed(6)}`);
  if (session.systemPromptSha256 !== null) {
    lines.push(`  system_sha:   ${session.systemPromptSha256.slice(0, 16)}…`);
  }
  lines.push("");
  lines.push(`Messages (${messages.length.toString()}):`);
  for (const m of messages) {
    lines.push(formatMessageLine(m));
  }
  if (invocations.length > 0) {
    lines.push("");
    lines.push(`Tool invocations (${invocations.length.toString()}):`);
    for (const inv of invocations) {
      lines.push(formatToolInvocationLine(inv));
    }
  }
  if (proposals.length > 0) {
    lines.push("");
    lines.push(`Write proposals (${proposals.length.toString()}):`);
    for (const p of proposals) {
      lines.push(formatProposalLine(p));
    }
  }
  return lines.join("\n") + "\n";
}

function formatMessageLine(m: ArchitectMessageRecord): string {
  const base = `  [${m.turnIndex.toString()}.${m.messageIndex.toString()}] ${m.role.padEnd(9)} ${truncate(m.content, 120)}`;
  if (m.toolUses !== null && m.toolUses.length > 0) {
    const names = m.toolUses.map((u) => u.name).join(", ");
    return `${base}\n    → tool_uses: ${names}`;
  }
  return base;
}

function formatToolInvocationLine(inv: ArchitectToolInvocationRecord): string {
  const status = inv.isError ? "ERROR" : "OK";
  const duration = inv.durationMs !== null ? ` (${inv.durationMs.toString()}ms)` : "";
  return `  [${inv.toolCallId}] ${inv.toolName.padEnd(28)} ${status}${duration} → ${truncate(inv.output, 100)}`;
}

function formatProposalLine(p: ArchitectProposalRecord): string {
  const action = p.isNew ? "CREATE" : "UPDATE";
  const applied = p.applied ? "applied" : "not applied";
  const change = `+${p.entitiesAdded.toString()} -${p.entitiesRemoved.toString()} ~${p.entitiesModified.toString()}`;
  return `  ${action} ${p.targetPath} ${p.decision} ${applied} (${change}) hash=${p.newHash.slice(0, 12)}…`;
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\n/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit) + "…";
}

export function formatSessionReplay(input: {
  readonly session: ArchitectSessionRecord;
  readonly messages: readonly ArchitectMessageRecord[];
}): string {
  const { session, messages } = input;
  const lines: string[] = [];
  lines.push(`=== Replay: ${session.sessionId} (${session.model}, ${session.startedAt}) ===\n`);
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`You: ${m.content}`);
    } else if (m.role === "assistant") {
      const usage =
        m.inputTokens !== null && m.outputTokens !== null
          ? ` [tokens in=${m.inputTokens.toString()} out=${m.outputTokens.toString()}` +
            (m.costUsd !== null ? ` cost=$${m.costUsd.toFixed(6)}` : "") +
            "]"
          : "";
      const toolList =
        m.toolUses !== null && m.toolUses.length > 0
          ? ` (tools: ${m.toolUses.map((u) => u.name).join(", ")})`
          : "";
      lines.push(`Architect: ${m.content}${toolList}${usage}`);
    } else if (m.role === "tool") {
      lines.push(`  [tool result ← ${m.toolCallId ?? "?"}] ${truncate(m.content, 200)}`);
    } else {
      lines.push(`[${m.role}] ${truncate(m.content, 200)}`);
    }
  }
  lines.push("");
  lines.push(
    `=== Session ended: ${session.turnCount.toString()} turn(s); ` +
      `in=${session.inputTokens.toString()} out=${session.outputTokens.toString()} ` +
      `cost=$${session.costUsd.toFixed(6)} ===`,
  );
  return lines.join("\n") + "\n";
}

