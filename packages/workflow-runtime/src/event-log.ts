import type { WorkflowEvent } from "@crossengin/workflow-engine";

export interface EventLog {
  append(event: WorkflowEvent): Promise<void>;
  appendBatch(events: readonly WorkflowEvent[]): Promise<void>;
  listByInstance(instanceId: string): Promise<readonly WorkflowEvent[]>;
  latestSequence(instanceId: string): Promise<number | null>;
  count(): Promise<number>;
}

export class InMemoryEventLog implements EventLog {
  private readonly events: WorkflowEvent[] = [];
  private readonly byInstance: Map<string, WorkflowEvent[]> = new Map();
  private readonly latest: Map<string, number> = new Map();

  async append(event: WorkflowEvent): Promise<void> {
    const latest = this.latest.get(event.instanceId);
    const expected = latest === undefined ? 0 : latest + 1;
    if (event.sequenceNumber !== expected) {
      throw new Error(
        `non-monotonic sequence for instance ${event.instanceId}: expected ${expected}, got ${event.sequenceNumber}`,
      );
    }
    this.events.push(event);
    const list = this.byInstance.get(event.instanceId);
    if (list === undefined) {
      this.byInstance.set(event.instanceId, [event]);
    } else {
      list.push(event);
    }
    this.latest.set(event.instanceId, event.sequenceNumber);
  }

  async appendBatch(events: readonly WorkflowEvent[]): Promise<void> {
    for (const e of events) {
      await this.append(e);
    }
  }

  async listByInstance(instanceId: string): Promise<readonly WorkflowEvent[]> {
    return this.byInstance.get(instanceId) ?? [];
  }

  async latestSequence(instanceId: string): Promise<number | null> {
    const v = this.latest.get(instanceId);
    return v === undefined ? null : v;
  }

  async count(): Promise<number> {
    return this.events.length;
  }
}
