import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AuditAnchorReport, AuditAnchorResult } from "./audit-anchor.js";
import type { ChainVerificationReport } from "./chain-verify.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";
import {
  INTEGRITY_VERDICTS,
  IntegrityProofScheduler,
  formatIntegrityProof,
  integrityConfigScopes,
  integrityVerdictFor,
  integrityVerdictPayload,
  loadIntegrityProofConfig,
  parseIntegrityProofConfig,
  type ChainTruncationCheck,
  type IntegrityProofReport,
} from "./integrity-proof.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const AT = "2026-09-29T00:00:00.000Z";

function chainOk(over: Partial<ChainVerificationReport> = {}): ChainVerificationReport {
  return {
    tenantId: TENANT_A,
    ok: true,
    mode: "from_checkpoint",
    checkpointSequence: 3,
    integrity: { valid: true, brokenAt: null },
    signatures: { valid: true, checked: 4, results: [], unresolvedFingerprints: [] },
    ...over,
  } as ChainVerificationReport;
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

function report(over: Partial<IntegrityProofReport> = {}): IntegrityProofReport {
  return {
    scope: TENANT_A,
    verdict: "verified",
    verifiedAt: AT,
    chain: chainOk(),
    anchors: anchors(),
    truncation: noTruncation(),
    ...over,
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
      includePlatform: false,
      allTenants: false,
      tenants: [],
    });
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
  it("is the tenant list, with the platform chain only when opted in", () => {
    expect(integrityConfigScopes(parseIntegrityProofConfig({ tenants: [TENANT_A] }))).toEqual([
      TENANT_A,
    ]);
    expect(
      integrityConfigScopes(
        parseIntegrityProofConfig({ tenants: [TENANT_A], includePlatform: true }),
      ),
    ).toEqual([TENANT_A, null]);
  });
});

describe("IntegrityProofScheduler — verdicts", () => {
  const run = async (r: IntegrityProofReport) => {
    const recorded: IntegrityProofReport[] = [];
    const passes: IntegrityProofReport[] = [];
    const findings: IntegrityProofReport[] = [];
    const s = new IntegrityProofScheduler({
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
      chain: chainOk({ signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [] } }),
      anchors: anchors({ checked: 0, verified: 0 }),
      truncation: noTruncation({ checkpointSequence: null, tailSequence: null }),
    });
    const recorded: unknown[] = [];
    const s = new IntegrityProofScheduler({
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
      chain: chainOk({ signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [] } }),
      anchors: anchors({ ok: false, checked: 1, verified: 0, tampered: [tamperedResult] }),
      truncation: noTruncation({ checkpointSequence: null, tailSequence: null }),
    });
    const s = new IntegrityProofScheduler({
      prove: async () => r,
      scopes: () => [TENANT_A],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]?.outcome).toBe("proved");
  });

  it("isolates a per-scope failure and finishes the rest", async () => {
    const errors: unknown[] = [];
    const s = new IntegrityProofScheduler({
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
    const m = manualScheduler();
    const s = new IntegrityProofScheduler({
      prove: async () => {
        calls += 1;
        return report();
      },
      scopes: () => [TENANT_A],
      intervalMs: 1000,
      scheduler: m.scheduler,
    });
    s.start();
    await Promise.resolve();
    expect(calls).toBe(1);
    m.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it("can skip the immediate pass", async () => {
    let calls = 0;
    const m = manualScheduler();
    new IntegrityProofScheduler({
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
    expect(integrityVerdictFor(chainOk(), anchors(), noTruncation())).toBe("verified");
  });

  it("verified: the platform chain, which has no rows to anchor", () => {
    expect(integrityVerdictFor(chainOk(), null, noTruncation())).toBe("verified");
  });

  it("compromised: a row no longer matches its anchor", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors({ ok: false, tampered: [tamperedResult] }), noTruncation()),
    ).toBe("compromised");
  });

  it("unproven: nothing disproven, but some rows carry no anchor", () => {
    expect(integrityVerdictFor(chainOk(), anchors({ ok: false, unanchored: 1 }), noTruncation())).toBe("unproven");
  });

  it("compromised beats unproven when both are present", () => {
    expect(
      integrityVerdictFor(
        chainOk(),
        anchors({ ok: false, unanchored: 3, tampered: [tamperedResult] }),
        noTruncation(),
      ),
    ).toBe("compromised");
  });

  it("compromised: a broken chain, regardless of what the rows say", () => {
    // The anchors it holds cannot attest to anything once the chain they live in is broken, so a
    // clean anchor report must not soften the verdict.
    const broken = chainOk({ ok: false, integrity: { valid: false, brokenAt: 2 } });
    expect(integrityVerdictFor(broken, anchors(), noTruncation())).toBe("compromised");
    expect(integrityVerdictFor(broken, null, noTruncation())).toBe("compromised");
  });

  it("compromised: valid links but an unverifiable signature", () => {
    const unsigned = chainOk({
      ok: false,
      signatures: { valid: false, checked: 4, results: [], unresolvedFingerprints: [] },
    });
    expect(integrityVerdictFor(unsigned, anchors(), noTruncation())).toBe("compromised");
  });

  it("treats a zero-row anchor report as verified, not unproven", () => {
    expect(integrityVerdictFor(chainOk(), anchors({ checked: 0, verified: 0 }), noTruncation())).toBe("verified");
  });
});

describe("integrityVerdictFor — truncation", () => {
  const cut = noTruncation({ checkpointSequence: 9, tailSequence: 4, truncated: true });

  it("compromised when the chain ends before a checkpoint it was committed to", () => {
    // The decisive case: every link and signature still verifies, because a truncated chain is a
    // shorter well-formed chain. Only the checkpoint reveals that history went missing.
    expect(integrityVerdictFor(chainOk(), anchors(), cut)).toBe("compromised");
  });

  it("outranks a clean chain and clean anchors", () => {
    expect(integrityVerdictFor(chainOk({ ok: true }), anchors({ ok: true }), cut)).toBe(
      "compromised",
    );
  });

  it("compromised on the platform chain too", () => {
    expect(integrityVerdictFor(chainOk(), null, cut)).toBe("compromised");
  });

  it("not truncated when the tail is at or beyond the checkpoint", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors(), noTruncation({ checkpointSequence: 4, tailSequence: 4 })),
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
      ),
    ).toBe("verified");
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
        signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [] },
      }),
      truncation: noTruncation({ checkpointSequence: 11, tailSequence: 11 }),
    });
    const s = new IntegrityProofScheduler({
      prove: async () => caughtUp,
      scopes: () => [null],
      intervalMs: 1000,
    });
    expect((await s.runOnce())[0]?.outcome).toBe("proved");
  });

  it("skips a scope with no tail and no rows", async () => {
    const s = new IntegrityProofScheduler({
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
