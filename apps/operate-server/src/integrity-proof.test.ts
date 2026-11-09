import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalAuditEntryPayload, type AuditLogEntry } from "@crossengin/auth";
import {
  ed25519PublicKeyFingerprint,
  generateEd25519Keypair,
  sha256,
  signEd25519,
} from "@crossengin/crypto";
import {
  GENESIS_HASH,
  buildChainEntry,
  verifyChainIntegrity,
  type ChainCheckpoint,
  type ChainedLogEntry,
} from "@crossengin/forensics";
import {
  CheckpointRowUnreadable,
  unreadableEntryVerdict,
  verifyChainSuffix,
  type ChainRead,
  type CheckpointScanOutcome,
} from "@crossengin/forensics-pg";
import type { RowRead, UnreadableRow } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { anchorAuditDisproves, type AnchorAuditReport } from "./anchor-audit.js";
import type { AuditAnchorReport, AuditAnchorResult } from "./audit-anchor.js";
import {
  CHAIN_FULL_REASONS,
  verifyChainFromCheckpoint,
  verifyChainFull,
  type ChainVerificationReport,
} from "./chain-verify.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import {
  COMPROMISE_CAUSES,
  INTEGRITY_VERDICTS,
  INTEGRITY_PASS_SKIP_REASONS,
  IntegrityProofScheduler,
  IntegrityProofConfigSchema,
  DEFAULT_INTEGRITY_PROOF_CONFIG,
  compromiseCauses,
  formatIntegrityProof,
  integrityConfigScopes,
  integrityVerdictFor,
  integrityVerdictPayload,
  loadIntegrityProofConfig,
  noAnchorFindings,
  parseIntegrityProofConfig,
  proveScopeIntegrity,
  type ChainTruncationCheck,
  type CompromiseCause,
  type CompromiseEvidence,
  type IntegrityProofConfig,
  type IntegrityProofReport,
} from "./integrity-proof.js";
import {
  WITNESS_MEMORY_GRADE,
  WITNESS_MEMORY_OUTCOMES,
  noWitnessMemory,
  witnessMemoryUnproven,
  type WitnessMemoryCheck,
} from "./witness-memory.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const AT = "2026-09-29T00:00:00.000Z";

// No `as ChainVerificationReport`: the cast omitted `fullBecause` after it became required, so
// every `formatIntegrityProof` call in this file rendered `chain [from_checkpoint: undefined]` and
// not one of the formatter assertions read the chain segment, so the suite stayed green over wrong
// output (ADR-0371, ADR-0362's cast-standing-in-for-a-check).
function chainOk(over: Partial<ChainVerificationReport> = {}): ChainVerificationReport {
  return {
    tenantId: TENANT_A,
    ok: true,
    mode: "from_checkpoint",
    fullBecause: null,
    checkpointSequence: 3,
    integrity: { valid: true, brokenAt: null },
    signatures: { valid: true, checked: 4, results: [], unresolvedFingerprints: [], unreadable: [] },
    ...over,
  };
}

function anchors(over: Partial<AuditAnchorReport> = {}): AuditAnchorReport {
  return {
    tenantId: TENANT_A,
    ok: true,
    checked: 2,
    verified: 2,
    unanchored: 0,
    tampered: [],
    results: [],
    unreadable: [],
    ...over,
  };
}

const tamperedResult: AuditAnchorResult = {
  auditId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  verdict: "hash_mismatch",
  sequenceNumber: 2,
};

function noTruncation(over: Partial<ChainTruncationCheck> = {}): ChainTruncationCheck {
  return { checkpointSequence: 3, tailSequence: 9, truncated: false, ...over };
}

/**
 * An anchor audit over this scope, clean unless a field is overridden.
 *
 * Built on `noAnchorFindings` rather than spelled out, so a fixture here cannot drift from the
 * helper the production call sites use — and so a sixth field on `AnchorAuditReport` reaches both.
 */
function anchorAudit(over: Partial<AnchorAuditReport> = {}): AnchorAuditReport {
  // `disagreeingCount` derived after the spread, for `refusedAnchors`' reason one axis across: a
  // fixture overriding `disagreeing` and leaving the count at 0 would assert the opposite of the
  // shape it names, since `anchorAuditDisproves` reads the count. An explicit override wins.
  const base: AnchorAuditReport = { ...noAnchorFindings(TENANT_A), ...over };
  if (over.disagreeingCount !== undefined) return base;
  return { ...base, disagreeingCount: base.disagreeing === null ? null : base.disagreeing.length };
}

/** A refused anchor on the axis the verdict reads, with the count and the list in agreement. */
function refusedAnchors(...rows: readonly UnreadableRow[]): AnchorAuditReport {
  return anchorAudit({ scanned: rows.length, refused: rows, refusedCount: rows.length });
}

function report(over: Partial<IntegrityProofReport> = {}): IntegrityProofReport {
  return {
    scope: TENANT_A,
    verdict: "verified",
    verifiedAt: AT,
    chain: chainOk(),
    anchors: anchors(),
    chainRowsRefused: [],
    anchorAudit: anchorAudit(),
    truncation: noTruncation(),
    witnessMemory: noWitnessMemory(),
    ...over,
  };
}

/** The minimum of a stored checkpoint the audit reads: a sequence and the hash it claims is there. */
function checkpointAt(sequenceNumber: number, rootHash: string): ChainCheckpoint {
  return {
    sequenceNumber,
    rootHash,
    checkpointedAt: AT,
    checkpointedBy: "auditor",
    algorithm: "sha256",
    provenance: "verified_full",
  };
}

/**
 * A checkpoint store that answers the whole scope in one page, `records` in the ascending order the
 * real scan reads them in.
 *
 * `latest` is **derived from the same row set** rather than taken as its own option, so a fixture
 * cannot tell the chain half one thing and the anchor audit another — which is the divergence this
 * increment is about, and a fake that could express it would make a test of it meaningless. A scope
 * holding a refused row answers `latest` with `CheckpointRowUnreadable`, which models the one
 * arrangement a single-row read can see: the refused row at the top.
 *
 * The outcome it returns says only how many rows were read, how many the contract refused, and
 * whether the scan finished — not which anchor is highest. The store cannot answer that usefully,
 * because the witness is *the highest readable anchor the chain does not contradict* and the store
 * holds no chain; `anchorAudit.witnessSequence` is the figure, and the tests below state the
 * property over it rather than over anything this fake computes.
 */
function fakeCheckpoints(opts: {
  readonly records?: readonly ChainCheckpoint[];
  readonly unreadable?: readonly UnreadableRow[];
  readonly complete?: boolean;
  readonly scanThrows?: Error;
}): Record<string, unknown> {
  const records = opts.records ?? [];
  const unreadable = opts.unreadable ?? [];
  return {
    latest: async (): Promise<ChainCheckpoint | null> => {
      if (unreadable.length > 0) throw new CheckpointRowUnreadable(TENANT_A, unreadable[0]!);
      return records.length === 0 ? null : records[records.length - 1]!;
    },
    scanCheckpoints: async (
      _scope: string | null,
      onPage: (page: RowRead<ChainCheckpoint>) => void,
    ): Promise<CheckpointScanOutcome> => {
      if (opts.scanThrows !== undefined) throw opts.scanThrows;
      onPage({ records, unreadable });
      return {
        scanned: records.length + unreadable.length,
        refusedCount: unreadable.length,
        complete: opts.complete ?? true,
      };
    },
  };
}

/** A scheduler whose timer never fires on its own, so `runOnce` is driven explicitly. */
function manualScheduler(): { scheduler: IntervalScheduler; fire: () => void; cleared: boolean[] } {
  let handler: (() => void) | null = null;
  const cleared: boolean[] = [];
  return {
    cleared,
    fire: () => handler?.(),
    scheduler: {
      setInterval(h) {
        handler = h as () => void;
        return { id: 1 } as unknown as IntervalHandle;
      },
      clearInterval() {
        cleared.push(true);
      },
    },
  };
}

// A macrotask boundary, so every pending microtask has run by the time it resolves — the idiom four
// sibling test files here already use (`manifest-activation-poller.test.ts` calls it `flush`). A
// counted `await Promise.resolve()` chain is what it replaces: that models one await-depth of the
// scheduler's internals and silently stops modelling anything when the depth changes.
const drainMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("IntegrityProofConfigSchema", () => {
  it("defaults to hourly, all 500 rows, checkpoint-bounded, verdict recorded", () => {
    const c = parseIntegrityProofConfig({});
    expect(c).toMatchObject({
      schema: "meta",
      intervalMs: 3_600_000,
      verifiedBy: "operate-server",
      auditRowLimit: 500,
      fromCheckpoint: true,
      recordVerdict: true,
      // ADR-0332 flipped this, together with the checkpoint config's. Three escalators write
      // platform-scope rows, so `false` meant writing rows nothing verified — in the one table
      // where this proof is the only detector there is.
      includePlatform: true,
      allTenants: false,
      tenants: [],
    });
  });

  it("still honours an explicit false, so what changed is only what silence means", () => {
    expect(parseIntegrityProofConfig({ includePlatform: false }).includePlatform).toBe(false);
  });

  it("rejects an unknown key rather than ignoring a typo", () => {
    expect(() => parseIntegrityProofConfig({ intervalMsec: 1000 })).toThrow();
  });

  it("rejects a non-identifier schema name", () => {
    expect(() => parseIntegrityProofConfig({ schema: "meta; DROP TABLE x" })).toThrow();
  });

  it("rejects a non-uuid tenant", () => {
    expect(() => parseIntegrityProofConfig({ tenants: ["nope"] })).toThrow();
  });

  it("rejects a non-positive interval", () => {
    expect(() => parseIntegrityProofConfig({ intervalMs: 0 })).toThrow();
  });

  it("loads from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "integrity-"));
    try {
      const p = join(dir, "c.json");
      await writeFile(p, JSON.stringify({ intervalMs: 60_000, tenants: [TENANT_A] }));
      const c = await loadIntegrityProofConfig(p);
      expect(c.intervalMs).toBe(60_000);
      expect(c.tenants).toEqual([TENANT_A]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names the flag when the file is missing or malformed", async () => {
    await expect(loadIntegrityProofConfig("/nope/missing.json")).rejects.toThrow(
      /--integrity-proof-config: cannot read/,
    );
    const dir = await mkdtemp(join(tmpdir(), "integrity-"));
    try {
      const p = join(dir, "bad.json");
      await writeFile(p, "{not json");
      await expect(loadIntegrityProofConfig(p)).rejects.toThrow(
        /--integrity-proof-config: invalid JSON/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("integrityConfigScopes", () => {
  it("is the tenant list plus the platform chain, which is now the default", () => {
    // ADR-0332. The platform scope is included unless a deployment says otherwise, because the
    // three escalators that write it would otherwise be writing rows nothing verifies.
    expect(integrityConfigScopes(parseIntegrityProofConfig({ tenants: [TENANT_A] }))).toEqual([
      TENANT_A,
      null,
    ]);
    expect(
      integrityConfigScopes(
        parseIntegrityProofConfig({ tenants: [TENANT_A], includePlatform: false }),
      ),
    ).toEqual([TENANT_A]);
  });
});

describe("IntegrityProofScheduler — verdicts", () => {
  const run = async (r: IntegrityProofReport) => {
    const recorded: IntegrityProofReport[] = [];
    const passes: IntegrityProofReport[] = [];
    const findings: IntegrityProofReport[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => r,
      record: async (rep) => {
        recorded.push(rep);
        return 7;
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      onPass: (rep) => passes.push(rep),
      onFinding: (rep) => findings.push(rep),
    });
    return { results: await s.runOnce(), recorded, passes, findings };
  };

  it("records and reports a clean pass without raising a finding", async () => {
    const { results, recorded, passes, findings } = await run(report());
    expect(results[0]).toMatchObject({ outcome: "proved", recordedAt: 7 });
    expect(recorded).toHaveLength(1);
    expect(passes).toHaveLength(1);
    expect(findings).toEqual([]);
  });

  it("raises a finding only for compromised", async () => {
    const { findings } = await run(report({ verdict: "compromised" }));
    expect(findings).toHaveLength(1);
  });

  it("does NOT raise a finding for unproven — absence of evidence is not an alarm", async () => {
    const { findings, passes } = await run(report({ verdict: "unproven" }));
    expect(findings).toEqual([]);
    expect(passes).toHaveLength(1);
  });

  it("records the verdict even when compromised, so the finding outlives the process", async () => {
    const { recorded } = await run(report({ verdict: "compromised" }));
    expect(recorded[0]?.verdict).toBe("compromised");
  });

  it("computes but does not record when no record hook is wired", async () => {
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => report(),
      scopes: () => [TENANT_A],
      intervalMs: 1000,
    });
    const results = await s.runOnce();
    expect(results[0]).toMatchObject({ outcome: "proved" });
    expect(results[0]?.recordedAt).toBeUndefined();
  });
});

describe("IntegrityProofScheduler — passes", () => {
  it("skips a scope with no chain entries and no audit rows", async () => {
    const empty = report({
      chain: chainOk({ signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [], unreadable: [] } }),
      anchors: anchors({ checked: 0, verified: 0 }),
      truncation: noTruncation({ checkpointSequence: null, tailSequence: null }),
    });
    const recorded: unknown[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => empty,
      record: async () => {
        recorded.push(1);
        return 0;
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]).toEqual({ scope: TENANT_A, outcome: "skipped_empty" });
    // An idle tenant must not accrue hourly verdicts about nothing.
    expect(recorded).toEqual([]);
  });

  it("does not skip an empty chain that audit rows nonetheless claim", async () => {
    // Rows pointing at a chain with nothing in it is the anchor_missing case — very much not empty.
    const r = report({
      verdict: "compromised",
      chain: chainOk({ signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [], unreadable: [] } }),
      anchors: anchors({ ok: false, checked: 1, verified: 0, tampered: [tamperedResult] }),
      truncation: noTruncation({ checkpointSequence: null, tailSequence: null }),
    });
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => r,
      scopes: () => [TENANT_A],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]?.outcome).toBe("proved");
  });

  it("isolates a per-scope failure and finishes the rest", async () => {
    const errors: unknown[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async (scope) => {
        if (scope === TENANT_A) throw new Error("scope A exploded");
        return report({ scope });
      },
      scopes: () => [TENANT_A, TENANT_B],
      intervalMs: 1000,
      onError: (e) => errors.push(e),
    });
    const results = await s.runOnce();
    expect(results[0]).toMatchObject({ scope: TENANT_A, outcome: "error" });
    expect(results[1]).toMatchObject({ scope: TENANT_B, outcome: "proved" });
    expect(errors).toHaveLength(1);
  });

  it("routes a failure to record as a scope error rather than losing the pass", async () => {
    const errors: unknown[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => report(),
      record: async () => {
        throw new Error("chain unavailable");
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      onError: (e) => errors.push(e),
    });
    expect((await s.runOnce())[0]?.outcome).toBe("error");
    expect(errors).toHaveLength(1);
  });

  it("survives a failing scope source without throwing", async () => {
    const errors: unknown[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => report(),
      scopes: () => {
        throw new Error("tenant registry down");
      },
      intervalMs: 1000,
      onError: (e) => errors.push(e),
    });
    expect(await s.runOnce()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("proves every scope, including the platform chain", async () => {
    const seen: (string | null)[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async (scope) => {
        seen.push(scope);
        return report({ scope, anchors: scope === null ? null : anchors() });
      },
      scopes: () => [TENANT_A, null],
      intervalMs: 1000,
    });
    const results = await s.runOnce();
    expect(seen).toEqual([TENANT_A, null]);
    expect(results.map((r) => r.outcome)).toEqual(["proved", "proved"]);
  });

  it("re-reads the scope list each pass, so a new tenant is picked up", async () => {
    let scopes: (string | null)[] = [TENANT_A];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async (scope) => report({ scope }),
      scopes: () => scopes,
      intervalMs: 1000,
    });
    expect(await s.runOnce()).toHaveLength(1);
    scopes = [TENANT_A, TENANT_B];
    expect(await s.runOnce()).toHaveLength(2);
  });
});

describe("IntegrityProofScheduler — lifecycle", () => {
  it("runs once on start, then on each interval tick", async () => {
    let calls = 0;
    const skips: string[] = [];
    const m = manualScheduler();
    const s = new IntegrityProofScheduler({
      onPassSkipped: (reason) => skips.push(reason),
      prove: async () => {
        calls += 1;
        return report();
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      scheduler: m.scheduler,
    });
    s.start();
    await drainMicrotasks();
    expect(calls).toBe(1);
    m.fire();
    await drainMicrotasks();
    expect(calls).toBe(2);
    // The subject of this test is the wiring — a tick causes a pass — and since the overlap guard
    // landed that is only observable once the start pass has fully unwound. `skips` is the proof the
    // drain was sufficient: a counted-microtask drain would leave `inFlight` set, the tick would be
    // skipped, and `calls` alone would fail with no cause named (ADR-0370's own lesson about a fake
    // that models one numbering). The overlap itself has its own describe block below.
    expect(skips).toEqual([]);
  });

  it("can skip the immediate pass", async () => {
    let calls = 0;
    const m = manualScheduler();
    new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => {
        calls += 1;
        return report();
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      scheduler: m.scheduler,
      runOnStart: false,
    }).start();
    await Promise.resolve();
    expect(calls).toBe(0);
  });

  it("start is idempotent and stop clears the timer", () => {
    const m = manualScheduler();
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => report(),
      scopes: () => [],
      intervalMs: 1000,
      scheduler: m.scheduler,
      runOnStart: false,
    });
    s.start();
    s.start();
    s.stop();
    s.stop();
    expect(m.cleared).toEqual([true]);
  });
});

describe("integrityVerdictPayload", () => {
  it("is deterministic for the same report", () => {
    expect(integrityVerdictPayload(report())).toBe(integrityVerdictPayload(report()));
  });

  it("carries the verdict, the scope and both halves' outcomes", () => {
    const payload = integrityVerdictPayload(report());
    expect(payload).toContain('"kind":"audit_integrity_proof"');
    expect(payload).toContain('"verdict":"verified"');
    expect(payload).toContain(TENANT_A);
    expect(payload).toContain('"signaturesValid":true');
    expect(payload).toContain('"checked":2');
  });

  it("names each tampered row, so the finding is in what the chain commits to", () => {
    const payload = integrityVerdictPayload(
      report({ verdict: "compromised", anchors: anchors({ tampered: [tamperedResult] }) }),
    );
    expect(payload).toContain(tamperedResult.auditId);
    expect(payload).toContain("hash_mismatch");
  });

  it("differs when the verdict differs, so a verdict cannot be swapped undetected", () => {
    expect(integrityVerdictPayload(report({ verdict: "compromised" }))).not.toBe(
      integrityVerdictPayload(report()),
    );
  });

  it("records a null anchor half for the platform chain", () => {
    expect(integrityVerdictPayload(report({ scope: null, anchors: null }))).toContain(
      '"anchors":null',
    );
  });
});

describe("formatIntegrityProof", () => {
  // ADR-0371: `mode: "full"` alone cannot separate a caller who asked for a fold from genesis from
  // a bounded pass that *refused* its anchor, and the second is the one an operator must act on.
  // The key and not the prose `formatChainVerification` prints: the key indexes
  // `CHAIN_FULL_REASON_PHRASES`, so the two cannot diverge, and this line is the one a deployment
  // greps.
  it("names why a pass folded from genesis, beside the count it examined", () => {
    const text = formatIntegrityProof(
      report({
        chain: chainOk({ mode: "full", fullBecause: "anchor_unverified", checkpointSequence: null }),
      }),
    );
    expect(text).toContain("chain [full: anchor_unverified]");
    expect(text).toContain("4 checked");
  });

  it("prints no reason clause for a bounded pass, which has none", () => {
    const text = formatIntegrityProof(report({ chain: chainOk() }));
    expect(text).toContain("chain [from_checkpoint]:");
    // Over the enum rather than one hand-picked reason, so a fifth member cannot leak into this
    // line unnoticed.
    for (const reason of CHAIN_FULL_REASONS) expect(text).not.toContain(reason);
  });

  it("leads with the verdict and summarizes both halves", () => {
    const text = formatIntegrityProof(report());
    expect(text).toContain("VERIFIED");
    expect(text).toContain("integrity valid");
    expect(text).toContain("signatures valid");
    expect(text).toContain("unanchored 0");
  });

  it("names where the chain broke", () => {
    const text = formatIntegrityProof(
      report({ verdict: "compromised", chain: chainOk({ ok: false, integrity: { valid: false, brokenAt: 5 } }) }),
    );
    expect(text).toContain("BROKEN at 5");
  });

  it("lists each tampered audit row", () => {
    const text = formatIntegrityProof(
      report({ verdict: "compromised", anchors: anchors({ tampered: [tamperedResult] }) }),
    );
    expect(text).toContain("hash_mismatch");
    expect(text).toContain(tamperedResult.auditId);
  });

  it("omits the anchor line for the platform chain", () => {
    const text = formatIntegrityProof(report({ scope: null, anchors: null }));
    expect(text).toContain("platform");
    expect(text).not.toContain("anchors:");
  });
});

describe("INTEGRITY_VERDICTS", () => {
  it("enumerates exactly the three documented outcomes", () => {
    expect([...INTEGRITY_VERDICTS]).toEqual(["verified", "unproven", "compromised"]);
  });
});

describe("integrityVerdictFor", () => {
  it("verified: the chain holds and every row matches its anchor", () => {
    expect(integrityVerdictFor(chainOk(), anchors(), noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("verified");
  });

  it("verified: the platform chain, which has no rows to anchor", () => {
    expect(integrityVerdictFor(chainOk(), null, noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("verified");
  });

  it("compromised: a row no longer matches its anchor", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors({ ok: false, tampered: [tamperedResult] }), noTruncation(), [], noAnchorFindings(), noWitnessMemory()),
    ).toBe("compromised");
  });

  it("unproven: nothing disproven, but some rows carry no anchor", () => {
    expect(integrityVerdictFor(chainOk(), anchors({ ok: false, unanchored: 1 }), noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe(
      "unproven",
    );
  });

  it("compromised beats unproven when both are present", () => {
    expect(
      integrityVerdictFor(
        chainOk(),
        anchors({ ok: false, unanchored: 3, tampered: [tamperedResult] }),
        noTruncation(),
        [],
        noAnchorFindings(),
        noWitnessMemory(),
      ),
    ).toBe("compromised");
  });

  it("compromised: a broken chain, regardless of what the rows say", () => {
    // The anchors it holds cannot attest to anything once the chain they live in is broken, so a
    // clean anchor report must not soften the verdict.
    const broken = chainOk({ ok: false, integrity: { valid: false, brokenAt: 2 } });
    expect(integrityVerdictFor(broken, anchors(), noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
    expect(integrityVerdictFor(broken, null, noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
  });

  it("compromised: valid links but an unverifiable signature", () => {
    const unsigned = chainOk({
      ok: false,
      signatures: { valid: false, checked: 4, results: [], unresolvedFingerprints: [], unreadable: [] },
    });
    expect(integrityVerdictFor(unsigned, anchors(), noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
  });

  it("compromised: a chain row the contract refuses, through the chain half", () => {
    const refusedRow: UnreadableRow = { identity: "2", detail: "kind: invalid_enum_value" };
    const verdict = unreadableEntryVerdict([refusedRow]);
    expect(verdict).not.toBeNull();
    const refused = chainOk({
      ok: false,
      integrity: verdict!,
      signatures: {
        valid: false,
        checked: 2,
        results: [],
        unresolvedFingerprints: [],
        unreadable: [refusedRow],
      },
    });
    expect(integrityVerdictFor(refused, anchors(), noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
    expect(integrityVerdictFor(refused, null, noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
  });

  it("compromised: an audit row the reader refuses, where an unanchored one is only unproven", () => {
    const refused = anchors({
      ok: false,
      unreadable: [{ identity: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", detail: "operation: too_small" }],
    });
    expect(integrityVerdictFor(chainOk(), refused, noTruncation(), [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
    expect(
      integrityVerdictFor(chainOk(), anchors({ ok: false, unanchored: 1 }), noTruncation(), [], noAnchorFindings(), noWitnessMemory()),
    ).toBe("unproven");
  });

  it("treats a zero-row anchor report as verified, not unproven", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors({ checked: 0, verified: 0 }), noTruncation(), [], noAnchorFindings(), noWitnessMemory()),
    ).toBe("verified");
  });

  it("compromised: the anchor itself is a row the contract refuses", () => {
    // `record` begins with `ChainCheckpointSchema.parse`, so no checkpoint this binary writes can
    // be one it cannot read back — the same premise that makes a refused chain entry conclusive,
    // one table across (ADR-0373).
    const refusedAnchor: UnreadableRow = { identity: "4", detail: "provenance: invalid_enum_value" };
    expect(
      integrityVerdictFor(chainOk(), anchors(), noTruncation(), [], refusedAnchors(refusedAnchor), noWitnessMemory()),
    ).toBe("compromised");
  });

  it("compromised for a refused anchor wherever in the table it sits", () => {
    // `refusedCount` and not the newest row, which is the aperture ADR-0375 closes: measured live
    // on one scope with anchors at 1, 3 and 4, blanking `checkpointed_by` at sequence 1 answered
    // `verified` and the identical statement at sequence 4 answered `compromised`. The report the
    // verdict reads is a scan of the whole table, so the position is no longer part of the answer.
    const refusedAnchor: UnreadableRow = { identity: "1", detail: "checkpointedBy: too_small" };
    const audit = anchorAudit({
      scanned: 3,
      refused: [refusedAnchor],
      refusedCount: 1,
      // The two readable anchors above it still produce a witness, so nothing else about the pass
      // changes — which is what makes this the refusal's own answer.
      witnessSequence: 4,
    });
    expect(integrityVerdictFor(chainOk(), anchors(), noTruncation(), [], audit, noWitnessMemory())).toBe(
      "compromised",
    );
  });

  it("compromised for a refused anchor even where there is nothing anchored to check", () => {
    // Asked **before** `anchors === null`, so the finding does not depend on whether anything else
    // in the scope happened to be anchored. The platform chain is the live case: it carries
    // escalation rows and frequently nothing else.
    const refusedAnchor: UnreadableRow = { identity: "4", detail: "provenance: invalid_enum_value" };
    expect(
      integrityVerdictFor(chainOk(), null, noTruncation(), [], refusedAnchors(refusedAnchor), noWitnessMemory()),
    ).toBe("compromised");
    expect(
      integrityVerdictFor(
        chainOk(),
        anchors({ checked: 0, verified: 0 }),
        noTruncation(),
        [],
        refusedAnchors(refusedAnchor),
        noWitnessMemory(),
      ),
    ).toBe("compromised");
  });

  it("compromised for a readable anchor the chain contradicts, which refuses nothing", () => {
    // The second face of the aperture, and the one no list of refused rows could carry: the row
    // parses, so `refusedCount` is 0 and every other half of the report is clean. Measured live as
    // the non-owner `serving` role on a fully-converged deployment — `sequence_number`'s only CHECK
    // is `>= 0`, so raising an anchor from 4 to 99 answered `truncated=true witness=99
    // causes=[chain_truncated]` over a chain with every entry present.
    const audit = anchorAudit({
      scanned: 1,
      disagreeing: [{ kind: "sequence_relocated", sequenceNumber: 99, matchedAt: 4 }],
    });
    expect(integrityVerdictFor(chainOk(), anchors(), noTruncation(), [], audit, noWitnessMemory())).toBe(
      "compromised",
    );
    expect(audit.refusedCount).toBe(0);
  });

  it("unproven, not compromised, for a scan the ceiling stopped", () => {
    // Nothing is disproven — `refusedCount: 0` and no disagreement — so paging would be an absence
    // of evidence read as evidence (ADR-0372). But the counts are a lower bound, so `verified`
    // would claim a reading nobody took, and this is the one place that decides whether anybody is
    // woken.
    expect(
      integrityVerdictFor(
        chainOk(),
        anchors(),
        noTruncation(),
        [],
        anchorAudit({ scanned: 1000, complete: false, witnessSequence: 1000 }),
        noWitnessMemory(),
      ),
    ).toBe("unproven");
  });

  it("refuses `verified` on an incomplete scan even where the anchor half is clean or absent", () => {
    // Asked **before** `anchors === null`, for `checkpoint_row_refused`'s reason one verdict over:
    // the platform chain frequently has nothing anchored, and the coverage question is about a
    // different table, so the anchor half must not be able to answer it.
    const incomplete = anchorAudit({ scanned: 5, complete: false });
    expect(integrityVerdictFor(chainOk(), null, noTruncation(), [], incomplete, noWitnessMemory())).toBe("unproven");
    expect(
      integrityVerdictFor(
        chainOk(),
        anchors({ checked: 0, verified: 0 }),
        noTruncation(),
        [],
        incomplete,
        noWitnessMemory(),
      ),
    ).toBe("unproven");
  });

  it("lets a compromise outrank an incomplete scan, so the finding is not downgraded", () => {
    expect(
      integrityVerdictFor(
        chainOk(),
        anchors(),
        noTruncation(),
        [],
        anchorAudit({ scanned: 5, complete: false, refused: [], refusedCount: 2 }),
        noWitnessMemory(),
      ),
    ).toBe("compromised");
  });
});

describe("integrityVerdictFor — truncation", () => {
  const cut = noTruncation({ checkpointSequence: 9, tailSequence: 4, truncated: true });

  it("compromised when the chain ends before a checkpoint it was committed to", () => {
    // The decisive case: every link and signature still verifies, because a truncated chain is a
    // shorter well-formed chain. Only the checkpoint reveals that history went missing.
    expect(integrityVerdictFor(chainOk(), anchors(), cut, [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
  });

  it("outranks a clean chain and clean anchors", () => {
    expect(integrityVerdictFor(chainOk({ ok: true }), anchors({ ok: true }), cut, [], noAnchorFindings(), noWitnessMemory())).toBe(
      "compromised",
    );
  });

  it("compromised on the platform chain too", () => {
    expect(integrityVerdictFor(chainOk(), null, cut, [], noAnchorFindings(), noWitnessMemory())).toBe("compromised");
  });

  it("not truncated when the tail is at or beyond the checkpoint", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors(), noTruncation({ checkpointSequence: 4, tailSequence: 4 }), [], noAnchorFindings(), noWitnessMemory()),
    ).toBe("verified");
  });

  it("cannot be judged before the first checkpoint, and does not fail closed there", () => {
    // No checkpoint means no witness; calling that compromised would make every fresh deployment
    // a finding. The formatter says so instead.
    expect(
      integrityVerdictFor(
        chainOk(),
        anchors(),
        noTruncation({ checkpointSequence: null, tailSequence: null }),
        [],
        noAnchorFindings(),
        noWitnessMemory(),
      ),
    ).toBe("verified");
  });
});

/**
 * The compromise half of `integrityVerdictFor`, which is a list rather than a sequence of `if`s
 * because a seventh branch added to that sequence was invisible to the whole suite: the escalation
 * row named two of the then-six conditions, and the block that claimed one test per branch was
 * refuted by mutation (ADR-0374's addendum).
 *
 * Every assertion here is walked from the enum. The hand-written per-condition tests above are the
 * golden for the answers themselves — they were written against the sequence of `if`s and are
 * untouched — which is deliberately not a truth table compared against that sequence rewritten in
 * the test: a rule compared against a derivation of itself is ADR-0362's retired test.
 *
 * A seventh cause has since arrived for real (`checkpoint_disagrees_with_chain`, ADR-0375), so the
 * fence has been exercised by something other than a mutation: the compiler asked for a predicate,
 * an enum member, a payload key and a fixture in each of the two suites, in that order.
 */
describe("COMPROMISE_CAUSES", () => {
  const evidence = (over: Partial<CompromiseEvidence> = {}): CompromiseEvidence => ({
    chain: chainOk(),
    anchors: anchors(),
    truncation: noTruncation(),
    witnessMemory: noWitnessMemory(),
    chainRowsRefused: [],
    anchorAudit: anchorAudit(),
    ...over,
  });
  const refusedRow: UnreadableRow = { identity: "2", detail: "kind: invalid_enum_value" };
  /**
   * One evidence set per cause, exhibiting that cause and no other — which the second test proves
   * rather than this comment claiming. Total, so a seventh member does not compile until somebody
   * writes evidence that exhibits it.
   */
  const EXHIBITS: Record<CompromiseCause, Partial<CompromiseEvidence>> = {
    chain_truncated: {
      truncation: noTruncation({ checkpointSequence: 9, tailSequence: 4, truncated: true }),
    },
    chain_broken_or_unsigned: {
      chain: chainOk({ ok: false, integrity: { valid: false, brokenAt: 2 } }),
    },
    chain_row_refused: { chainRowsRefused: [refusedRow] },
    checkpoint_row_refused: { anchorAudit: refusedAnchors(refusedRow) },
    checkpoint_disagrees_with_chain: {
      anchorAudit: anchorAudit({
        scanned: 1,
        disagreeing: [{ kind: "root_hash_mismatch", sequenceNumber: 4, matchedAt: null }],
      }),
    },
    audit_row_tampered: { anchors: anchors({ ok: false, tampered: [tamperedResult] }) },
    audit_row_refused: { anchors: anchors({ ok: false, unreadable: [refusedRow] }) },
    // The memory axis. Both fixtures leave every *other* axis clean, which is the whole point of
    // this map: these two causes are the only ones that can fire over a chain and an anchor table
    // that agree with each other, because that is exactly the state the two attacks produce.
    witness_regressed: {
      witnessMemory: {
        outcome: "witness_regressed",
        attestedWitness: 5,
        attestedTail: 5,
        attestedAt: AT,
        detail: null,
      },
    },
    verdict_disagrees_with_chain: {
      witnessMemory: {
        outcome: "prior_verdict_contradicted",
        attestedWitness: 5,
        attestedTail: 5,
        attestedAt: AT,
        detail: null,
      },
    },
  };
  const verdictOf = (e: CompromiseEvidence) =>
    integrityVerdictFor(e.chain, e.anchors, e.truncation, e.chainRowsRefused, e.anchorAudit, e.witnessMemory);
  /** The causes that read `witnessMemory.outcome`, which is one field and so names one of them. */
  const MEMORY_CAUSES = ["witness_regressed", "verdict_disagrees_with_chain"] as const;

  it("enumerates the nine conditions, the first six in the order they were asked in", () => {
    // The seventh is placed beside its sibling rather than appended, so this assertion is also
    // where an insertion in the middle is visible: `compromiseCauses` filters, so inserting there
    // cannot change `causes[0]` for any evidence the original six describe, and the test below
    // asserting enum order over a full fixture is what holds that.
    //
    // The two memory causes are **appended** rather than placed, and that position is the finding
    // rather than housekeeping: a real truncation with the anchors left alone exhibits
    // `chain_truncated` and these two are silent, while the same truncation laundered by lowering
    // the anchors onto it exhibits only these. So an operator meeting a genuine cut is still sent
    // to the chain first, and precedence is what does that.
    expect([...COMPROMISE_CAUSES]).toEqual([
      "chain_truncated",
      "chain_broken_or_unsigned",
      "chain_row_refused",
      "checkpoint_row_refused",
      "checkpoint_disagrees_with_chain",
      "audit_row_tampered",
      "audit_row_refused",
      "witness_regressed",
      "verdict_disagrees_with_chain",
    ]);
  });

  it("cannot report both memory causes at once, because they are one field's outcome", () => {
    // A property of the axis and not of this fixture, which is why it is asserted rather than left
    // for the next reader to discover from the test below: both causes read
    // `witnessMemory.outcome`, and `compareWitnessMemory` returns at the first conclusive clause,
    // so one `WitnessMemoryCheck` names exactly one of them. Either alone is `compromised`, so
    // nothing is lost — but "every cause at once" is **unsatisfiable**, and a fixture that tried
    // would be asserting a state no report can hold.
    const both = compromiseCauses(
      evidence({ ...EXHIBITS.witness_regressed, ...EXHIBITS.verdict_disagrees_with_chain }),
    );
    expect(both).toHaveLength(1);
    expect(MEMORY_CAUSES.filter((c) => both.includes(c))).toHaveLength(1);
  });

  it("names every witness-memory outcome graded `disproves`, and names no other", () => {
    // The fence no *type* can give, and the one the two predicates above promise. Both read
    // `witnessMemory.outcome` with `===`, so a tenth `WITNESS_MEMORY_OUTCOMES` member graded
    // `disproves` and named by neither would be `compromised` to `witness-memory.ts` and invisible
    // to this judgement — a verdict reading `verified` beside an axis that disproves something.
    //
    // Both directions, because neither half is sufficient. Forward catches the new outcome nobody
    // wired; backward catches a cause whose predicate was edited to read an outcome that no longer
    // exists, which would make it unreachable and leave a modelled cause with no producer
    // (ADR-0384's class). Driven through `compromiseCauses` and `integrityVerdictFor` rather than
    // by comparing the two constants, so what is asserted is the behaviour and not an agreement
    // between two lists.
    const named = new Set<string>();
    for (const outcome of WITNESS_MEMORY_OUTCOMES) {
      const memory = { ...noWitnessMemory(), outcome };
      const causes = compromiseCauses(evidence({ witnessMemory: memory }));
      const disproves = WITNESS_MEMORY_GRADE[outcome] === "disproves";
      expect(causes.length, outcome).toBe(disproves ? 1 : 0);
      if (disproves) {
        expect(MEMORY_CAUSES, outcome).toContain(causes[0]);
        named.add(causes[0] as string);
        expect(verdictOf(evidence({ witnessMemory: memory })), outcome).toBe("compromised");
      } else {
        // The other two grades are the verdict's other two answers, and the mapping is what the
        // verdict reads rather than what this axis says about itself.
        expect(verdictOf(evidence({ witnessMemory: memory })), outcome).toBe(
          witnessMemoryUnproven(memory) ? "unproven" : "verified",
        );
      }
    }
    expect([...named].sort()).toEqual([...MEMORY_CAUSES].sort());
  });

  it("names each cause, and only it, for evidence exhibiting exactly that one", () => {
    for (const cause of COMPROMISE_CAUSES) {
      expect(compromiseCauses(evidence(EXHIBITS[cause]))).toEqual([cause]);
    }
  });

  it("answers nothing for evidence that disproves nothing", () => {
    expect(compromiseCauses(evidence())).toEqual([]);
    expect(compromiseCauses(evidence({ anchors: null }))).toEqual([]);
    // An unanchored row is unproven and not a cause: the one judgement in the verdict that is
    // neither `verified` nor a finding, and it must stay out of this list or every deployment
    // upgrading from before ADR-0286 would page.
    expect(compromiseCauses(evidence({ anchors: anchors({ ok: false, unanchored: 3 }) }))).toEqual(
      [],
    );
  });

  it("drives the verdict: every cause alone is compromised, and no cause never is", () => {
    for (const cause of COMPROMISE_CAUSES) {
      expect(verdictOf(evidence(EXHIBITS[cause])), cause).toBe("compromised");
    }
    expect(verdictOf(evidence())).toBe("verified");
    expect(verdictOf(evidence({ anchors: anchors({ ok: false, unanchored: 3 }) }))).toBe(
      "unproven",
    );
  });

  it("reports several causes in enum order, so the one asked first still reads first", () => {
    expect(
      compromiseCauses(evidence({ ...EXHIBITS.chain_truncated, ...EXHIBITS.audit_row_refused })),
    ).toEqual(["chain_truncated", "audit_row_refused"]);
    // Every condition that **can** hold at once, which is every member but one: the two memory
    // causes are one field's outcome and so are mutually exclusive (asserted above). The
    // expectation is therefore the enum minus whichever of the pair this fixture does not
    // exhibit — derived from `COMPROMISE_CAUSES` rather than written out, so the precedence
    // `chain_truncated` was given stays a property of that list's order and of nothing else, and
    // a tenth member joins this assertion without it being edited.
    expect(
      compromiseCauses(
        evidence({
          truncation: noTruncation({ checkpointSequence: 9, tailSequence: 4, truncated: true }),
          chain: chainOk({ ok: false, integrity: { valid: false, brokenAt: 2 } }),
          chainRowsRefused: [refusedRow],
          anchorAudit: anchorAudit({
            scanned: 2,
            refused: [refusedRow],
            refusedCount: 1,
            disagreeing: [{ kind: "root_hash_mismatch", sequenceNumber: 4, matchedAt: null }],
          }),
          anchors: anchors({ ok: false, tampered: [tamperedResult], unreadable: [refusedRow] }),
          ...EXHIBITS.witness_regressed,
        }),
      ),
    ).toEqual(COMPROMISE_CAUSES.filter((c) => c !== "verdict_disagrees_with_chain"));
  });

  it("agrees with `anchorAuditDisproves` over the two causes that read that report", () => {
    // The cost of reading the audit through two predicates rather than through
    // `anchorAuditDisproves` itself: a third disjunct added there would reach the scheduler's
    // findings hook and neither cause here, so a verdict could read `verified` beside an anchor
    // finding. Asserted over the three shapes that decide this predicate — clean, refusal-only,
    // disagreement-only — rather than by calling the predicate from the production code, which
    // would be a rule compared against itself (ADR-0362). Deliberately not "every shape the report
    // can hold": `complete: false` is a fourth, and it is `anchorAuditHasFindings`' arm rather than
    // this one, so including it here would assert the equality this test exists to deny.
    const refusalOnly = refusedAnchors(refusedRow);
    const disagreementOnly = anchorAudit({
      scanned: 1,
      disagreeing: [{ kind: "sequence_relocated", sequenceNumber: 9, matchedAt: 4 }],
    });
    for (const audit of [anchorAudit(), refusalOnly, disagreementOnly]) {
      expect(compromiseCauses(evidence({ anchorAudit: audit })).length > 0).toBe(
        anchorAuditDisproves(audit),
      );
    }
  });

  it("is the only route to a compromised verdict, which no type can fence", async () => {
    // A total map makes a seventh *condition* a compile error; a bare `if (…) return` of that
    // verdict in a function body is invisible to it, so reading the module as text is the only
    // fence available (ADR-0357's shape). Two assertions, because the count alone would admit the
    // gate being replaced by something else: there is one such statement, and it is the one
    // `compromiseCauses` decides.
    //
    // Whole-line comments are dropped first, and the test found out why on its first run — the
    // prose two functions up quotes the statement it is warning about, so matching the raw source
    // counted two and the fence would have had to be written down to 2 and then been vacuous. The
    // semicolon is the second half of that: a quoted fragment in prose carries none.
    const source = await readFile(new URL("./integrity-proof.ts", import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    const answered = code.filter((line) => line.includes('return "compromised";'));
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatch(/causes\.length > 0\) return "compromised";/);
  });
});

describe("truncation in the verdict payload and format", () => {
  const cut = noTruncation({ checkpointSequence: 9, tailSequence: 4, truncated: true });

  it("the chain commits to the truncation finding", () => {
    const payload = integrityVerdictPayload(report({ verdict: "compromised", truncation: cut }));
    expect(payload).toContain('"truncated":true');
    expect(payload).toContain('"checkpointSequence":9');
    expect(payload).toContain('"tailSequence":4');
  });

  it("the formatter names the gap", () => {
    const text = formatIntegrityProof(report({ verdict: "compromised", truncation: cut }));
    expect(text).toContain("TRUNCATED");
    expect(text).toContain("checkpoint at 9");
    expect(text).toContain("ends at 4");
  });

  it("the formatter admits when truncation is not checkable", () => {
    const text = formatIntegrityProof(
      report({ truncation: noTruncation({ checkpointSequence: null, tailSequence: 2 }) }),
    );
    expect(text).toContain("not checkable");
    expect(text).toContain("run the checkpoint scheduler");
  });

  it("does not offer the scheduler as the remedy when no anchor can be stood behind", () => {
    // Both halves of that sentence are false for a refused anchor — there **is** a checkpoint, and
    // `record` is `ON CONFLICT … DO NOTHING`, so running the scheduler leaves the unreadable row
    // exactly where it is (ADR-0334: a remedy that cannot work is worse than naming none).
    const refusedAnchor: UnreadableRow = { identity: "4", detail: "provenance: invalid_enum_value" };
    const text = formatIntegrityProof(
      report({
        verdict: "compromised",
        truncation: noTruncation({ checkpointSequence: null, tailSequence: 2 }),
        anchorAudit: refusedAnchors(refusedAnchor),
      }),
    );
    expect(text).toContain("not checkable");
    expect(text).not.toContain("run the checkpoint scheduler");
    expect(text).toContain("checkpoint 4 (provenance: invalid_enum_value)");
  });

  it("withholds the same remedy when every anchor is readable and contradicted", () => {
    // The arm reads the audit's findings and not its refusal list, which is what makes it right for
    // this case too: the rows parse, so a refusal-keyed condition would have printed "run the
    // checkpoint scheduler" for a scope whose anchors say something false.
    const text = formatIntegrityProof(
      report({
        verdict: "compromised",
        truncation: noTruncation({ checkpointSequence: null, tailSequence: 2 }),
        anchorAudit: anchorAudit({
          scanned: 1,
          disagreeing: [{ kind: "sequence_relocated", sequenceNumber: 9, matchedAt: 4 }],
        }),
      }),
    );
    expect(text).toContain("not checkable");
    expect(text).not.toContain("run the checkpoint scheduler");
    expect(text).toContain("anchor at 9: sequence_relocated");
    expect(text).toContain("the entry at 4");
  });

  it("still offers the scheduler when the scope genuinely has no anchors", () => {
    const text = formatIntegrityProof(
      report({ truncation: noTruncation({ checkpointSequence: null, tailSequence: 2 }) }),
    );
    expect(text).toContain("run the checkpoint scheduler");
  });

  /** A prior verdict that attested figures, for the one arm that reads them. */
  const attesting = (over: {
    readonly attestedWitness: number | null;
    readonly attestedTail: number | null;
  }): WitnessMemoryCheck => ({
    ...noWitnessMemory(),
    outcome: "consistent",
    attestedAt: AT,
    ...over,
  });

  it("offers the scheduler to a scope whose prior verdict attested a tail and no anchor", () => {
    // `witnessMemoryShowsHistory` is `attestedTail !== null || attestedWitness !== null`, and a
    // deployment running the proof with nothing anchored stores exactly that: a tail and a null
    // witness. Keyed on history, this arm told such an operator "this scope HAD anchors — do NOT
    // run the checkpoint scheduler": false in both halves, and it inverts the remedy for the one
    // operator who should run it. Every pre-existing test of this arm passed `noWitnessMemory()`,
    // so the branch ADR-0399 added had no coverage at all and the conflation was unobservable.
    const text = formatIntegrityProof(
      report({
        verdict: "compromised",
        truncation: noTruncation({ checkpointSequence: null, tailSequence: 2 }),
        witnessMemory: attesting({ attestedWitness: null, attestedTail: 2 }),
      }),
    );
    // On the OFFERING sentence and not on the bare phrase: the opposite arm reads "do NOT run the
    // checkpoint scheduler", which contains it, so a negative assertion on the phrase alone is
    // satisfied by neither arm and discriminates nothing.
    expect(text).toContain("no checkpoint yet — run the checkpoint scheduler");
    expect(text).not.toContain("HAD anchors");
  });

  it("withholds it from a scope whose prior verdict attested an anchor that is now gone", () => {
    // The control, and what stops the assertion above being satisfiable by deleting the arm: here
    // the anchors really were destroyed, so running the scheduler would anchor past the gap.
    const text = formatIntegrityProof(
      report({
        verdict: "compromised",
        truncation: noTruncation({ checkpointSequence: null, tailSequence: 9 }),
        witnessMemory: attesting({ attestedWitness: 4, attestedTail: 9 }),
      }),
    );
    expect(text).toContain("HAD anchors");
    expect(text).toContain("do NOT run the checkpoint scheduler");
    expect(text).not.toContain("no checkpoint yet");
  });

  it("names a refused anchor on a scope with nothing anchored at all", () => {
    // Printed outside the `anchors !== null` block, because `anchorAudit` is a required field the
    // proof computes unconditionally: a scope with no anchored rows still has to report its
    // refusal. (This said "the anchor table is read before the audit rows are looked at" until
    // ADR-0407 reversed that order; the placement is unaffected, because what it depends on is the
    // field's presence and not its freshness.)
    const refusedAnchor: UnreadableRow = { identity: "4", detail: "provenance: invalid_enum_value" };
    const text = formatIntegrityProof(
      report({ verdict: "compromised", anchors: null, anchorAudit: refusedAnchors(refusedAnchor) }),
    );
    expect(text).toContain("checkpoint 4");
    // Still exactly the assertion this test was written with, which is the point: the audit's own
    // lines open `checkpoints:`, so nothing in this block claims the word `anchors:` but the anchor
    // half — and that line is absent for a scope with nothing anchored.
    expect(text).not.toContain("anchors:");
  });

  it("says nothing about the anchor table on a clean pass, as the block it replaced did not", () => {
    // Gated on findings rather than printed unconditionally: `formatAnchorAudit` always opens with
    // a scanned/witness line, and this is the only surface that runs unattended, so a clean scope's
    // line count stays what it was.
    const text = formatIntegrityProof(report());
    expect(text).not.toContain("checkpoints:");
  });

  it("names a scan the ceiling stopped, which is the half no refusal list could carry", () => {
    const text = formatIntegrityProof(
      report({
        verdict: "unproven",
        anchorAudit: anchorAudit({ scanned: 1000, complete: false, witnessSequence: 1000 }),
      }),
    );
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("checkpoints: 1000 row(s) scanned");
  });
});

describe("IntegrityProofScheduler — emptiness is judged by the tail, not the signature count", () => {
  it("still proves a scope whose checkpoint has caught up to the tail", async () => {
    // from_checkpoint mode checks only the suffix, so `signatures.checked` is legitimately 0 for
    // a chain with entries. Keying emptiness on that would silently stop proving the scope.
    const caughtUp = report({
      scope: null,
      anchors: null,
      chain: chainOk({
        tenantId: null,
        mode: "from_checkpoint",
        checkpointSequence: 11,
        signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [], unreadable: [] },
      }),
      truncation: noTruncation({ checkpointSequence: 11, tailSequence: 11 }),
    });
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => caughtUp,
      scopes: () => [null],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]?.outcome).toBe("proved");
  });

  it("skips a scope with no tail and no rows", async () => {
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () =>
        report({
          anchors: anchors({ checked: 0, verified: 0 }),
          truncation: noTruncation({ checkpointSequence: null, tailSequence: null }),
        }),
      scopes: () => [TENANT_A],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]?.outcome).toBe("skipped_empty");
  });
});

/**
 * `skipped_empty` is the one outcome that discards the report — the scheduler pushes it and
 * `continue`s past `onPass`, `onFinding`, `record` and `escalate` — so a refused row must never
 * land on it: a refused row is the finding (ADR-0373).
 *
 * Asserted as a **pair** on purpose, in both directions. A test that only checked the refusal
 * reached the callbacks would be satisfied by a predicate that never skips anything, and that is
 * not a safe degeneration — it would have every idle tenant accruing an hourly verdict about
 * nothing, which is the behaviour the emptiness test exists for.
 */
describe("IntegrityProofScheduler — a refused row is not an empty scope", () => {
  /** No chain entries and no checkpoint: the shape that used to be enough to discard the pass. */
  const emptyChain = {
    chain: chainOk({
      signatures: {
        valid: true,
        checked: 0,
        results: [],
        unresolvedFingerprints: [],
        unreadable: [],
      },
    }),
    truncation: noTruncation({ checkpointSequence: null, tailSequence: null }),
  };
  const refusedAuditRow: UnreadableRow = {
    identity: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    detail: "operation: too_small",
  };

  it("runs every callback and records a verdict when the only audit row was refused", async () => {
    const empty = report({
      ...emptyChain,
      verdict: "compromised",
      // `checked: 0` beside one refused row is the honest pair since ADR-0373 made that figure the
      // rows *examined* — and it is exactly the pair the old predicate read as "there were no
      // rows". Reproduced live as a non-owner: one audit row with a blanked `operation` for a scope
      // with no chain entries computed `compromised`, and the scheduler discarded it.
      anchors: anchors({ ok: false, checked: 0, verified: 0, unreadable: [refusedAuditRow] }),
    });
    const passed: IntegrityProofReport[] = [];
    const findings: IntegrityProofReport[] = [];
    const recorded: IntegrityProofReport[] = [];
    const escalated: IntegrityProofReport[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => empty,
      record: async (r) => {
        recorded.push(r);
        return 7;
      },
      escalate: async (r) => {
        escalated.push(r);
        return { kind: "opened", incidentId: "INC-2026-0001" };
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      onPass: (r) => passed.push(r),
      onFinding: (r) => findings.push(r),
    });
    expect((await s.runOnce())[0]).toMatchObject({
      scope: TENANT_A,
      outcome: "proved",
      recordedAt: 7,
      escalation: { kind: "opened", incidentId: "INC-2026-0001" },
    });
    // Every axis the pass has: the line an operator reads, the finding hook, the durable verdict
    // and the alarm. Before the fix this was `[0, 0, 0, 0]`.
    expect([passed.length, findings.length, recorded.length, escalated.length]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it("still skips the same scope when nothing was refused", async () => {
    const recorded: unknown[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () => report({ ...emptyChain, anchors: anchors({ checked: 0, verified: 0 }) }),
      record: async () => {
        recorded.push(1);
        return 0;
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]).toEqual({ scope: TENANT_A, outcome: "skipped_empty" });
    expect(recorded).toEqual([]);
  });

  it("is not empty on either chain-side refusal axis either", async () => {
    // Neither of these is reachable through `proveScopeIntegrity` as it stands — `tail()` reads the
    // raw columns, so a chain holding any row answers a non-null `tailSequence` and fails the first
    // conjunct long before this one. They are fenced anyway, because an axis dropped on the
    // strength of what a read one layer down happens to do today is this defect again the day that
    // read starts parsing, and the mistake would be silent in both cases.
    const refused: UnreadableRow = { identity: "2", detail: "kind: invalid_enum_value" };
    const outcomeFor = async (over: Partial<IntegrityProofReport>): Promise<string | undefined> => {
      const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
        prove: async () =>
          report({ ...emptyChain, anchors: anchors({ checked: 0, verified: 0 }), ...over }),
        scopes: () => [TENANT_A],
        intervalMs: 1000,
      });
      return (await s.runOnce())[0]?.outcome;
    };
    expect(await outcomeFor({ chainRowsRefused: [refused] })).toBe("proved");
    expect(
      await outcomeFor({
        chain: chainOk({
          ok: false,
          signatures: {
            valid: false,
            checked: 0,
            results: [],
            unresolvedFingerprints: [],
            unreadable: [refused],
          },
        }),
      }),
    ).toBe("proved");
  });

  it("is not empty when the anchor itself is the row that cannot be read", async () => {
    // The axis of the four that genuinely fires here, and the reason it does is the part worth
    // keeping: a refused anchor leaves `checkpointSequence` null, so `truncated` is **false** and
    // the truncation half says nothing — which satisfied every other conjunct and had the report
    // discarded before `onPass`, `record`, `onFinding` and `escalate`.
    const refusedAnchor: UnreadableRow = { identity: "4", detail: "provenance: invalid_enum_value" };
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: async () =>
        report({
          ...emptyChain,
          anchors: anchors({ checked: 0, verified: 0 }),
          anchorAudit: refusedAnchors(refusedAnchor),
        }),
      scopes: () => [TENANT_A],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]?.outcome).toBe("proved");
  });

  it("is not empty for an anchor the chain contradicts, nor for a scan that stopped short", async () => {
    // The anchor conjunct is `anchorAuditHasFindings` and so is wider than the refused-row list it
    // replaced, which is what this asserts: a contradicted anchor is something found and an unread
    // tail is something not read, and `skipped_empty` claims neither happened. Both verdicts are
    // left at `verified` on purpose, so the answer is this conjunct's and not the clause in front
    // of it.
    const outcomeFor = async (audit: AnchorAuditReport): Promise<string | undefined> => {
      const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
        prove: async () =>
          report({ ...emptyChain, anchors: anchors({ checked: 0, verified: 0 }), anchorAudit: audit }),
        scopes: () => [TENANT_A],
        intervalMs: 1000,
      });
      return (await s.runOnce())[0]?.outcome;
    };
    expect(
      await outcomeFor(
        anchorAudit({
          scanned: 1,
          disagreeing: [{ kind: "root_hash_mismatch", sequenceNumber: 2, matchedAt: null }],
        }),
      ),
    ).toBe("proved");
    expect(await outcomeFor(anchorAudit({ scanned: 9, complete: false }))).toBe("proved");
  });
});

/**
 * The same rule one condition across, and the one the block above missed.
 *
 * `skipped_empty` discards the report, so what it must claim is *this pass found nothing to
 * verify* — and that is answerable from the **verdict**, which is total over every condition,
 * rather than from a conjunct list that has to be revisited whenever a condition is added.
 * ADR-0373 added a fourth refusal axis to `readEveryRowFound` and argued at length about which
 * axes fire there without re-reading the other two conjuncts against `integrityVerdictFor`, where
 * `truncation.truncated` is asked **first** and was a conjunct of neither. So the *weaker*
 * evidence — an anchor that cannot be read — was kept, and the *stronger*, a proven total
 * truncation, was still thrown away.
 *
 * Driven through the real `proveScopeIntegrity` rather than a hand-built report, because that is
 * what makes the pair below a measurement: the only difference between the two is whether the
 * checkpoint read answers a row, and everything else — the verdict, the truncation flag, the
 * outcome — is computed.
 */
describe("IntegrityProofScheduler — a proven truncation is not an empty scope", () => {
  /** An empty chain: no entries, no tail. The shape that satisfies every other conjunct. */
  const depsFor = (checkpoint: ChainCheckpoint | null) =>
    ({
      logStore: {
        loadChain: async () => ({ entries: [], unreadable: [] }),
        tail: async () => null,
      },
      // The witness comes from the audit, which reads the whole table: with an empty chain the
      // correspondence finds no entry at the anchor's sequence **and** none carrying its root hash,
      // which is the one arm that leaves an anchor a witness without agreeing with anything — and
      // is exactly what a total truncation looks like from here.
      checkpoints: fakeCheckpoints(checkpoint === null ? {} : { records: [checkpoint] }),
      registry: { getByFingerprint: async () => null },
      audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
      auditRowLimit: 10,
      fromCheckpoint: false,
      now: () => new Date(AT),
    }) as unknown as Parameters<typeof proveScopeIntegrity>[1];

  const passOver = async (deps: Parameters<typeof proveScopeIntegrity>[1]) => {
    const passed: IntegrityProofReport[] = [];
    const findings: IntegrityProofReport[] = [];
    const recorded: IntegrityProofReport[] = [];
    const escalated: IntegrityProofReport[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
      prove: (scope) => proveScopeIntegrity(scope, deps),
      record: async (r) => {
        recorded.push(r);
        return 7;
      },
      escalate: async (r) => {
        escalated.push(r);
        return { kind: "opened", incidentId: "INC-2026-0001" };
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      onPass: (r) => passed.push(r),
      onFinding: (r) => findings.push(r),
    });
    return {
      result: (await s.runOnce())[0],
      callbacks: [passed.length, findings.length, recorded.length, escalated.length],
    };
  };

  it("files the verdict and every callback when the chain ends before its checkpoint", async () => {
    // Measured live on exactly this shape before the fix: `verdict=compromised truncated=true
    // checkpointSequence=3 tailSequence=null`, `outcome=skipped_empty`, `callbacks=[]`, and the
    // formatter's TRUNCATED line printed by nobody.
    const proof = await proveScopeIntegrity(TENANT_A, depsFor(checkpointAt(3, "a".repeat(64))));
    expect(proof.truncation).toMatchObject({
      checkpointSequence: 3,
      tailSequence: null,
      truncated: true,
    });
    expect(proof.verdict).toBe("compromised");
    expect(formatIntegrityProof(proof)).toContain("TRUNCATED: checkpoint at 3");

    const { result, callbacks } = await passOver(depsFor(checkpointAt(3, "a".repeat(64))));
    expect(result).toMatchObject({ outcome: "proved", recordedAt: 7 });
    expect(callbacks).toEqual([1, 1, 1, 1]);
  });

  it("still skips the same scope when there is no checkpoint to be short of", async () => {
    // The negative control, and the reason the clause is the verdict and not a fourth conjunct:
    // the only thing that changed between the two passes is whether a checkpoint exists, and an
    // idle tenant must not accrue an hourly verdict about nothing.
    const proof = await proveScopeIntegrity(TENANT_A, depsFor(null));
    expect(proof.verdict).toBe("verified");
    const { result, callbacks } = await passOver(depsFor(null));
    expect(result).toEqual({ scope: TENANT_A, outcome: "skipped_empty" });
    expect(callbacks).toEqual([0, 0, 0, 0]);
  });

  it("cannot be reached by `unproven`, because the row that makes it unproven is a row", async () => {
    // Asked rather than assumed. `unanchored > 0` needs a result in `anchors.results`, and
    // `checked` **is** `results.length`, so the `noAuditRows` conjunct already excluded this
    // verdict before the clause existed — measured here through the real `verifyAuditAnchors` by
    // way of `proveScopeIntegrity`, with one row carrying no anchor.
    const unanchored = {
      ...(depsFor(null) as unknown as Record<string, unknown>),
      audit: {
        listAnchoredForScope: async () => ({
          rows: [{ entry: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, anchor: null }],
          unreadable: [],
        }),
      },
    } as unknown as Parameters<typeof proveScopeIntegrity>[1];
    const proof = await proveScopeIntegrity(TENANT_A, unanchored);
    expect(proof.verdict).toBe("unproven");
    expect(proof.anchors).toMatchObject({ checked: 1, unanchored: 1 });
    expect((await passOver(unanchored)).result?.outcome).toBe("proved");
  });

  it("does not skip a report carrying a verdict its own content does not explain", async () => {
    // The clause's general statement, which the three cases above cannot make: `verdict` is a
    // field on the report and `prove` is a seam, so a pass is handed whatever that seam returns.
    // Neither of these is producible by `proveScopeIntegrity` — the point is that neither is
    // skipped, because `skipped_empty` claims nothing was found and both verdicts say otherwise.
    const emptyShape = {
      anchors: anchors({ checked: 0, verified: 0 }),
      truncation: noTruncation({ checkpointSequence: null, tailSequence: null }),
    };
    const outcomes: (string | undefined)[] = [];
    for (const verdict of ["compromised", "unproven"] as const) {
      const s = new IntegrityProofScheduler({
      onPassSkipped: () => {},
        prove: async () => report({ ...emptyShape, verdict }),
        scopes: () => [TENANT_A],
        intervalMs: 1000,
      });
      outcomes.push((await s.runOnce())[0]?.outcome);
    }
    // Collected and asserted once, so a regression names both rather than aborting on the first —
    // which matters here because the two arms differ in nothing but the verdict, and a predicate
    // that stopped reading it would fail them identically.
    expect(outcomes).toEqual(["proved", "proved"]);
  });
});

/**
 * `proveScopeIntegrity` over the platform scope (ADR-0331).
 *
 * This used to skip the anchor half for `scope === null` because `audit_log.tenant_id` was NOT NULL
 * and there was nothing to check. There is now: three escalators write platform rows, and the
 * anchor check is the only detector for one that has been edited.
 *
 * The stores are structural stand-ins — the project's rule for Postgres-backed modules is to assert
 * on what was asked for, not to boot a database.
 */
describe("proveScopeIntegrity — the platform scope is anchored too", () => {
  const PLATFORM_ROW = "44444444-4444-4444-8444-444444444444";

  /**
   * The chain half is left deliberately unverifiable here — resolving a real Ed25519 fingerprint is
   * the chain check's own test — so these assertions are about the *anchor* half only: that it runs
   * at all for a null scope, which is the thing that used to be skipped.
   */
  function depsFor(over: { readonly tamper?: boolean } = {}): {
    readonly asked: (string | null)[];
    readonly deps: Parameters<typeof proveScopeIntegrity>[1];
  } {
    const asked: (string | null)[] = [];
    const entry = {
      id: PLATFORM_ROW,
      tenantId: null,
      occurredAt: AT,
      actor: { kind: "system", userId: null, sessionId: null, ip: null, userAgent: null },
      operation: "platform.page_undelivered",
      entity: "incident",
      entityId: "INC-2026-0007",
      before: null,
      after: { delivered: 0 },
      diff: null,
    } as unknown as AuditLogEntry;
    const payload = canonicalAuditEntryPayload(entry);
    const chainEntry = {
      sequenceNumber: 0,
      kind: "audit_event",
      recordedAt: AT,
      actorReference: "system",
      payloadSha256: over.tamper === true ? "0".repeat(64) : sha256(payload),
      payloadSizeBytes: Buffer.byteLength(payload, "utf8"),
      priorEntryHash: "0".repeat(64),
      entryHash: "e".repeat(64),
      signingKeyFingerprint: "f".repeat(64),
      signature: "sig",
    } as unknown as ChainedLogEntry;
    return {
      asked,
      deps: {
        logStore: {
          loadChain: async (scope: string | null) => {
            asked.push(scope);
            return { entries: [chainEntry], unreadable: [] };
          },
          tail: async () => ({ sequenceNumber: 0 }),
          verify: async () => ({ valid: true, brokenAt: null }),
        },
        checkpoints: fakeCheckpoints({}),
        registry: { getByFingerprint: async () => null },
        audit: {
          listAnchoredForScope: async (scope: string | null) => {
            asked.push(`audit:${String(scope)}`);
            return {
              rows: [{ entry, anchor: { sequenceNumber: 0, entryHash: "e".repeat(64) } }],
              unreadable: [],
            };
          },
        },
        auditRowLimit: 10,
        fromCheckpoint: false,
        now: () => new Date(AT),
      } as unknown as Parameters<typeof proveScopeIntegrity>[1],
    };
  }

  it("reads the audit rows for the platform scope rather than skipping them", async () => {
    const d = depsFor();
    const report = await proveScopeIntegrity(null, d.deps);
    expect(d.asked).toContain("audit:null");
    expect(report.anchors).not.toBeNull();
    expect(report.anchors?.checked).toBe(1);
  });

  it("carries the null scope through to the anchor report", async () => {
    const report = await proveScopeIntegrity(null, depsFor().deps);
    expect(report.anchors?.tenantId).toBeNull();
  });

  it("verifies an intact platform row's anchor", async () => {
    const report = await proveScopeIntegrity(null, depsFor().deps);
    expect(report.anchors?.verified).toBe(1);
    expect(report.anchors?.tampered).toEqual([]);
  });

  it("reports a tampered platform row as compromised", async () => {
    const report = await proveScopeIntegrity(null, depsFor({ tamper: true }).deps);
    expect(report.anchors?.tampered.map((t) => t.verdict)).toEqual(["hash_mismatch"]);
    expect(report.verdict).toBe("compromised");
  });

  it("names the platform row in the finding, so the escalation can say which proof broke", async () => {
    const report = await proveScopeIntegrity(null, depsFor({ tamper: true }).deps);
    expect(report.anchors?.tampered[0]?.auditId).toBe(PLATFORM_ROW);
  });

  it("still reads a tenant scope the same way", async () => {
    const d = depsFor();
    await proveScopeIntegrity(TENANT_A, d.deps);
    expect(d.asked).toContain(`audit:${TENANT_A}`);
  });
});

/**
 * `verifyChainFull` / `verifyChainFromCheckpoint` over a read carrying a refused row.
 *
 * These live here rather than in `chain-verify.test.ts` because the consequence they are about is
 * this file's: the hourly proof used to lose the pass to a throw out of `loadChain`, and the last
 * test in the block is that pass filing a verdict instead.
 */
describe("a chain row the contract refuses", () => {
  const keypair = generateEd25519Keypair();
  const FINGERPRINT = ed25519PublicKeyFingerprint(keypair.publicKeyBase64);
  const REFUSED: UnreadableRow = { identity: "1", detail: "kind: invalid_enum_value" };

  /** Genuinely signed and linked, so each half's `valid` is that half's own answer. */
  async function signedChain(count: number): Promise<readonly ChainedLogEntry[]> {
    const out: ChainedLogEntry[] = [];
    let prior = GENESIS_HASH;
    for (let n = 0; n < count; n += 1) {
      const sealed = await buildChainEntry({
        sequenceNumber: n,
        priorEntryHash: prior,
        entry: {
          kind: "audit_event",
          recordedAt: AT,
          actorReference: "gateway",
          payloadBytes: `event-${n.toString()}`,
        },
        signingKeyFingerprint: FINGERPRINT,
        sign: async (bytes) =>
          signEd25519(keypair.privateKeyBase64, keypair.publicKeyBase64, bytes),
      });
      prior = sealed.entry.entryHash;
      out.push(sealed.entry);
    }
    return out;
  }

  function reader(read: ChainRead): Parameters<typeof verifyChainFull>[0] {
    return {
      loadChain: async () => read,
      loadFrom: async () => read,
    } as unknown as Parameters<typeof verifyChainFull>[0];
  }

  const registry = {
    getByFingerprint: async (fp: string) =>
      fp === FINGERPRINT ? { publicKeyBase64: keypair.publicKeyBase64 } : null,
  } as unknown as Parameters<typeof verifyChainFull>[1];

  function checkpoints(checkpoint: ChainCheckpoint): Parameters<typeof verifyChainFromCheckpoint>[2] {
    return { latest: async () => checkpoint } as unknown as Parameters<
      typeof verifyChainFromCheckpoint
    >[2];
  }

  it("fails the verification instead of throwing out of the load", async () => {
    const entries = await signedChain(3);
    const report = await verifyChainFull(
      reader({ entries: [entries[0]!, entries[2]!], unreadable: [REFUSED] }),
      registry,
      TENANT_A,
    );
    expect(report.ok).toBe(false);
    expect(report.integrity.valid).toBe(false);
    expect(report.signatures.valid).toBe(false);
  });

  it("names the row that is there, not the sequence gap the shortened array shows", async () => {
    const entries = await signedChain(3);
    const held = [entries[0]!, entries[2]!];
    // What the fold alone says about this array — true of it, false of the table it came from.
    expect(verifyChainIntegrity(held).reason).toBe("sequence gap");

    const report = await verifyChainFull(reader({ entries: held, unreadable: [REFUSED] }), registry, TENANT_A);
    expect(report.integrity.brokenAt).toBe(1);
    expect(report.integrity.reason).toBe(
      "1 entry the contract refuses (first: kind: invalid_enum_value)",
    );
    expect(report.integrity.reason).not.toContain("sequence gap");
  });

  it("outranks a fold and signatures that would both have passed", async () => {
    const entries = await signedChain(2);
    expect(verifyChainIntegrity(entries).valid).toBe(true);

    const report = await verifyChainFull(
      reader({ entries, unreadable: [{ identity: "7", detail: "<root>: custom" }] }),
      registry,
      TENANT_A,
    );
    expect(report.integrity.valid).toBe(false);
    expect(report.integrity.brokenAt).toBe(7);
    // Every signature it examined verified, so this `false` is the refused row's answer too.
    expect(report.signatures.results.map((r) => r.ok)).toEqual([true, true]);
    expect(report.signatures.valid).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("counts the entries it examined and not the rows on disk", async () => {
    const entries = await signedChain(2);
    const report = await verifyChainFull(reader({ entries, unreadable: [REFUSED] }), registry, TENANT_A);
    expect(report.signatures.checked).toBe(2);
    expect(report.signatures.unreadable).toEqual([REFUSED]);
  });

  it("reports no position when the refused row does not name one", async () => {
    const entries = await signedChain(1);
    const report = await verifyChainFull(
      reader({ entries, unreadable: [{ identity: null, detail: "sequence_number: invalid_type" }] }),
      registry,
      TENANT_A,
    );
    expect(report.integrity.brokenAt).toBeNull();
    expect(report.integrity.valid).toBe(false);
  });

  it("fails the bounded suffix on the same terms as the full fold", async () => {
    const entries = await signedChain(3);
    const anchor: ChainCheckpoint = {
      sequenceNumber: 0,
      rootHash: entries[0]!.entryHash,
      checkpointedAt: AT,
      checkpointedBy: "auditor",
      algorithm: "sha256",
      provenance: "verified_full",
    };
    const suffix = [entries[1]!, entries[2]!];
    expect(
      verifyChainSuffix(suffix, { fromSequence: 1, priorRootHash: anchor.rootHash }).valid,
    ).toBe(true);

    const report = await verifyChainFromCheckpoint(
      reader({ entries: suffix, unreadable: [{ identity: "3", detail: "signature: too_small" }] }),
      registry,
      checkpoints(anchor),
      TENANT_A,
    );
    expect(report.mode).toBe("from_checkpoint");
    expect(report.ok).toBe(false);
    expect(report.integrity.valid).toBe(false);
    expect(report.integrity.brokenAt).toBe(3);
    expect(report.signatures.valid).toBe(false);
    expect(report.signatures.checked).toBe(2);
  });

  it("the hourly proof files compromised rather than losing the pass", async () => {
    const entries = await signedChain(2);
    const read: ChainRead = { entries, unreadable: [REFUSED] };
    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: {
        loadChain: async () => read,
        tail: async () => ({ sequenceNumber: 1, entryHash: entries[1]!.entryHash }),
      },
      checkpoints: fakeCheckpoints({}),
      registry,
      audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
      auditRowLimit: 10,
      fromCheckpoint: false,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    expect(proof.chain.ok).toBe(false);
    expect(proof.verdict).toBe("compromised");
    expect(formatIntegrityProof(proof)).toContain("COMPROMISED");
  });

  // The default mode, and the one where the chain half cannot see the row at all: it reads
  // `loadFrom(anchor + 1)`, so a refusal below the anchor is absent from its `unreadable` while the
  // whole-chain read the anchor half performs two statements later has it. The first draft of this
  // increment discarded that list on a comment claiming the chain half already carried it.
  it("files compromised for a refused row below the anchor, which the bounded chain half never reads", async () => {
    const entries = await signedChain(5);
    const anchor: ChainCheckpoint = {
      sequenceNumber: 3,
      rootHash: entries[3]!.entryHash,
      checkpointedAt: AT,
      checkpointedBy: "auditor",
      algorithm: "sha256",
      provenance: "verified_full",
    };
    const belowAnchor: UnreadableRow = { identity: "2", detail: "kind: invalid_enum_value" };
    const suffix: ChainRead = { entries: [entries[4]!], unreadable: [] };
    const whole: ChainRead = {
      entries: [entries[0]!, entries[1]!, entries[3]!, entries[4]!],
      unreadable: [belowAnchor],
    };
    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: {
        loadChain: async () => whole,
        loadFrom: async () => suffix,
        tail: async () => ({ sequenceNumber: 4, entryHash: entries[4]!.entryHash }),
      },
      checkpoints: fakeCheckpoints({ records: [anchor] }),
      registry,
      audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
      auditRowLimit: 10,
      fromCheckpoint: true,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    // The bounded half is clean, and honestly so — it verified what it read.
    expect(proof.chain.mode).toBe("from_checkpoint");
    expect(proof.chain.ok).toBe(true);
    expect(proof.chain.signatures.unreadable).toEqual([]);
    // And the anchor half's read is where the row is, so that is where the verdict comes from.
    expect(proof.chainRowsRefused).toEqual([belowAnchor]);
    expect(proof.verdict).toBe("compromised");
    expect(formatIntegrityProof(proof)).toContain("unreadable chain entry 2 (kind: invalid_enum_value)");
  });

  // The anchor itself, on **both** modes. `proveScopeIntegrity` no longer reads `latest()` at all —
  // the audit's scan replaced it — but the bounded chain half still does, so the fixture answers
  // both from one row set and a mode that folds from genesis is still a mode whose anchor the audit
  // reports.
  const refusedAnchorRow: UnreadableRow = {
    identity: "3",
    detail: "checkpointedBy: too_small",
  };
  const refusingCheckpoints = fakeCheckpoints({ unreadable: [refusedAnchorRow] });

  it("files compromised for a refused anchor on a full fold, where the chain half never reads it", async () => {
    const entries = await signedChain(2);
    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: {
        loadChain: async () => ({ entries, unreadable: [] }),
        tail: async () => ({ sequenceNumber: 1, entryHash: entries[1]!.entryHash }),
      },
      checkpoints: refusingCheckpoints,
      registry,
      audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
      auditRowLimit: 10,
      fromCheckpoint: false,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    // The chain is genuinely fine, which is the shape of the defect: before this the whole pass
    // threw and the scheduler filed `outcome: "error"` — no verdict row, no finding, no page.
    expect(proof.chain.ok).toBe(true);
    expect(proof.anchorAudit.refused).toEqual([refusedAnchorRow]);
    expect(proof.anchorAudit.refusedCount).toBe(1);
    expect(proof.verdict).toBe("compromised");
    // Unanswerable rather than negative: no anchor the audit will stand behind, so `truncated` must
    // not read as a cleared check.
    expect(proof.truncation.checkpointSequence).toBeNull();
    expect(proof.truncation.truncated).toBe(false);
    const text = formatIntegrityProof(proof);
    expect(text).toContain("checkpoint 3 (checkpointedBy: too_small)");
    expect(text).not.toContain("run the checkpoint scheduler");
  });

  it("folds from genesis and still files compromised when a bounded pass refuses its anchor", async () => {
    const entries = await signedChain(3);
    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: {
        loadChain: async () => ({ entries, unreadable: [] }),
        loadFrom: async () => {
          throw new Error("a bounded read must not happen when the anchor was refused");
        },
        tail: async () => ({ sequenceNumber: 2, entryHash: entries[2]!.entryHash }),
      },
      checkpoints: refusingCheckpoints,
      registry,
      audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
      auditRowLimit: 10,
      fromCheckpoint: true,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    // The verification is correct — an anchor that cannot be trusted is not an anchor — and on its
    // own it reads as a healthy full pass, which is exactly why the fold is not sufficient.
    expect(proof.chain.mode).toBe("full");
    expect(proof.chain.fullBecause).toBe("anchor_unreadable");
    expect(proof.chain.ok).toBe(true);
    expect(proof.anchorAudit.refused).toEqual([refusedAnchorRow]);
    expect(proof.verdict).toBe("compromised");
  });

  it("propagates a failure of the anchor scan rather than calling it a finding", async () => {
    // Nothing is caught here. `scanCheckpoints` answering a refused row is the finding; a scan that
    // *throws* is a read that did not happen, and a verdict claiming otherwise would assert a
    // verification over a scope whose anchor state is unknown — which is what `complete: false`
    // reports for the one failure mode that is bounded rather than unknown.
    const entries = await signedChain(2);
    await expect(
      proveScopeIntegrity(TENANT_A, {
        logStore: {
          loadChain: async () => ({ entries, unreadable: [] }),
          tail: async () => ({ sequenceNumber: 1, entryHash: entries[1]!.entryHash }),
        },
        checkpoints: fakeCheckpoints({
          scanThrows: new Error("connection terminated unexpectedly"),
        }),
        registry,
        audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
        auditRowLimit: 10,
        fromCheckpoint: false,
        now: () => new Date(AT),
      } as unknown as Parameters<typeof proveScopeIntegrity>[1]),
    ).rejects.toThrow("connection terminated unexpectedly");
  });

  it("prints the integrity reason, so a refused entry does not read as a broken hash link", async () => {
    const entries = await signedChain(3);
    const report = await verifyChainFull(
      reader({ entries: [entries[0]!, entries[2]!], unreadable: [REFUSED] }),
      registry,
      TENANT_A,
    );
    const line = formatIntegrityProof({
      scope: TENANT_A,
      verdict: "compromised",
      verifiedAt: AT,
      chain: report,
      anchors: null,
      truncation: noTruncation(),
      chainRowsRefused: [],
      anchorAudit: anchorAudit(),
      witnessMemory: noWitnessMemory(),
    });
    expect(line).toContain("1 entry the contract refuses");
    expect(line).not.toMatch(/integrity BROKEN at 1,/);
  });
});

/**
 * The truncation witness, which is the audit's now and used to be `latest()`'s.
 *
 * Driven through the real `proveScopeIntegrity` over a genuinely signed chain, because the point of
 * every case here is which *cause* a report names: with an unsigned chain every one of them would
 * read `compromised` off `chain_broken_or_unsigned` and the assertions would hold while saying
 * nothing. The chain is clean in all four, so each verdict is the anchor table's answer alone.
 *
 * Every write these cases model is one `UPDATE` of `sequence_number`, whose only CHECK is `>= 0`,
 * issued under the tenant's own context by the non-owner `serving` role — that table's isolation arm
 * is `ALL`-scope so its `USING` doubles as its `WITH CHECK` (ADR-0374). The pre-fix answers quoted
 * per case were measured that way on PG 16.13.
 */
describe("proveScopeIntegrity — the witness is an anchor the chain does not contradict", () => {
  const keypair = generateEd25519Keypair();
  const FINGERPRINT = ed25519PublicKeyFingerprint(keypair.publicKeyBase64);
  const registry = {
    getByFingerprint: async (fp: string) =>
      fp === FINGERPRINT ? { publicKeyBase64: keypair.publicKeyBase64 } : null,
  } as unknown as Parameters<typeof proveScopeIntegrity>[1]["registry"];

  async function signedChain(count: number): Promise<readonly ChainedLogEntry[]> {
    const out: ChainedLogEntry[] = [];
    let prior = GENESIS_HASH;
    for (let n = 0; n < count; n += 1) {
      const sealed = await buildChainEntry({
        sequenceNumber: n,
        priorEntryHash: prior,
        entry: {
          kind: "audit_event",
          recordedAt: AT,
          actorReference: "gateway",
          payloadBytes: `event-${n.toString()}`,
        },
        signingKeyFingerprint: FINGERPRINT,
        sign: async (bytes) => signEd25519(keypair.privateKeyBase64, keypair.publicKeyBase64, bytes),
      });
      prior = sealed.entry.entryHash;
      out.push(sealed.entry);
    }
    return out;
  }

  /** The chain as the table holds it, and the anchors as the table holds them. */
  const proveOver = async (
    entries: readonly ChainedLogEntry[],
    anchorRows: readonly ChainCheckpoint[],
  ): Promise<IntegrityProofReport> =>
    proveScopeIntegrity(TENANT_A, {
      logStore: {
        loadChain: async () => ({ entries, unreadable: [] }),
        tail: async () =>
          entries.length === 0
            ? null
            : {
                sequenceNumber: entries[entries.length - 1]!.sequenceNumber,
                entryHash: entries[entries.length - 1]!.entryHash,
              },
      },
      checkpoints: fakeCheckpoints({ records: anchorRows }),
      registry,
      audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
      auditRowLimit: 10,
      // A full fold, so the bounded half's own `latest()` plays no part and the only read of the
      // anchor table in the pass is the audit's.
      fromCheckpoint: false,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

  it("stands behind an anchor that agrees with the chain", async () => {
    const entries = await signedChain(5);
    const proof = await proveOver(entries, [
      checkpointAt(1, entries[1]!.entryHash),
      checkpointAt(4, entries[4]!.entryHash),
    ]);
    expect(proof.anchorAudit.disagreeing).toEqual([]);
    expect(proof.truncation).toMatchObject({ checkpointSequence: 4, tailSequence: 4, truncated: false });
    expect(proof.verdict).toBe("verified");
  });

  it("excludes a relocated anchor from the witness, so a raised sequence is no longer a truncation", async () => {
    // Measured pre-fix on exactly this shape: `UPDATE … SET sequence_number = 99` answered
    // `verdict=compromised truncated=true witness=99 causes=[chain_truncated]`, with the formatter
    // printing "TRUNCATED: checkpoint at 99 but the chain ends at 4" while **every entry was
    // present** — a paging sev1 naming the wrong table. The anchor's root hash is still entry 4's,
    // which is what makes this `sequence_relocated` rather than a mismatch.
    const entries = await signedChain(5);
    const proof = await proveOver(entries, [checkpointAt(99, entries[4]!.entryHash)]);

    expect(proof.anchorAudit.disagreeing).toEqual([
      { kind: "sequence_relocated", sequenceNumber: 99, matchedAt: 4 },
    ]);
    expect(proof.anchorAudit.witnessSequence).toBeNull();
    expect(proof.truncation.truncated).toBe(false);
    expect(compromiseCauses(proof)).toEqual(["checkpoint_disagrees_with_chain"]);
    expect(proof.verdict).toBe("compromised");
    const text = formatIntegrityProof(proof);
    expect(text).not.toContain("TRUNCATED");
    expect(text).toContain("anchor at 99: sequence_relocated");
  });

  it("keeps an anchor the chain does not reach, so a genuine truncation is still named", async () => {
    // The counter-case, and the reason `disagreementFor` answers `null` for an anchor the chain
    // neither holds nor carries the hash of: that is what truncation looks like from here, and
    // excluding it would disarm the check the witness exists to feed. The anchor is sound — it was
    // written when entries 3 and 4 were still there.
    const entries = await signedChain(5);
    const anchor = checkpointAt(4, entries[4]!.entryHash);
    const cut = entries.slice(0, 3);

    const proof = await proveOver(cut, [anchor]);
    expect(proof.anchorAudit.disagreeing).toEqual([]);
    expect(proof.truncation).toMatchObject({ checkpointSequence: 4, tailSequence: 2, truncated: true });
    expect(compromiseCauses(proof)).toEqual(["chain_truncated"]);
    expect(formatIntegrityProof(proof)).toContain("TRUNCATED: checkpoint at 4");
  });

  it("names the edited witness once the truncation it hid is unprovable", async () => {
    // The sharpest pre-fix case (ADR-0375's Face 2b): a genuine truncation, then the anchors lowered
    // to match the shortened chain, read `verdict=verified truncated=false witness=2` with the
    // formatter printing "integrity valid, signatures valid (3 checked)" over two destroyed entries.
    //
    // What the fix recovers is **the evidence that the witness was altered**, not the truncation:
    // once the anchor's sequence is moved, no anchor says where the chain used to end, so
    // `truncated` is honestly false and `checkpoint_disagrees_with_chain` is the finding. The
    // exclusion can never cost a verdict, because excluding an anchor and naming it are the same
    // event — a disagreement is itself a cause.
    const entries = await signedChain(5);
    const cut = entries.slice(0, 3);
    const lowered = checkpointAt(2, entries[4]!.entryHash);

    const proof = await proveOver(cut, [lowered]);
    expect(proof.anchorAudit.disagreeing).toEqual([
      { kind: "root_hash_mismatch", sequenceNumber: 2, matchedAt: null },
    ]);
    expect(proof.truncation.truncated).toBe(false);
    expect(compromiseCauses(proof)).toEqual(["checkpoint_disagrees_with_chain"]);
    expect(proof.verdict).toBe("compromised");
  });

  it("withholds the correspondence over a chain whose reader refused a row, and says so", async () => {
    // `null` and not `[]`, and the fixture is the shape the argument is about rather than any
    // chain with a refused row: entry 2 is refused and the anchor sits at sequence **1** carrying
    // entry 2's hash, so over the whole chain this is a plain `sequence_relocated` whose
    // `matchedAt` is 2. Over the entries that parsed, `sequenceOfHash` has lost that hash while
    // `hashAt` still holds 1 — so the comparison would answer `root_hash_mismatch` with no
    // `matchedAt`: the weaker finding, pointing at a hash comparison rather than at a sequence to
    // put back, and attributing to the anchor table a fact caused by the chain table. It would
    // also strike the anchor off the witness. `chain_row_refused` already answers `compromised`,
    // so withholding the comparison costs no verdict — only a sentence that would be false.
    const entries = await signedChain(3);
    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: {
        loadChain: async () => ({
          entries: [entries[0]!, entries[1]!],
          unreadable: [{ identity: "2", detail: "kind: invalid_enum_value" }],
        }),
        tail: async () => ({ sequenceNumber: 2, entryHash: entries[2]!.entryHash }),
      },
      checkpoints: fakeCheckpoints({ records: [checkpointAt(1, entries[2]!.entryHash)] }),
      registry,
      audit: { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) },
      auditRowLimit: 10,
      fromCheckpoint: false,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    expect(proof.anchorAudit.disagreeing).toBeNull();
    expect(compromiseCauses(proof)).toContain("chain_row_refused");
    expect(compromiseCauses(proof)).not.toContain("checkpoint_disagrees_with_chain");
    // Withholding the comparison withholds the exclusion too, which is the safe direction here: it
    // can only ever add a truncation finding to a report that is already `compromised`.
    expect(proof.anchorAudit.witnessSequence).toBe(1);
  });
});

describe("DEFAULT_INTEGRITY_PROOF_CONFIG", () => {
  it("is the schema's own defaults plus allTenants, and nothing else", () => {
    // `DEFAULT_CHECKPOINT_CONFIG`'s fence, in the sibling module, so neither literal can grow a
    // second departure without a failure here.
    const empty = IntegrityProofConfigSchema.parse({});
    const differing = (
      Object.keys(DEFAULT_INTEGRITY_PROOF_CONFIG) as (keyof IntegrityProofConfig)[]
    ).filter(
      (k) =>
        JSON.stringify(DEFAULT_INTEGRITY_PROOF_CONFIG[k]) !== JSON.stringify(empty[k]),
    );
    expect(differing).toEqual(["allTenants"]);
    expect(DEFAULT_INTEGRITY_PROOF_CONFIG.allTenants).toBe(true);
    expect(Object.keys(DEFAULT_INTEGRITY_PROOF_CONFIG).sort()).toEqual(Object.keys(empty).sort());
  });

  it("declares no escalation, so a page is the deployment's own decision", () => {
    // Mounting an escalation by default would declare an incident and page an on-call rotation
    // from a flag that reads as "turn the proof on" — and `alertPolicy` is required inside it, so
    // there is no honest literal to supply anyway.
    expect(DEFAULT_INTEGRITY_PROOF_CONFIG.escalation).toBeUndefined();
  });

  it("leaves tenantStatuses to chainScopeStatuses rather than restating it", () => {
    expect(DEFAULT_INTEGRITY_PROOF_CONFIG.tenantStatuses).toBeUndefined();
  });

  it("the empty config it replaces resolves to the platform chain alone", () => {
    expect(integrityConfigScopes(IntegrityProofConfigSchema.parse({}))).toEqual([null]);
  });
});

describe("IntegrityProofScheduler — the overlap guard", () => {
  /*
   * The guard the sibling scheduler had and this one did not, and ADR-0406 made its absence live:
   * `--integrity-proof` defaulted on, the scope set widened to all five tenant statuses, and
   * `proveScopeIntegrity`'s `loadChain` unconditional — so one pass holds one scope's whole chain
   * and k overlapping passes hold k of them. The failure is the detector going down, not a wrong
   * verdict.
   *
   * Every assertion here is about the pair (no second pass, AND the skip reported), because a guard
   * that is silent is a falsely-true boot line: "the hourly proof is running" would be true of the
   * timer and false of the verification.
   */
  const slowScheduler = () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const proved: (string | null)[] = [];
    const skips: string[] = [];
    const s = new IntegrityProofScheduler({
      onPassSkipped: (reason) => skips.push(reason),
      prove: async (scope) => {
        proved.push(scope);
        await gate;
        return report();
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      runOnStart: false,
    });
    return { s, proved, skips, release: () => release?.() };
  };

  it("performs no second pass while one is in flight, and says so", async () => {
    const { s, proved, skips, release } = slowScheduler();
    const first = s.runOnce();
    // Second tick lands mid-fold. It must not start a pass, and it must not be silent.
    const second = await s.runOnce();
    expect(second).toEqual([]);
    expect(proved).toHaveLength(1);
    expect(skips).toEqual(["pass_already_in_flight"]);
    release();
    const firstResults = await first;
    // The non-vacuity control: the guard skipped a pass rather than killing the scheduler, so the
    // first pass still completed and still produced its verdict. Without this the test passes just
    // as well against a `runOnce` that returns `[]` unconditionally.
    expect(firstResults).toHaveLength(1);
    expect(firstResults[0]).toMatchObject({ outcome: "proved" });
  });

  it("clears the guard after a pass that throws, so one failure is not permanent", async () => {
    const skips: string[] = [];
    let proveCalls = 0;
    /*
     * A throwing `onError` is the one failure that escapes `pass`, measured over five arms against
     * the built scheduler rather than reasoned: `scopes()`, `prove()` and `onPass()` throws are all
     * caught and routed to `onError`, and only `onError`'s own throw gets past the catch it is
     * called from. An earlier draft of this test named `scopes` and fenced nothing, because `pass`
     * returns normally on that arm — so the reset-outside-the-`finally` mutation survived.
     *
     * `onError` throws unconditionally, which is what a broken reporter looks like; `prove` fails
     * only the first time, so the second pass has something real to produce. With the reset outside
     * the `finally` the first throw leaves `inFlight` set and every later pass reports
     * `pass_already_in_flight` — permanently, for the life of the process, from one reporter
     * failure. That is the leak this asserts against, confirmed by applying the mutation and
     * watching exactly these two arms start leaking.
     */
    const s = new IntegrityProofScheduler({
      onPassSkipped: (reason) => skips.push(reason),
      prove: async (scope) => {
        proveCalls += 1;
        if (proveCalls === 1) throw new Error("fold failed");
        return report({ scope });
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      runOnStart: false,
      onError: () => {
        throw new Error("reporter down");
      },
    });
    await expect(s.runOnce()).rejects.toThrow("reporter down");
    const second = await s.runOnce();
    // Both halves, because either alone passes against the defect: `skips` empty says the guard was
    // released, and the length says the released guard let a real pass through.
    expect(skips).toEqual([]);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ outcome: "proved" });
    expect(proveCalls).toBe(2);
  });

  it("reports every skipped tick rather than deduplicating", async () => {
    // For a scope whose fold never fits the interval this is the only line that ever appears
    // again, so one-shot reporting would make a permanently dead detector a quiet one.
    const { s, skips, release } = slowScheduler();
    const first = s.runOnce();
    await s.runOnce();
    await s.runOnce();
    await s.runOnce();
    expect(skips).toHaveLength(3);
    release();
    await first;
  });

  it("names its skip reasons as an enum with no unreachable member", () => {
    expect(INTEGRITY_PASS_SKIP_REASONS).toEqual(["pass_already_in_flight"]);
  });
});

/**
 * The read order inside `proveScopeIntegrity`, modelled as the race it is about rather than pinned
 * as text.
 *
 * Each fake performs a concurrent **honest** write at the exact moment between the two reads whose
 * values are then compared: the claim-producing read appends the entry its claim names to the array
 * the next `loadChain` returns. So the entry is present iff the chain is read afterwards — which is
 * the whole of what the ordering decides — and a reordered read fails these by manufacturing a
 * finding rather than by throwing, which is how the defect presented.
 *
 * There are **four** such comparisons, not three, and three tests is the right number for a reason
 * the first draft of this comment did not give. The fourth pair — a prior verdict's attested witness
 * against the anchor scan, which `compareWitnessMemory` makes twice and which the pre-fix order was
 * measured forging `witness_regressed` on — is satisfied **structurally**: `auditAnchors` takes
 * `correspondenceChain`, derived from `chainRead`, so the scan cannot be hoisted above the chain
 * read without a compile error, and therefore any order satisfying test 1 satisfies it too. The
 * compiler is its fence. (A fifth, an anchor against the chain, is order-free by design.)
 */
describe("proveScopeIntegrity reads the larger side of each comparison second", () => {
  const keypair = generateEd25519Keypair();
  const FP = ed25519PublicKeyFingerprint(keypair.publicKeyBase64);

  /** Appends one genuinely signed, linked entry, so `chain.ok` is the chain's own answer. */
  async function append(into: ChainedLogEntry[], payload: string): Promise<ChainedLogEntry> {
    const prior = into.length === 0 ? GENESIS_HASH : into[into.length - 1]!.entryHash;
    const sealed = await buildChainEntry({
      sequenceNumber: into.length,
      priorEntryHash: prior,
      entry: {
        kind: "audit_event",
        recordedAt: AT,
        actorReference: "gateway",
        payloadBytes: payload,
      },
      signingKeyFingerprint: FP,
      sign: async (bytes) => signEd25519(keypair.privateKeyBase64, keypair.publicKeyBase64, bytes),
    });
    into.push(sealed.entry);
    return sealed.entry;
  }

  async function chainOf(count: number): Promise<ChainedLogEntry[]> {
    const out: ChainedLogEntry[] = [];
    for (let n = 0; n < count; n += 1) await append(out, `event-${n.toString()}`);
    return out;
  }

  const registry = {
    getByFingerprint: async (fp: string) =>
      fp === FP ? { publicKeyBase64: keypair.publicKeyBase64 } : null,
  } as unknown as Parameters<typeof proveScopeIntegrity>[1]["registry"];

  /** A live array, so every read reflects whatever has been appended by then. */
  function logStore(entries: ChainedLogEntry[]): Record<string, unknown> {
    return {
      loadChain: async () => ({ entries: [...entries], unreadable: [] }),
      tail: async () => {
        const last = entries[entries.length - 1];
        return last === undefined
          ? null
          : { sequenceNumber: last.sequenceNumber, entryHash: last.entryHash };
      },
    };
  }

  const noAudit = { listAnchoredForScope: async () => ({ rows: [], unreadable: [] }) };

  it("reads a prior verdict before the chain, so a concurrent pass's verdict cannot contradict it", async () => {
    // The race ADR-0406's addendum measured across two replicas at 19 of 240. The other replica's
    // verdict lands between this pass's two reads: `record()` appends the chain entry and only then
    // stores the row, so a baseline visible to this pass has its entry visible too — and that holds
    // only if the chain is read second.
    const entries = await chainOf(3);
    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: logStore(entries),
      checkpoints: fakeCheckpoints({}),
      registry,
      audit: noAudit,
      auditRowLimit: 500,
      fromCheckpoint: false,
      now: () => new Date(AT),
      witnessMemory: async () => {
        const landed = await append(entries, "the other replica's verdict");
        return {
          kind: "attested" as const,
          attested: {
            witnessSequence: null,
            tailSequence: 2,
            verifiedAt: AT,
            payloadSha256: landed.payloadSha256,
            chainEntryHash: landed.entryHash,
            chainSequenceNumber: landed.sequenceNumber,
          },
        };
      },
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    expect(proof.witnessMemory.outcome).toBe("consistent");
    expect(proof.verdict).toBe("verified");
  });

  it("reads the audit rows before the chain, so a row written mid-pass is not a tampered row", async () => {
    // Measured on ONE replica at 90 of 140. `emit` appends the chain entry and inserts the row in
    // one transaction, so a visible row implies a visible entry; read the rows second and the row's
    // anchor sequence is simply above the snapshot, which `verdictFor` calls `anchor_missing` — a
    // `TAMPERED` verdict, so `audit_row_tampered`, so `compromised`.
    const entries = await chainOf(3);
    const row: AuditLogEntry = {
      id: "aud-mid-pass",
      tenantId: TENANT_A,
      occurredAt: AT,
      actor: { kind: "user", userId: "u1", apiKeyId: null, sessionId: null, systemId: null },
      operation: "audit.entries.list",
      entity: "audit_log",
      entityId: null,
      before: null,
      after: null,
      diff: null,
    } as unknown as AuditLogEntry;

    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: logStore(entries),
      checkpoints: fakeCheckpoints({}),
      registry,
      audit: {
        listAnchoredForScope: async () => {
          const landed = await append(entries, canonicalAuditEntryPayload(row));
          return {
            rows: [
              {
                entry: row,
                anchor: {
                  sequenceNumber: landed.sequenceNumber,
                  entryHash: landed.entryHash,
                },
              },
            ],
            unreadable: [],
          };
        },
      },
      auditRowLimit: 500,
      fromCheckpoint: false,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    expect(proof.anchors?.tampered).toEqual([]);
    expect(proof.anchors?.verified).toBe(1);
    expect(proof.verdict).toBe("verified");
  });

  it("reads the tail after the anchor scan, so an anchor newer than the chain snapshot is no truncation", async () => {
    // The comparison that was already right, pinned because the two fixes above move reads around
    // it and this one must not move with them. The window is a real pair of honest events: traffic
    // appends an entry and the checkpoint scheduler anchors it, so the anchor is visible to this
    // pass's anchor scan. An anchor the chain snapshot does not reach is deliberately NOT a
    // disagreement (it is this check's own subject), so it counts toward the witness — and
    // `truncated` is `tail < witness`, so a tail read one statement too early answers true on
    // honest appends alone. The concurrent event therefore has to land AT the anchor scan: a
    // fixture that appends before the call reads the same tail under either ordering and pins
    // nothing, which is how the first draft of this test passed under its own mutation.
    const entries = await chainOf(3); // sequences 0..2, so the concurrent append is 3
    const proof = await proveScopeIntegrity(TENANT_A, {
      logStore: logStore(entries),
      checkpoints: {
        latest: async () => null,
        scanCheckpoints: async (
          _scope: string | null,
          onPage: (page: RowRead<ChainCheckpoint>) => void,
        ): Promise<CheckpointScanOutcome> => {
          const landed = await append(entries, "appended and anchored during the pass");
          onPage({
            records: [checkpointAt(landed.sequenceNumber, landed.entryHash)],
            unreadable: [],
          });
          return { scanned: 1, refusedCount: 0, complete: true };
        },
      },
      registry,
      audit: noAudit,
      auditRowLimit: 500,
      fromCheckpoint: false,
      now: () => new Date(AT),
    } as unknown as Parameters<typeof proveScopeIntegrity>[1]);

    expect(entries).toHaveLength(4); // the side effect ran, so the window was exercised
    expect(proof.anchorAudit.witnessSequence).toBe(3);
    expect(proof.truncation.truncated).toBe(false);
    expect(compromiseCauses(proof as unknown as CompromiseEvidence)).not.toContain("chain_truncated");
    expect(proof.verdict).toBe("verified");
  });
});
