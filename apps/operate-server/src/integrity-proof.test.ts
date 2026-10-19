import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  unreadableEntryVerdict,
  verifyChainSuffix,
  type ChainRead,
} from "@crossengin/forensics-pg";
import type { UnreadableRow } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import type { AuditAnchorReport, AuditAnchorResult } from "./audit-anchor.js";
import {
  CHAIN_FULL_REASONS,
  verifyChainFromCheckpoint,
  verifyChainFull,
  type ChainVerificationReport,
} from "./chain-verify.js";
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
  proveScopeIntegrity,
  type ChainTruncationCheck,
  type IntegrityProofReport,
} from "./integrity-proof.js";

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

function report(over: Partial<IntegrityProofReport> = {}): IntegrityProofReport {
  return {
    scope: TENANT_A,
    verdict: "verified",
    verifiedAt: AT,
    chain: chainOk(),
    anchors: anchors(),
    chainRowsRefused: [],
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
      chain: chainOk({ signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [], unreadable: [] } }),
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
      chain: chainOk({ signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [], unreadable: [] } }),
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
    expect(integrityVerdictFor(chainOk(), anchors(), noTruncation(), [])).toBe("verified");
  });

  it("verified: the platform chain, which has no rows to anchor", () => {
    expect(integrityVerdictFor(chainOk(), null, noTruncation(), [])).toBe("verified");
  });

  it("compromised: a row no longer matches its anchor", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors({ ok: false, tampered: [tamperedResult] }), noTruncation(), []),
    ).toBe("compromised");
  });

  it("unproven: nothing disproven, but some rows carry no anchor", () => {
    expect(integrityVerdictFor(chainOk(), anchors({ ok: false, unanchored: 1 }), noTruncation(), [])).toBe(
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
      ),
    ).toBe("compromised");
  });

  it("compromised: a broken chain, regardless of what the rows say", () => {
    // The anchors it holds cannot attest to anything once the chain they live in is broken, so a
    // clean anchor report must not soften the verdict.
    const broken = chainOk({ ok: false, integrity: { valid: false, brokenAt: 2 } });
    expect(integrityVerdictFor(broken, anchors(), noTruncation(), [])).toBe("compromised");
    expect(integrityVerdictFor(broken, null, noTruncation(), [])).toBe("compromised");
  });

  it("compromised: valid links but an unverifiable signature", () => {
    const unsigned = chainOk({
      ok: false,
      signatures: { valid: false, checked: 4, results: [], unresolvedFingerprints: [], unreadable: [] },
    });
    expect(integrityVerdictFor(unsigned, anchors(), noTruncation(), [])).toBe("compromised");
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
    expect(integrityVerdictFor(refused, anchors(), noTruncation(), [])).toBe("compromised");
    expect(integrityVerdictFor(refused, null, noTruncation(), [])).toBe("compromised");
  });

  it("compromised: an audit row the reader refuses, where an unanchored one is only unproven", () => {
    const refused = anchors({
      ok: false,
      unreadable: [{ identity: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", detail: "operation: too_small" }],
    });
    expect(integrityVerdictFor(chainOk(), refused, noTruncation(), [])).toBe("compromised");
    expect(
      integrityVerdictFor(chainOk(), anchors({ ok: false, unanchored: 1 }), noTruncation(), []),
    ).toBe("unproven");
  });

  it("treats a zero-row anchor report as verified, not unproven", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors({ checked: 0, verified: 0 }), noTruncation(), []),
    ).toBe("verified");
  });
});

describe("integrityVerdictFor — truncation", () => {
  const cut = noTruncation({ checkpointSequence: 9, tailSequence: 4, truncated: true });

  it("compromised when the chain ends before a checkpoint it was committed to", () => {
    // The decisive case: every link and signature still verifies, because a truncated chain is a
    // shorter well-formed chain. Only the checkpoint reveals that history went missing.
    expect(integrityVerdictFor(chainOk(), anchors(), cut, [])).toBe("compromised");
  });

  it("outranks a clean chain and clean anchors", () => {
    expect(integrityVerdictFor(chainOk({ ok: true }), anchors({ ok: true }), cut, [])).toBe(
      "compromised",
    );
  });

  it("compromised on the platform chain too", () => {
    expect(integrityVerdictFor(chainOk(), null, cut, [])).toBe("compromised");
  });

  it("not truncated when the tail is at or beyond the checkpoint", () => {
    expect(
      integrityVerdictFor(chainOk(), anchors(), noTruncation({ checkpointSequence: 4, tailSequence: 4 }), []),
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
        signatures: { valid: true, checked: 0, results: [], unresolvedFingerprints: [], unreadable: [] },
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
        checkpoints: { latest: async () => null },
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
      checkpoints: { latest: async () => null },
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
      checkpoints: { latest: async () => anchor },
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
    });
    expect(line).toContain("1 entry the contract refuses");
    expect(line).not.toMatch(/integrity BROKEN at 1,/);
  });
});
