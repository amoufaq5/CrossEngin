import { describe, expect, it } from "vitest";
import { type ChainedLogEntry } from "@crossengin/forensics";

import { chainTruncation, type AnchorAuditReport } from "./anchor-audit.js";
import { verifyChainVerdict, verifyChainWitnessMemory } from "./chain-verify.js";
import {
  attestedWitnessFrom,
  storedVerdictCensusFrom,
  type StoredVerdictCensus,
} from "./integrity-verdict-store.js";
import { witnessMemoryDisproves, type AttestedWitnessRead } from "./witness-memory.js";

/**
 * `verify-chain`'s fourth axis (ADR-0481): what the command concludes once the deployment's own
 * newest baseline verdict is read beside the chain and the anchor table.
 *
 * The case that motivates it is the one the first three axes could not separate: a scope whose
 * entries **and** checkpoints were both deleted is byte-identical, from those two tables, to a scope
 * that never had history — so it printed `NO HISTORY` and exited 0.
 */

const AT = "2026-11-01T00:00:00.000Z";
const payloadOf = (seq: number): string => `${String(seq).padStart(2, "0")}${"a".repeat(62)}`;
const entryHashOf = (seq: number): string => `${String(seq).padStart(2, "0")}${"c".repeat(62)}`;

function chainOf(sequences: readonly number[]): readonly ChainedLogEntry[] {
  return sequences.map((seq) => ({
    sequenceNumber: seq,
    kind: "security_event" as const,
    recordedAt: AT,
    actorReference: "actor",
    payloadSha256: payloadOf(seq),
    payloadSizeBytes: 1,
    priorEntryHash: seq === 0 ? "0".repeat(64) : entryHashOf(seq - 1),
    entryHash: entryHashOf(seq),
    signingKeyFingerprint: "d".repeat(64),
    signature: "sig",
  }));
}

function anchorsWith(witness: number | null): AnchorAuditReport {
  return {
    scope: null,
    scanned: witness === null ? 0 : 1,
    complete: true,
    refused: [],
    refusedCount: 0,
    disagreeing: [],
    disagreeingCount: 0,
    witnessSequence: witness,
    readableWitnessSequence: witness,
    signatures: { signed: 0, unsigned: 0, missigned: [], missignedCount: 0 },
  };
}

function chainReport(checked: number) {
  return {
    ok: true,
    signatures: { valid: true, checked, results: [], unresolvedFingerprints: [], unreadable: [] },
  };
}

/** A baseline anchored at chain entry 3, attesting witness 5 over a tail of 5. */
const attestedAt3: AttestedWitnessRead = {
  kind: "attested",
  attested: {
    witnessSequence: 5,
    tailSequence: 5,
    verifiedAt: AT,
    payloadSha256: payloadOf(3),
    chainEntryHash: entryHashOf(3),
    chainSequenceNumber: 3,
  },
};

/** The command's composition, as `runVerifyChain` and `runVerify` perform it. */
function decide(input: {
  prior: AttestedWitnessRead;
  chain: readonly ChainedLogEntry[];
  witness: number | null;
  census?: StoredVerdictCensus;
}) {
  const anchors = anchorsWith(input.witness);
  const tail = input.chain.at(-1)?.sequenceNumber ?? null;
  const truncation = chainTruncation(anchors.witnessSequence, tail);
  const witnessMemory = verifyChainWitnessMemory({
    prior: input.prior,
    anchors,
    truncation,
    correspondenceChain: input.chain,
  });
  return {
    witnessMemory,
    ...verifyChainVerdict({
      chain: chainReport(input.chain.length),
      anchors,
      truncation,
      witnessMemory,
      // A baseline implies at least its own row; a test that names none means none was stored.
      storedVerdicts:
        input.census ??
        { kind: "counted", rows: input.prior.kind === "attested" ? 1 : 0 },
    }),
  };
}

describe("verify-chain's witness memory (ADR-0481)", () => {
  it("names a genuinely new scope NO HISTORY and exits 0 when no prior verdict exists", async () => {
    // Through the real seam, with a store that holds no baseline: `latestBaseline` answers null.
    const prior = await attestedWitnessFrom({ latestBaseline: () => Promise.resolve(null) }, null);
    expect(prior.kind).toBe("none");
    const out = decide({ prior, chain: [], witness: null });
    expect(out.witnessMemory.outcome).toBe("no_prior_verdict");
    expect(out.headline).toMatch(/^NO HISTORY/);
    expect(out.exitCode).toBe(0);
  });

  it("exits 1 when a stored baseline attests history the destroyed scope no longer holds", () => {
    // Entries and checkpoints both gone: the same two tables as the case above, and the only
    // difference is the baseline. Before ADR-0481 this read `NO HISTORY` and exit 0.
    const out = decide({ prior: attestedAt3, chain: [], witness: null });
    expect(witnessMemoryDisproves(out.witnessMemory)).toBe(true);
    expect(out.witnessMemory.outcome).toBe("prior_verdict_contradicted");
    expect(out.headline).toMatch(/^HISTORY CONTRADICTED/);
    expect(out.exitCode).toBe(1);
  });

  it("exits 1 when only the anchors were deleted and the chain is intact", () => {
    // The regression arm: the prior verdict's own entry is still there, so nothing contradicts it,
    // and the witness it attested has no anchor left behind it.
    const out = decide({ prior: attestedAt3, chain: chainOf([0, 1, 2, 3, 4, 5]), witness: null });
    expect(out.witnessMemory.outcome).toBe("witness_regressed");
    expect(out.exitCode).toBe(1);
  });

  it("stays OK on a healthy scope whose baseline the chain still holds (the control)", () => {
    const out = decide({ prior: attestedAt3, chain: chainOf([0, 1, 2, 3, 4, 5]), witness: 5 });
    expect(out.witnessMemory.outcome).toBe("consistent");
    expect(out.headline).toBeNull();
    expect(out.exitCode).toBe(0);
  });

  it("exits 1 when the baseline cannot be read, because 'no history' is then not established", async () => {
    const prior = await attestedWitnessFrom(
      { latestBaseline: () => Promise.reject(new Error("stored integrity verdict x is unreadable")) },
      null,
    );
    expect(prior.kind).toBe("unreadable");
    const out = decide({ prior, chain: [], witness: null });
    expect(out.witnessMemory.outcome).toBe("prior_unreadable");
    expect(out.headline).toMatch(/^UNPROVEN/);
    expect(out.exitCode).toBe(1);
  });

  it("keeps TRUNCATED ahead of the memory, so an operator is sent to the chain first", () => {
    const out = decide({ prior: attestedAt3, chain: chainOf([0, 1, 2]), witness: 5 });
    expect(out.headline).toBe("TRUNCATED");
    expect(out.exitCode).toBe(1);
  });
});

describe("verify-chain's census of stored verdict rows (ADR-0481's review)", () => {
  it("exits 1 when the baseline was filtered away by a column edit and the chain is empty", async () => {
    // The attack measured live as the confined role: one tenant-context `UPDATE … SET verdict =
    // 'unproven'` empties `latestBaseline`, the chain and checkpoints are then destroyed, and the
    // memory alone answers `no_prior_verdict` — so this read NO HISTORY and exited 0 again.
    const census = await storedVerdictCensusFrom(
      { counts: () => Promise.resolve({ verified: 0, unproven: 1, compromised: 0, total: 1 }) },
      null,
    );
    expect(census).toEqual({ kind: "counted", rows: 1 });
    const out = decide({ prior: { kind: "none" }, chain: [], witness: null, census });
    expect(out.witnessMemory.outcome).toBe("no_prior_verdict");
    expect(out.headline).toMatch(/^HISTORY CONTRADICTED — this deployment stored 1 verdict row/);
    expect(out.exitCode).toBe(1);
  });

  it("does not call a column edit on an intact chain a destruction (the control)", () => {
    const out = decide({
      prior: { kind: "none" },
      chain: chainOf([0, 1, 2, 3, 4, 5]),
      witness: 5,
      census: { kind: "counted", rows: 3 },
    });
    expect(out.headline).toBeNull();
    expect(out.exitCode).toBe(0);
  });

  it("exits 1 when the chain is empty and the census could not be read", async () => {
    const census = await storedVerdictCensusFrom(
      { counts: () => Promise.reject(new Error("permission denied for table audit_integrity_verdicts")) },
      "00000000-0000-4000-8000-000000000001",
    );
    expect(census.kind).toBe("unreadable");
    const out = decide({ prior: { kind: "none" }, chain: [], witness: null, census });
    expect(out.headline).toMatch(/^UNPROVEN — the chain is empty/);
    expect(out.exitCode).toBe(1);
  });

  it("says NO HISTORY with exit 0 only when the census counted no row", () => {
    const out = decide({ prior: { kind: "none" }, chain: [], witness: null, census: { kind: "counted", rows: 0 } });
    expect(out.headline).toBe(
      "NO HISTORY — the chain holds no entry, and this deployment stored no verdict for this scope",
    );
    expect(out.exitCode).toBe(0);
  });
});
