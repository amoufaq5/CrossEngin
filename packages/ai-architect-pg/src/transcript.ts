import type {
  ArchitectMessageRecord,
  ArchitectProposalDecision,
  ArchitectProposalRecord,
  ArchitectSessionRecord,
  ArchitectToolInvocationRecord,
} from "@crossengin/ai-architect";

export interface OnSessionStartInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly systemPromptSha256: string | null;
}

export interface OnMessageInput {
  readonly turnIndex: number;
  readonly messageIndex: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string | null;
  readonly toolUses?:
    | ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }>
    | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly costUsd?: number | null;
}

export interface OnToolInvocationInput {
  readonly messageId: string | null;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: string;
  readonly isError: boolean;
  readonly durationMs: number | null;
}

export interface OnProposalInput {
  readonly toolInvocationId: string | null;
  readonly targetPath: string;
  readonly isNew: boolean;
  readonly oldHash: string | null;
  readonly newHash: string;
  readonly entitiesAdded: number;
  readonly entitiesRemoved: number;
  readonly entitiesModified: number;
  readonly decision: ArchitectProposalDecision;
  readonly applied: boolean;
  readonly denialReason: string | null;
}

export interface OnSessionEndInput {
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
}

export interface Transcript {
  onSessionStart(input: OnSessionStartInput): Promise<ArchitectSessionRecord>;
  onMessage(input: OnMessageInput): Promise<ArchitectMessageRecord>;
  onToolInvocation(input: OnToolInvocationInput): Promise<ArchitectToolInvocationRecord>;
  onProposal(input: OnProposalInput): Promise<ArchitectProposalRecord>;
  onSessionEnd(input: OnSessionEndInput): Promise<ArchitectSessionRecord | null>;
}

import type { PgConnection } from "@crossengin/kernel-pg";

import {
  PostgresArchitectMessageStore,
  type AppendMessageInput,
} from "./message-store.js";
import {
  PostgresArchitectProposalStore,
  type AppendProposalInput,
} from "./proposal-store.js";
import {
  PostgresArchitectSessionStore,
  type StartSessionInput,
} from "./session-store.js";
import {
  PostgresArchitectToolInvocationStore,
  type AppendToolInvocationInput,
} from "./tool-invocation-store.js";

export class PostgresTranscript implements Transcript {
  private readonly sessions: PostgresArchitectSessionStore;
  private readonly messages: PostgresArchitectMessageStore;
  private readonly toolInvocations: PostgresArchitectToolInvocationStore;
  private readonly proposals: PostgresArchitectProposalStore;
  private sessionId: string | null = null;
  private tenantId: string | null = null;

  constructor(conn: PgConnection) {
    this.sessions = new PostgresArchitectSessionStore(conn);
    this.messages = new PostgresArchitectMessageStore(conn);
    this.toolInvocations = new PostgresArchitectToolInvocationStore(conn);
    this.proposals = new PostgresArchitectProposalStore(conn);
  }

  async onSessionStart(input: OnSessionStartInput): Promise<ArchitectSessionRecord> {
    const start: StartSessionInput = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      model: input.model,
      systemPromptSha256: input.systemPromptSha256,
    };
    const record = await this.sessions.startSession(start);
    this.sessionId = record.id;
    this.tenantId = record.tenantId;
    return record;
  }

  async onMessage(input: OnMessageInput): Promise<ArchitectMessageRecord> {
    this.requireSession("onMessage");
    const append: AppendMessageInput = {
      tenantId: this.tenantId!,
      sessionId: this.sessionId!,
      turnIndex: input.turnIndex,
      messageIndex: input.messageIndex,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId ?? null,
      toolUses: input.toolUses ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cachedInputTokens: input.cachedInputTokens ?? null,
      costUsd: input.costUsd ?? null,
    };
    return this.messages.append(append);
  }

  async onToolInvocation(
    input: OnToolInvocationInput,
  ): Promise<ArchitectToolInvocationRecord> {
    this.requireSession("onToolInvocation");
    const append: AppendToolInvocationInput = {
      tenantId: this.tenantId!,
      sessionId: this.sessionId!,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
      output: input.output,
      isError: input.isError,
      durationMs: input.durationMs,
    };
    return this.toolInvocations.append(append);
  }

  async onProposal(input: OnProposalInput): Promise<ArchitectProposalRecord> {
    this.requireSession("onProposal");
    const append: AppendProposalInput = {
      tenantId: this.tenantId!,
      sessionId: this.sessionId!,
      toolInvocationId: input.toolInvocationId,
      targetPath: input.targetPath,
      isNew: input.isNew,
      oldHash: input.oldHash,
      newHash: input.newHash,
      entitiesAdded: input.entitiesAdded,
      entitiesRemoved: input.entitiesRemoved,
      entitiesModified: input.entitiesModified,
      decision: input.decision,
      applied: input.applied,
      denialReason: input.denialReason,
    };
    return this.proposals.append(append);
  }

  async onSessionEnd(input: OnSessionEndInput): Promise<ArchitectSessionRecord | null> {
    if (this.sessionId === null) return null;
    return this.sessions.endSession({
      id: this.sessionId,
      turnCount: input.turnCount,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens,
      costUsd: input.costUsd,
    });
  }

  private requireSession(method: string): void {
    if (this.sessionId === null || this.tenantId === null) {
      throw new Error(`PostgresTranscript.${method}: onSessionStart must be called first`);
    }
  }
}
