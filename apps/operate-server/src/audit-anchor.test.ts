import type { UserId } from "@crossengin/types";
import { canonicalAuditEntryPayload, type AuditLogEntry } from "@crossengin/auth";
import { sha256 } from "@crossengin/crypto";
import type { ChainedLogEntry } from "@crossengin/forensics";
import type { UnreadableRow } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  AUDIT_ANCHOR_VERDICTS,
  formatAuditAnchorReport,
  verifyAuditAnchors,
} from "./audit-anchor.js";
import type { AnchoredAuditEntry } from "./audit-log-store.js";

const TENANT = "22222222-2222-4222-8222-222222222222";

/**
 * Named rather than twenty bare `[]`s: in a test about something else, the claim being made is
 * "the reader refused nothing", and a reader of the call site should not have to infer that from
 * an empty literal in the fourth position.
 */
const NO_UNREADABLE_ROWS: readonly UnreadableRow[] = [];

const entryOf = (id: string, over: Partial<AuditLogEntry> = {}): AuditLogEntry =>
  ({
    id,
    tenantId: TENANT,
    occurredAt: "2026-09-28T08:00:00.000Z",
    actor: { kind: "user", userId: "u1", sessionId: null, ip: null, userAgent: null },
    operation: "notifications.read_tenant_scope",
    entity: "notification_dispatches",
    entityId: null,
    before: null,
    after: { limit: 5 },
    diff: null,
    ...over,
  }) as AuditLogEntry;

/** A chain entry that genuinely commits to `entry` at `sequenceNumber`. */
function anchorFor(entry: AuditLogEntry, sequenceNumber: number): ChainedLogEntry {
  const payload = canonicalAuditEntryPayload(entry);
  return {
    sequenceNumber,
    kind: "audit_event",
    recordedAt: entry.occurredAt,
    actorReference: entry.actor.userId ?? "system",
    payloadSha256: sha256(payload),
    payloadSizeBytes: Buffer.byteLength(payload, "utf8"),
    priorEntryHash: "0".repeat(64),
    // Derived from the payload, as a real chain entry hash is, so two different
    // entries at the same sequence do not accidentally share an entryHash.
    entryHash: sha256(`${sequenceNumber.toString()}:${payload}`),
    signingKeyFingerprint: "fp",
    signature: "sig",
  } as ChainedLogEntry;
}

const rowOf = (entry: AuditLogEntry, chainEntry: ChainedLogEntry | null): AnchoredAuditEntry => ({
  entry,
  anchor:
    chainEntry === null
      ? null
      : { sequenceNumber: chainEntry.sequenceNumber, entryHash: chainEntry.entryHash },
});

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "33333333-3333-4333-8333-333333333333";

describe("verifyAuditAnchors", () => {
  it("verifies a row whose anchor commits to exactly its content", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const report = verifyAuditAnchors(TENANT, [rowOf(e, a)], [a], NO_UNREADABLE_ROWS);
    expect(report.ok).toBe(true);
    expect(report.verified).toBe(1);
    expect(report.tampered).toEqual([]);
    expect(report.results[0]).toMatchObject({ auditId: ID_A, verdict: "verified" });
  });

  it("detects a row edited after it was anchored", () => {
    const original = entryOf(ID_A);
    const a = anchorFor(original, 0);
    const edited = entryOf(ID_A, { operation: "something.benign" });
    const report = verifyAuditAnchors(TENANT, [rowOf(edited, a)], [a], NO_UNREADABLE_ROWS);
    expect(report.ok).toBe(false);
    expect(report.tampered).toHaveLength(1);
    expect(report.tampered[0]?.verdict).toBe("hash_mismatch");
  });

  it("detects an edit buried in the after payload", () => {
    const original = entryOf(ID_A, { after: { limit: 5 } });
    const a = anchorFor(original, 0);
    const edited = entryOf(ID_A, { after: { limit: 500 } });
    expect(verifyAuditAnchors(TENANT, [rowOf(edited, a)], [a], NO_UNREADABLE_ROWS).tampered[0]?.verdict).toBe(
      "hash_mismatch",
    );
  });

  it("detects an actor swapped to hide who did it", () => {
    const original = entryOf(ID_A);
    const a = anchorFor(original, 0);
    const edited = entryOf(ID_A, {
      actor: { kind: "user", userId: "someone-else" as UserId, sessionId: null, ip: null, userAgent: null },
    });
    expect(verifyAuditAnchors(TENANT, [rowOf(edited, a)], [a], NO_UNREADABLE_ROWS).tampered[0]?.verdict).toBe(
      "hash_mismatch",
    );
  });

  it("detects a deleted anchor, the obvious way to hide an edit", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const report = verifyAuditAnchors(TENANT, [rowOf(e, a)], [], NO_UNREADABLE_ROWS);
    expect(report.ok).toBe(false);
    expect(report.tampered[0]?.verdict).toBe("anchor_missing");
    expect(report.tampered[0]?.sequenceNumber).toBe(0);
  });

  it("detects a row repointed at a different entry at the same sequence", () => {
    const e = entryOf(ID_A);
    const written = anchorFor(e, 0);
    const substituted: ChainedLogEntry = { ...written, entryHash: "hash-substituted" };
    const report = verifyAuditAnchors(TENANT, [rowOf(e, written)], [substituted], NO_UNREADABLE_ROWS);
    expect(report.tampered[0]?.verdict).toBe("anchor_repointed");
  });

  it("prefers repointed over hash_mismatch when both would apply", () => {
    // The row points at sequence 0 but the entry there is a different one entirely; calling
    // that a hash mismatch would describe the wrong problem.
    const e = entryOf(ID_A);
    const written = anchorFor(e, 0);
    const other = anchorFor(entryOf(ID_B), 0);
    expect(verifyAuditAnchors(TENANT, [rowOf(e, written)], [other], NO_UNREADABLE_ROWS).tampered[0]?.verdict).toBe(
      "anchor_repointed",
    );
  });

  it("reports an unanchored row as unproven, not as tampered", () => {
    const report = verifyAuditAnchors(TENANT, [rowOf(entryOf(ID_A), null)], [], NO_UNREADABLE_ROWS);
    expect(report.tampered).toEqual([]);
    expect(report.unanchored).toBe(1);
    expect(report.results[0]?.verdict).toBe("unanchored");
    // Absence of evidence is not integrity, so the report still does not claim OK.
    expect(report.ok).toBe(false);
  });

  it("is ok on an empty tenant", () => {
    const report = verifyAuditAnchors(TENANT, [], [], NO_UNREADABLE_ROWS);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(0);
  });

  it("checks every row, reporting a mix", () => {
    const good = entryOf(ID_A);
    const goodAnchor = anchorFor(good, 0);
    const badOriginal = entryOf(ID_B);
    const badAnchor = anchorFor(badOriginal, 1);
    const bad = entryOf(ID_B, { reason: "rewritten" });
    const orphan = entryOf("44444444-4444-4444-8444-444444444444");
    const report = verifyAuditAnchors(
      TENANT,
      [rowOf(good, goodAnchor), rowOf(bad, badAnchor), rowOf(orphan, null)],
      [goodAnchor, badAnchor],
      NO_UNREADABLE_ROWS,
    );
    expect(report.checked).toBe(3);
    expect(report.verified).toBe(1);
    expect(report.unanchored).toBe(1);
    expect(report.tampered).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it("ignores chain entries that no audit row claims", () => {
    // The chain also carries one audit_event per request; those are not audit_log rows and
    // must not be mistaken for missing anchors.
    const e = entryOf(ID_A);
    const a = anchorFor(e, 3);
    const unrelated = anchorFor(entryOf(ID_B), 0);
    const report = verifyAuditAnchors(TENANT, [rowOf(e, a)], [unrelated, a], NO_UNREADABLE_ROWS);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
  });

  it("carries the tenant through", () => {
    expect(verifyAuditAnchors(TENANT, [], [], NO_UNREADABLE_ROWS).tenantId).toBe(TENANT);
  });

  it("enumerates exactly the documented verdicts", () => {
    expect([...AUDIT_ANCHOR_VERDICTS]).toEqual([
      "verified",
      "unanchored",
      "anchor_missing",
      "hash_mismatch",
      "anchor_repointed",
    ]);
  });
});

describe("verifyAuditAnchors — a row the reader refused", () => {
  const refused: UnreadableRow = { identity: ID_B, detail: "operation: too_small" };

  it("makes the report not ok with nothing tampered and nothing unanchored", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const report = verifyAuditAnchors(TENANT, [rowOf(e, a)], [a], [refused]);
    expect(report.tampered).toEqual([]);
    expect(report.unanchored).toBe(0);
    expect(report.verified).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.unreadable).toEqual([refused]);
  });

  it("counts only the rows it examined, so checked excludes the refusal", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const report = verifyAuditAnchors(TENANT, [rowOf(e, a)], [a], [refused]);
    expect(report.checked).toBe(1);
    expect(report.checked).toBe(report.results.length);
  });

  it("is ok on an empty scope only when nothing was refused either", () => {
    expect(verifyAuditAnchors(TENANT, [], [], NO_UNREADABLE_ROWS).ok).toBe(true);
    expect(verifyAuditAnchors(TENANT, [], [], [refused]).ok).toBe(false);
  });

  it("is its own axis: the refused row appears in neither results nor tampered", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const report = verifyAuditAnchors(TENANT, [rowOf(e, a)], [a], [refused]);
    expect(report.results.map((r) => r.auditId)).toEqual([ID_A]);
    expect(report.results.map((r) => r.auditId)).not.toContain(ID_B);
    expect(report.tampered.map((r) => r.auditId)).not.toContain(ID_B);
  });

  it("is not a verdict: no AUDIT_ANCHOR_VERDICTS member names an unreadable row", () => {
    // The fence against the ADR-0351 shape: a sixth enum member added here and to neither
    // `TAMPERED` nor anything else would compile and read as neither disproven nor unproven.
    expect(AUDIT_ANCHOR_VERDICTS).toHaveLength(5);
    expect(AUDIT_ANCHOR_VERDICTS.filter((v) => /unreadable|unparse|refus/.test(v))).toEqual([]);
  });

  it("carries a refusal that names no column handle as an identity of null", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const report = verifyAuditAnchors(
      TENANT,
      [rowOf(e, a)],
      [a],
      [{ identity: null, detail: "id: invalid_string" }],
    );
    expect(report.ok).toBe(false);
    expect(report.unreadable[0]?.identity).toBeNull();
    expect(report.verified).toBe(1);
  });

  it("still reports a tampered row beside the refusal rather than either hiding the other", () => {
    const original = entryOf(ID_A);
    const a = anchorFor(original, 0);
    const edited = entryOf(ID_A, { operation: "something.benign" });
    const report = verifyAuditAnchors(TENANT, [rowOf(edited, a)], [a], [refused]);
    expect(report.tampered.map((t) => t.verdict)).toEqual(["hash_mismatch"]);
    expect(report.unreadable).toHaveLength(1);
  });

  it("reads FAILED when the refusal is the only thing wrong", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const text = formatAuditAnchorReport(verifyAuditAnchors(TENANT, [rowOf(e, a)], [a], [refused]));
    expect(text).toContain("FAILED");
  });
});

describe("formatAuditAnchorReport", () => {
  it("reports OK with the counts", () => {
    const e = entryOf(ID_A);
    const a = anchorFor(e, 0);
    const text = formatAuditAnchorReport(verifyAuditAnchors(TENANT, [rowOf(e, a)], [a], NO_UNREADABLE_ROWS));
    expect(text).toContain("OK");
    expect(text).toContain("verified: 1");
  });

  it("names each tampered row and its verdict", () => {
    const original = entryOf(ID_A);
    const a = anchorFor(original, 7);
    const edited = entryOf(ID_A, { operation: "x" });
    const text = formatAuditAnchorReport(verifyAuditAnchors(TENANT, [rowOf(edited, a)], [a], NO_UNREADABLE_ROWS));
    expect(text).toContain("FAILED");
    expect(text).toContain("hash_mismatch");
    expect(text).toContain(ID_A);
    expect(text).toContain("chain sequence 7");
  });

  it("renders an unanchored row's missing sequence as a dash", () => {
    const report = verifyAuditAnchors(TENANT, [rowOf(entryOf(ID_A), null)], [], NO_UNREADABLE_ROWS);
    expect(formatAuditAnchorReport(report)).toContain("unanchored: 1");
  });
});

/**
 * The platform scope (ADR-0331). `meta.audit_log.tenant_id` is nullable, so there are platform
 * rows to anchor — and the anchor check is the only detector there is for an edited audit row, so
 * reading them is what keeps the new rows from being a proof nobody checks.
 */
describe("verifyAuditAnchors — platform scope", () => {
  const platformEntry = (id: string, over: Partial<AuditLogEntry> = {}): AuditLogEntry =>
    entryOf(id, { tenantId: null, operation: "platform.page_undelivered", ...over });

  it("verifies a platform row against the platform chain", () => {
    const entry = platformEntry(ID_A);
    const anchor = anchorFor(entry, 0);
    const report = verifyAuditAnchors(null, [rowOf(entry, anchor)], [anchor], NO_UNREADABLE_ROWS);
    expect(report.tenantId).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.verified).toBe(1);
  });

  it("catches a tampered platform row", () => {
    const entry = platformEntry(ID_A);
    const anchor = anchorFor(entry, 0);
    const edited = platformEntry(ID_A, { after: { incidentId: "INC-2026-9999" } });
    const report = verifyAuditAnchors(null, [rowOf(edited, anchor)], [anchor], NO_UNREADABLE_ROWS);
    expect(report.tampered.map((t) => t.verdict)).toEqual(["hash_mismatch"]);
  });

  it("does not verify a platform row against a tenant-scoped anchor of the same content", () => {
    // The scope is inside the committed bytes, so a tenant row's anchor cannot be reused to make a
    // platform row look witnessed — which is what would let a borrowed scope be laundered.
    const tenantScoped = entryOf(ID_A);
    const anchor = anchorFor(tenantScoped, 0);
    const report = verifyAuditAnchors(null, [rowOf(platformEntry(ID_A), anchor)], [anchor], NO_UNREADABLE_ROWS);
    expect(report.tampered.map((t) => t.verdict)).toEqual(["hash_mismatch"]);
  });

  it("reports an unanchored platform row as unproven, not intact", () => {
    const report = verifyAuditAnchors(null, [rowOf(platformEntry(ID_B), null)], [], NO_UNREADABLE_ROWS);
    expect(report.ok).toBe(false);
    expect(report.unanchored).toBe(1);
    expect(report.tampered).toEqual([]);
  });

  it("names the platform rather than printing a null tenant id", () => {
    const entry = platformEntry(ID_A);
    const anchor = anchorFor(entry, 0);
    const text = formatAuditAnchorReport(verifyAuditAnchors(null, [rowOf(entry, anchor)], [anchor], NO_UNREADABLE_ROWS));
    expect(text).toContain("audit anchors for the platform: OK");
    expect(text).not.toContain("null");
  });
});
