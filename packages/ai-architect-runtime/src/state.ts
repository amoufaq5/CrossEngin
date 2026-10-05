import type { SessionCostState, TenantCostState } from "@crossengin/ai-architect";

interface MutableSessionState {
  tokensUsed: number;
  toolCallsThisTurn: number;
  toolCallsBySession: Record<string, number>;
  /** Worst observed actual/estimate cost ratio; inflates this session's next estimate. */
  estimateInflation: number;
  sealedReason: string | null;
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
      s = {
        tokensUsed: 0,
        toolCallsThisTurn: 0,
        toolCallsBySession: {},
        estimateInflation: 1,
        sealedReason: null,
      };
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

  /**
   * The factor this session's next cost estimate should be multiplied by. Starts at 1
   * and only ever rises, because an estimator caught being optimistic once on a given
   * prompt shape will be optimistic again on the next turn of the same session.
   */
  estimateInflation(sessionId: string): number {
    return this.sessions.get(sessionId)?.estimateInflation ?? 1;
  }

  /** Raises the session's inflation factor if `ratio` is worse than what is recorded. */
  observeEstimateRatio(sessionId: string, ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 1) return;
    const s = this.sessionState(sessionId);
    if (ratio > s.estimateInflation) s.estimateInflation = ratio;
  }

  /**
   * Installs a tenant's durably learned correction as this session's starting factor, so a
   * restart does not begin by admitting the requests the estimator had learned to delay.
   *
   * It raises and never lowers, for the same reason `observeEstimateRatio` does: the session
   * may already have observed something worse than the tenant's stored figure, and a seed
   * arriving late must not undo that.
   */
  seedEstimateInflation(sessionId: string, inflation: number): void {
    if (!Number.isFinite(inflation) || inflation <= 1) return;
    const s = this.sessionState(sessionId);
    if (inflation > s.estimateInflation) s.estimateInflation = inflation;
  }

  /** Seals a session: every later guard evaluation blocks. Fail closed, never reversed. */
  seal(sessionId: string, reason: string): void {
    const s = this.sessionState(sessionId);
    if (s.sealedReason === null) s.sealedReason = reason;
  }

  /** Why this session is sealed, or `null` if it is not. */
  sealedReason(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.sealedReason ?? null;
  }

  /** Drops a session's accumulated state (e.g. when the session ends). */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
