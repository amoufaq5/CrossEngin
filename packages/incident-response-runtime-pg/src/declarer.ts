import type { PgConnection } from "@crossengin/kernel-pg";
import type { IncidentRecord } from "@crossengin/incident-response";
import type {
  IncidentCloseOut,
  IncidentCloseOutInput,
  IncidentDeclarationRequest,
  IncidentDeclarer,
} from "@crossengin/incident-response-runtime";

import { PersistentIncidentEngine } from "./persisting-engine.js";

export interface PostgresIncidentDeclarerOptions {
  readonly conn?: PgConnection;
  readonly engine?: PersistentIncidentEngine;
}

/**
 * The declarer an automated loop uses once its incidents are stored: the id comes from the rows
 * that exist, and the record it names is written before the id is handed back.
 *
 * This is what makes the id in a log line and the id on a row the same incident. A counter in the
 * process restarts at `INC-YYYY-0001` while the rows do not, so a restart would either collide with
 * a stored row or force the caller to report one id and store another — ADR-0289's reason for
 * leaving the SLO loop unpersisted until this seam existed.
 */
export class PostgresIncidentDeclarer implements IncidentDeclarer {
  private readonly engine: PersistentIncidentEngine;

  constructor(opts: PostgresIncidentDeclarerOptions) {
    const engine =
      opts.engine ?? (opts.conn !== undefined ? new PersistentIncidentEngine({ conn: opts.conn }) : null);
    if (engine === null) {
      throw new Error("PostgresIncidentDeclarer needs either a connection or an engine");
    }
    this.engine = engine;
  }

  async declare(request: IncidentDeclarationRequest): Promise<IncidentRecord> {
    const stored = await this.engine.declare(request);
    return stored.record;
  }

  async findOpen(autoDeclaredFor: string): Promise<IncidentRecord | null> {
    const stored = await this.engine.findOpenFor(autoDeclaredFor);
    return stored === null ? null : stored.record;
  }

  /**
   * The stored incident with this id, so a recovery reads the grade its declaration paged at
   * instead of guessing one — which is what lets a restart between a breach and its recovery
   * resolve the alert on the route its trigger used (ADR-0326, ADR-0327).
   *
   * A row that does not parse **throws** rather than answering null, because the two are different
   * facts. Null means no incident was ever stored under that id; a parse failure means one was and
   * has since been edited into a state the contract forbids — the class of fault `rowToIncident`
   * exists to catch and a CHECK constraint cannot (ADR-0289). Collapsing it into null would make
   * the recovery path the one read in this package that absorbs a tampered row in silence. A caller
   * treats the throw the way it treats null — leave the alert for a human — with the difference
   * that a throw also says why.
   */
  async findById(incidentId: string): Promise<IncidentRecord | null> {
    const stored = await this.engine.load(incidentId);
    return stored === null ? null : stored.record;
  }

  /**
   * Cancels the stored incident when nobody has taken it, and reports `human_owned` when somebody
   * has. Cancelling rather than resolving is not a shortcut: `triaged` requires the on-call roles to
   * be assigned, so an automated recovery that resolved the record would claim a response that
   * never happened.
   */
  async closeOut(incidentId: string, input: IncidentCloseOutInput): Promise<IncidentCloseOut> {
    const cancelled = await this.engine.cancelIfUntriaged(incidentId, {
      reason: input.reason,
      actorUserId: input.actorUserId,
      ...(input.at !== undefined ? { at: input.at } : {}),
    });
    return cancelled === null ? "human_owned" : "cancelled";
  }
}
