import { describe, expect, it } from "vitest";
import { FILE_OPERATIONS, FileAuditRecordSchema } from "./audit.js";

const baseRec = {
  id: "a_1",
  tenantId: "t_1",
  fileId: "f_1",
  occurredAt: "2026-05-13T10:00:00.000Z",
  dataClass: "phi" as const,
  ok: true,
};

describe("FileAuditRecordSchema", () => {
  it("parses an upload_complete by user", () => {
    const r = FileAuditRecordSchema.parse({
      ...baseRec,
      operation: "upload_complete",
      actor: { kind: "user", userId: "u_1" },
      bytesTransferred: 12345,
    });
    expect(r.operation).toBe("upload_complete");
  });

  it("parses a system-issued lifecycle event", () => {
    const r = FileAuditRecordSchema.parse({
      ...baseRec,
      operation: "lifecycle_archive",
      actor: { kind: "system", systemComponent: "lifecycle-manager" },
    });
    expect(r.actor.kind).toBe("system");
  });

  it("parses an ai_architect-triggered regenerate", () => {
    const r = FileAuditRecordSchema.parse({
      ...baseRec,
      operation: "regenerate",
      actor: { kind: "ai_architect", sessionId: "s_1" },
    });
    expect(r.actor.kind).toBe("ai_architect");
  });

  it("rejects unknown operations", () => {
    expect(() =>
      FileAuditRecordSchema.parse({
        ...baseRec,
        operation: "preview",
        actor: { kind: "user", userId: "u_1" },
      }),
    ).toThrow();
  });

  it("records a virus-scan event with ok=false", () => {
    const r = FileAuditRecordSchema.parse({
      ...baseRec,
      operation: "scan_virus",
      actor: { kind: "system", systemComponent: "virus-scanner" },
      ok: false,
      errorMessage: "Detected: Eicar-Test-Signature",
    });
    expect(r.ok).toBe(false);
  });

  it("FILE_OPERATIONS includes the 11 documented operations", () => {
    expect(FILE_OPERATIONS).toHaveLength(11);
    expect(FILE_OPERATIONS).toContain("upload_init");
    expect(FILE_OPERATIONS).toContain("delete_hard");
    expect(FILE_OPERATIONS).toContain("quarantine_purge");
  });
});
