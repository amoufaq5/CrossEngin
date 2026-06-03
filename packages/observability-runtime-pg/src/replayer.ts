import type { SloEnforcementActionRecord } from "./records.js";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";

export const DRIFT_ISSUE_KINDS = [
  "breach_opened_missing_severity",
  "paged_without_channels",
  "channels_without_paged",
  "kill_switch_without_flag",
  "ongoing_without_open",
  "recovered_without_open",
  "duplicate_open",
] as const;
export type DriftIssueKind = (typeof DRIFT_ISSUE_KINDS)[number];

export interface DriftIssue {
  readonly kind: DriftIssueKind;
  readonly actionId: string;
  readonly incidentId: string;
  readonly detail: string;
}

export function verifyEnforcementActionShape(
  action: SloEnforcementActionRecord,
): readonly DriftIssue[] {
  const issues: DriftIssue[] = [];
  const at = (kind: DriftIssueKind, detail: string): void => {
    issues.push({ kind, actionId: action.actionId, incidentId: action.incidentId, detail });
  };

  if (action.decision === "breach_opened" && action.severity === null) {
    at("breach_opened_missing_severity", "breach_opened must carry a severity");
  }
  if (action.paged && action.pageChannelCount === 0) {
    at("paged_without_channels", "paged=true but pageChannelCount=0");
  }
  if (!action.paged && action.pageChannelCount > 0) {
    at("channels_without_paged", "pageChannelCount>0 but paged=false");
  }
  if (action.killSwitchId !== null && action.flagId === null) {
    at("kill_switch_without_flag", "kill switch recorded without the flag it overrides");
  }
  return issues;
}

export function verifyEnforcementHistory(
  actions: readonly SloEnforcementActionRecord[],
): readonly DriftIssue[] {
  const ordered = [...actions].sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
  );
  const issues: DriftIssue[] = [];
  const openedIncidents = new Set<string>();

  for (const action of ordered) {
    issues.push(...verifyEnforcementActionShape(action));
    const issue = (kind: DriftIssueKind, detail: string): void => {
      issues.push({ kind, actionId: action.actionId, incidentId: action.incidentId, detail });
    };

    if (action.decision === "breach_opened") {
      if (openedIncidents.has(action.incidentId)) {
        issue("duplicate_open", `incident ${action.incidentId} opened more than once`);
      }
      openedIncidents.add(action.incidentId);
    } else if (action.decision === "breach_ongoing") {
      if (!openedIncidents.has(action.incidentId)) {
        issue("ongoing_without_open", `ongoing for ${action.incidentId} with no prior open`);
      }
    } else {
      if (!openedIncidents.has(action.incidentId)) {
        issue("recovered_without_open", `recovered for ${action.incidentId} with no prior open`);
      }
      openedIncidents.delete(action.incidentId);
    }
  }
  return issues;
}

export interface EnforcementSummary {
  readonly total: number;
  readonly opened: number;
  readonly ongoing: number;
  readonly recovered: number;
  readonly paged: number;
  readonly pagedRatio: number;
}

export function summarizeEnforcement(
  actions: readonly SloEnforcementActionRecord[],
): EnforcementSummary {
  let opened = 0;
  let ongoing = 0;
  let recovered = 0;
  let paged = 0;
  for (const action of actions) {
    if (action.decision === "breach_opened") opened += 1;
    else if (action.decision === "breach_ongoing") ongoing += 1;
    else recovered += 1;
    if (action.paged) paged += 1;
  }
  const total = actions.length;
  return {
    total,
    opened,
    ongoing,
    recovered,
    paged,
    pagedRatio: total === 0 ? 0 : paged / total,
  };
}

export class SloEnforcementReplayer {
  private readonly store: PostgresSloEnforcementActionStore;

  constructor(store: PostgresSloEnforcementActionStore) {
    this.store = store;
  }

  async verifyIncident(incidentId: string): Promise<readonly DriftIssue[]> {
    const actions = await this.store.listForIncident(incidentId);
    return verifyEnforcementHistory(actions);
  }

  async verifyRecent(limit = 100): Promise<readonly DriftIssue[]> {
    const actions = await this.store.listRecent(limit);
    return verifyEnforcementHistory(actions);
  }

  async summarizeRecent(limit = 100): Promise<EnforcementSummary> {
    const actions = await this.store.listRecent(limit);
    return summarizeEnforcement(actions);
  }
}
