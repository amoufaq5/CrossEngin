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
