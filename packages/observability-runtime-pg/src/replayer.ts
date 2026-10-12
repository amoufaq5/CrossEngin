import type { SloEnforcementActionRecord } from "./records.js";
import { PostgresSloEnforcementActionStore } from "./enforcement-action-store.js";

export const SLO_DRIFT_ISSUE_KINDS = [
  "breach_opened_missing_severity",
  "paged_without_channels",
  "channels_without_paged",
  "kill_switch_without_flag",
  "recovered_close_out_failed",
  "ongoing_without_open",
  "recovered_without_open",
  "duplicate_open",
] as const;
export type SloDriftIssueKind = (typeof SLO_DRIFT_ISSUE_KINDS)[number];

export interface SloDriftIssue {
  readonly kind: SloDriftIssueKind;
  readonly actionId: string;
  readonly incidentId: string;
  readonly detail: string;
}

export function verifyEnforcementActionShape(
  action: SloEnforcementActionRecord,
): readonly SloDriftIssue[] {
  const issues: SloDriftIssue[] = [];
  const at = (kind: SloDriftIssueKind, detail: string): void => {
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
  // The signal cleared but the store refused the close-out, so the incident row is still open and
  // nothing paged again to say so. Only the stored close-out can tell this apart from a clean
  // recovery; before the column the two rows were identical.
  if (action.closeOut === "failed") {
    at(
      "recovered_close_out_failed",
      "recovery could not close the incident out; the row is still open",
    );
  }
  return issues;
}

export interface EnforcementHistoryOptions {
  /**
   * Whether `actions` is the **whole** history of every incident it mentions, or a window over it.
   *
   * This is the difference between a finding and an artefact of a `LIMIT`, and the two
   * `*_without_open` kinds are the only ones that turn on it. `listRecent(limit)` returns the newest
   * N actions, so any episode that began before the page starts mid-flight: its `breach_opened` is
   * older than the window, and every `breach_ongoing` and `recovered` inside the window then has
   * "no prior open". That is *true of the page* and says nothing about the table — and it fires on
   * precisely the healthiest thing a deployment can have, a long-running incident the loop is
   * re-asserting every tick. Unqualified, `verifyRecent` on a deployment with one open breach
   * reports a finding per tick, for ever.
   *
   * `duplicate_open` is deliberately **not** gated: two `breach_opened` rows for one incident id are
   * conclusive in any subset of the table, because seeing both is the whole evidence. An absence is
   * only an inference — ADR-0322's rule, that presence is conclusive at any age while "not there"
   * and "not there yet" look identical — so one half of this check survives a window and the other
   * does not.
   *
   * Defaults to `true`, the meaning this function has always had for a caller handing it a complete
   * set; `verifyRecent` is the one path that must say otherwise and does.
   */
  readonly historyIsComplete?: boolean;
}

export function verifyEnforcementHistory(
  actions: readonly SloEnforcementActionRecord[],
  opts: EnforcementHistoryOptions = {},
): readonly SloDriftIssue[] {
  const historyIsComplete = opts.historyIsComplete ?? true;
  const ordered = [...actions].sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
  );
  const issues: SloDriftIssue[] = [];
  const openedIncidents = new Set<string>();

  for (const action of ordered) {
    issues.push(...verifyEnforcementActionShape(action));
    const issue = (kind: SloDriftIssueKind, detail: string): void => {
      issues.push({ kind, actionId: action.actionId, incidentId: action.incidentId, detail });
    };

    if (action.decision === "breach_opened") {
      if (openedIncidents.has(action.incidentId)) {
        issue("duplicate_open", `incident ${action.incidentId} opened more than once`);
      }
      openedIncidents.add(action.incidentId);
    } else if (action.decision === "breach_ongoing") {
      if (historyIsComplete && !openedIncidents.has(action.incidentId)) {
        issue("ongoing_without_open", `ongoing for ${action.incidentId} with no prior open`);
      }
    } else {
      if (historyIsComplete && !openedIncidents.has(action.incidentId)) {
        issue("recovered_without_open", `recovered for ${action.incidentId} with no prior open`);
      }
      openedIncidents.delete(action.incidentId);
    }
  }
  return issues;
}

export interface SloEnforcementSummary {
  readonly total: number;
  readonly opened: number;
  readonly ongoing: number;
  readonly recovered: number;
  readonly paged: number;
  readonly pagedRatio: number;
}

export function summarizeEnforcement(
  actions: readonly SloEnforcementActionRecord[],
): SloEnforcementSummary {
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

  /**
   * Every method here takes the scope it verifies, defaulting to the platform's.
   *
   * A drift verdict is a judgement over a *set*, so a set drawn from two scopes is not merely
   * longer — it reports drift that is not there (two scopes' `breach_opened` on one incident id
   * read as a duplicate open) and hides drift that is (another scope's rows displacing this one's
   * under the `LIMIT`). The scope belongs on the question, not on how the connection happens to be
   * authenticated.
   */
  /**
   * `listForIncident` is unbounded within its scope, so this *is* the whole history of the one
   * incident asked about — the only read here that can honestly claim an absence means something.
   */
  async verifyIncident(
    incidentId: string,
    tenantId: string | null = null,
  ): Promise<readonly SloDriftIssue[]> {
    const actions = await this.store.listForIncident(incidentId, tenantId);
    return verifyEnforcementHistory(actions, { historyIsComplete: true });
  }

  /**
   * A window, and it says so — see `EnforcementHistoryOptions.historyIsComplete`. An episode whose
   * `breach_opened` is older than the page is not drift, and `verifyIncident` is the way to ask
   * conclusively about one of the incidents this reports.
   */
  async verifyRecent(
    limit = 100,
    tenantId: string | null = null,
  ): Promise<readonly SloDriftIssue[]> {
    const actions = await this.store.listRecent(limit, tenantId);
    return verifyEnforcementHistory(actions, { historyIsComplete: false });
  }

  async summarizeRecent(
    limit = 100,
    tenantId: string | null = null,
  ): Promise<SloEnforcementSummary> {
    const actions = await this.store.listRecent(limit, tenantId);
    return summarizeEnforcement(actions);
  }
}
