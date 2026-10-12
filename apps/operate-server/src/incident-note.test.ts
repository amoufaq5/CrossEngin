import type { IncidentRecord } from "@crossengin/incident-response";
import {
  IncidentRevisionConflictError,
  PAGED_NOTE_MAX_ATTEMPTS,
  PAGED_NOTE_NOT_FOUND,
  PAGED_NOTE_REVISION_CONFLICT,
  type StoredIncident,
} from "@crossengin/incident-response-runtime-pg";
import { describe, expect, it } from "vitest";

import { appendIncidentNote, type IncidentNoteStore } from "./incident-note.js";

const INC = "INC-2026-0007";
const AT = "2026-10-05T09:00:00.000Z";
const ACTOR = "system:deletion-evidence";

/** A valid stored incident, parsed by nothing — the executor re-parses the candidate it builds. */
function storedIncident(revision = 3): StoredIncident {
  const record: IncidentRecord = {
    id: INC,
    title: "Deletion proof sweep is not verifying stored tombstones (tombstone-sweep)",
    severity: "sev2",
    category: "compliance",
    status: "declared",
    affectedTenantIds: [],
    affectedRegions: [],
    publiclyVisible: false,
    securityIncident: false,
    breachDataClasses: [],
    autoDeclaredFor: "deletion_evidence:sweep:tombstone-sweep",
    declaredAt: "2026-10-05T08:00:00.000Z",
    declaredBy: ACTOR,
    roleAssignments: [],
    timeline: [
      {
        occurredAt: "2026-10-05T08:00:00.000Z",
        actorUserId: ACTOR,
        kind: "declared",
        message: "no_pages: every page threw",
        metadata: { stallKind: "no_pages" },
      },
    ],
    postmortemId: null,
    detectedAt: null,
    acknowledgedAt: null,
    mitigatedAt: null,
    resolvedAt: null,
    closedAt: null,
  } as unknown as IncidentRecord;
  return { record, revision, updatedAt: "2026-10-05T08:00:00.000Z" };
}

interface Fake {
  readonly store: IncidentNoteStore;
  readonly updates: Array<{ record: IncidentRecord; expectedRevision: number; at: string }>;
  readonly loads: number;
}

function fakeStore(
  behaviour: {
    readonly missing?: boolean;
    readonly loadThrows?: boolean;
    /** How many `update` calls lose the revision race before one lands. */
    readonly conflicts?: number;
    readonly updateThrows?: boolean;
  } = {},
): Fake {
  const updates: Array<{ record: IncidentRecord; expectedRevision: number; at: string }> = [];
  let loads = 0;
  let conflicts = behaviour.conflicts ?? 0;
  const fake: Fake = {
    updates,
    get loads(): number {
      return loads;
    },
    store: {
      load: async (): Promise<StoredIncident | null> => {
        loads += 1;
        if (behaviour.loadThrows === true) throw new Error("connection reset");
        return behaviour.missing === true ? null : storedIncident();
      },
      update: async (record, expectedRevision, at): Promise<StoredIncident> => {
        updates.push({ record, expectedRevision, at });
        if (behaviour.updateThrows === true) throw new Error("disk full");
        if (conflicts > 0) {
          conflicts -= 1;
          throw new IncidentRevisionConflictError(record.id, expectedRevision);
        }
        return { record, revision: expectedRevision + 1, updatedAt: at };
      },
    },
  };
  return fake;
}

const NOTE = {
  kind: "observation",
  message: "stall kind no_pages -> pinned_cursor: 4 pages came back without moving",
  metadata: { stallKind: "pinned_cursor", previousStallKind: "no_pages" },
  actorUserId: ACTOR,
} as const;

describe("appendIncidentNote", () => {
  it("appends the entry and changes nothing else", async () => {
    const fake = fakeStore();
    const outcome = await appendIncidentNote(fake.store, INC, NOTE, () => new Date(AT));
    expect(outcome).toEqual({ recorded: true, reason: null });
    const written = fake.updates[0]?.record;
    expect(written?.timeline).toHaveLength(2);
    const entry = written?.timeline[1];
    expect(entry?.kind).toBe("observation");
    expect(entry?.message).toContain("no_pages -> pinned_cursor");
    expect(entry?.metadata["stallKind"]).toBe("pinned_cursor");
    // A note is a fact about the incident, not a step in its lifecycle (`notePage`'s rule).
    expect(written?.status).toBe("declared");
    expect(written?.severity).toBe("sev2");
    expect(written?.resolvedAt).toBeNull();
  });

  it("guards on the revision it read", async () => {
    const fake = fakeStore();
    await appendIncidentNote(fake.store, INC, NOTE, () => new Date(AT));
    expect(fake.updates[0]?.expectedRevision).toBe(3);
  });

  it("stamps the entry once, however many attempts the write takes", async () => {
    let ticks = 0;
    const fake = fakeStore({ conflicts: 2 });
    const outcome = await appendIncidentNote(fake.store, INC, NOTE, () => {
      ticks += 1;
      return new Date(Date.parse(AT) + ticks * 1000);
    });
    expect(outcome.recorded).toBe(true);
    const occurred = fake.updates.map((u) => u.record.timeline[1]?.occurredAt);
    expect(new Set(occurred).size).toBe(1);
    // The row's `updated_at` is when it was written, which is this attempt and not the first.
    expect(new Set(fake.updates.map((u) => u.at)).size).toBe(3);
  });

  it("reports a revision conflict rather than looping", async () => {
    const fake = fakeStore({ conflicts: 99 });
    const outcome = await appendIncidentNote(fake.store, INC, NOTE, () => new Date(AT));
    expect(outcome).toEqual({ recorded: false, reason: PAGED_NOTE_REVISION_CONFLICT });
    expect(fake.updates).toHaveLength(PAGED_NOTE_MAX_ATTEMPTS);
  });

  it("reports an incident that does not exist", async () => {
    const fake = fakeStore({ missing: true });
    expect(await appendIncidentNote(fake.store, INC, NOTE, () => new Date(AT))).toEqual({
      recorded: false,
      reason: PAGED_NOTE_NOT_FOUND,
    });
    expect(fake.updates).toHaveLength(0);
  });

  it("reports rather than throws when the read or the write fails", async () => {
    // By the time a note is owed the incident is durable and the page has gone out, so raising would
    // turn a successful escalation into a failed one.
    const read = await appendIncidentNote(
      fakeStore({ loadThrows: true }).store,
      INC,
      NOTE,
      () => new Date(AT),
    );
    expect(read.recorded).toBe(false);
    expect(read.reason).toContain("read_failed");
    const write = await appendIncidentNote(
      fakeStore({ updateThrows: true }).store,
      INC,
      NOTE,
      () => new Date(AT),
    );
    expect(write.recorded).toBe(false);
    expect(write.reason).toContain("write_failed");
  });

  it("reports a refused entry without retrying it", async () => {
    const fake = fakeStore();
    const outcome = await appendIncidentNote(
      fake.store,
      INC,
      { ...NOTE, message: "" },
      () => new Date(AT),
    );
    // A caller bug, which retrying cannot fix.
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toContain("note_refused");
    expect(fake.updates).toHaveLength(0);
    expect(fake.loads).toBe(1);
  });

  it("defaults its clock, and takes an explicit instant when given one", async () => {
    const fake = fakeStore();
    await appendIncidentNote(fake.store, INC, { ...NOTE, at: AT });
    expect(fake.updates[0]?.record.timeline[1]?.occurredAt).toBe(AT);
  });
});
