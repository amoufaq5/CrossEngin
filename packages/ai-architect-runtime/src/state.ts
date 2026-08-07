import type { SessionCostState, TenantCostState } from "@crossengin/ai-architect";

interface MutableSessionState {
  tokensUsed: number;
  toolCallsThisTurn: number;
  toolCallsBySession: Record<string, number>;
}

/**
 * In-memory per-session + per-tenant cost accounting for the Architect guard.
 * Sessions accumulate tokens + per-tool call counts (and a per-turn tool counter
 * reset each turn); tenants accumulate the monthly dollar spend. Reads project a
 * frozen `SessionCostState` / `TenantCostState` for `decideSessionAction`.
 */
export class SessionCostTracker {
  private readonly sessions = new Map<string, MutableSessionState>();
  private readonly tenants = new Map<string, number>();

  private sessionState(sessionId: string): MutableSessionState {
    let s = this.sessions.get(sessionId);
    if (s === undefined) {
      s = { tokensUsed: 0, toolCallsThisTurn: 0, toolCallsBySession: {} };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** The session's current cost state (zeroed if never seen). */
  session(sessionId: string): SessionCostState {
    const s = this.sessions.get(sessionId);
    if (s === undefined) return { tokensUsed: 0, toolCallsThisTurn: 0, toolCallsBySession: {} };
    return { tokensUsed: s.tokensUsed, toolCallsThisTurn: s.toolCallsThisTurn, toolCallsBySession: { ...s.toolCallsBySession } };
  }

  /** The tenant's current cost state (zeroed if never seen). */
  tenant(tenantId: string): TenantCostState {
    return { monthlyDollarsUsed: this.tenants.get(tenantId) ?? 0 };
  }

  /** Resets the per-turn tool-call counter at the start of a turn. */
  beginTurn(sessionId: string): void {
    this.sessionState(sessionId).toolCallsThisTurn = 0;
  }

  /** Records `tokens` consumed by a session. */
  recordTokens(sessionId: string, tokens: number): void {
    this.sessionState(sessionId).tokensUsed += tokens;
  }

  /** Records one tool call: bumps the per-turn counter and the per-tool session tally. */
  recordToolCall(sessionId: string, tool: string): void {
    const s = this.sessionState(sessionId);
    s.toolCallsThisTurn += 1;
    s.toolCallsBySession[tool] = (s.toolCallsBySession[tool] ?? 0) + 1;
  }

  /** Records `dollars` of spend against a tenant's monthly total. */
  recordDollars(tenantId: string, dollars: number): void {
    this.tenants.set(tenantId, (this.tenants.get(tenantId) ?? 0) + dollars);
  }

  /** Drops a session's accumulated state (e.g. when the session ends). */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
