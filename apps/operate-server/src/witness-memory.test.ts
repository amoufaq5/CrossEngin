import { describe, expect, it } from "vitest";
import { type ChainedLogEntry } from "@crossengin/forensics";

import { type ChainTruncationCheck } from "./anchor-audit.js";
import {
  WITNESS_MEMORY_GRADE,
  WITNESS_MEMORY_OUTCOMES,
  compareWitnessMemory,
  formatWitnessMemory,
  noWitnessMemory,
  witnessMemoryDisproves,
  witnessMemoryShowsHistory,
  witnessMemoryUnproven,
  type AttestedWitness,
  type AttestedWitnessRead,
  type WitnessMemoryOutcome,
} from "./witness-memory.js";

const AT = "2026-11-01T00:00:00.000Z";

/**
 * A distinct contract-valid sha256 hex per sequence, with the sequence in the first two characters
 * so a failure message says which entry a hash belongs to. The comparison reads
 * `(sequenceNumber, payloadSha256, entryHash)` and nothing else, so that is the whole of what a
 * fixture owes.
 */
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

/** An attested witness anchored in a real entry of the fixture chain. */
function attested(overrides: Partial<AttestedWitness> = {}): AttestedWitness {
  return {
    witnessSequence: 5,
    tailSequence: 5,
    verifiedAt: AT,
    payloadSha256: payloadOf(3),
    chainEntryHash: entryHashOf(3),
    chainSequenceNumber: 3,
    ...overrides,
  };
}

const read = (a: AttestedWitness): AttestedWitnessRead => ({ kind: "attested", attested: a });

function truncation(
  checkpointSequence: number | null,
  tailSequence: number | null,
): ChainTruncationCheck {
  return {
    checkpointSequence,
    tailSequence,
    truncated:
      checkpointSequence !== null && (tailSequence === null || checkpointSequence > tailSequence),
  };
}

/** The healthy pass: a complete scan over a genesis-anchored chain holding the verdict's entry. */
function compare(input: {
  read?: AttestedWitnessRead | null;
  current?: ChainTruncationCheck;
  chain?: readonly ChainedLogEntry[] | null;
  currentScanComplete?: boolean;
}) {
  return compareWitnessMemory({
    read: input.read === undefined ? read(attested()) : input.read,
    current: input.current ?? truncation(5, 5),
    chain: input.chain === undefined ? chainOf([0, 1, 2, 3, 4, 5]) : input.chain,
    currentScanComplete: input.currentScanComplete ?? true,
  });
}

describe("WITNESS_MEMORY_OUTCOMES", () => {
  it("is the exact set, in the order a reader of compareWitnessMemory meets them", () => {
    // Pinned as an ordered literal rather than a membership test: the clause order in
    // `compareWitnessMemory` is the order of what can be established, and a tenth outcome inserted
    // in the middle is a claim about that order.
    expect(WITNESS_MEMORY_OUTCOMES).toEqual([
      "not_recorded",
      "no_prior_verdict",
      "prior_unreadable",
      "prior_unanchored",
      "unverifiable_here",
      "prior_verdict_contradicted",
      "consistent",
      "witness_regressed",
      "witness_not_comparable",
    ]);
  });

  it("grades every outcome, and nothing else", () => {
    expect(Object.keys(WITNESS_MEMORY_GRADE).sort()).toEqual([...WITNESS_MEMORY_OUTCOMES].sort());
  });

  it("grades exactly two outcomes as disproving, and both are findings about history", () => {
    // The population matters rather than the count: every `disproves` member becomes a
    // `COMPROMISE_CAUSES` member in `integrity-proof.ts`, so a tenth outcome graded `disproves`
    // without a cause beside it would be `compromised` here and invisible to the verdict.
    // `integrity-proof.test.ts` asserts that correspondence in both directions.
    const disproving = WITNESS_MEMORY_OUTCOMES.filter(
      (o) => WITNESS_MEMORY_GRADE[o] === "disproves",
    );
    expect(disproving).toEqual(["prior_verdict_contradicted", "witness_regressed"]);
  });

  it("grades prior_unreadable unproven rather than disproving", () => {
    // The one grade worth a test of its own: its two siblings one table over are `compromised`
    // (ADR-0373 for a chain row, ADR-0374 for an anchor row) and this is a row in a *projection*
    // whose writer swallows a failed write — so grading it `disproves` would let a failed
    // `record()` page somebody.
    expect(WITNESS_MEMORY_GRADE.prior_unreadable).toBe("unproven");
  });

  it("agrees with its three predicates in both directions", () => {
    for (const outcome of WITNESS_MEMORY_OUTCOMES) {
      const check = { ...noWitnessMemory(), outcome };
      expect(witnessMemoryDisproves(check)).toBe(WITNESS_MEMORY_GRADE[outcome] === "disproves");
      expect(witnessMemoryUnproven(check)).toBe(WITNESS_MEMORY_GRADE[outcome] === "unproven");
    }
  });
});

describe("compareWitnessMemory", () => {
  it("answers not_recorded with no claim when no source was supplied", () => {
    const check = compare({ read: null });
    expect(check.outcome).toBe("not_recorded");
    expect(check.attestedWitness).toBeNull();
    expect(check.attestedTail).toBeNull();
    expect(check.attestedAt).toBeNull();
  });

  it("answers no_prior_verdict for a first pass", () => {
    expect(compare({ read: { kind: "none" } }).outcome).toBe("no_prior_verdict");
  });

  it("routes an unreadable prior verdict rather than throwing, carrying its detail", () => {
    const check = compare({ read: { kind: "unreadable", detail: "chain.truncation: invalid_type" } });
    expect(check.outcome).toBe("prior_unreadable");
    expect(check.detail).toBe("chain.truncation: invalid_type");
    // No figures: the row could not be read, so there is nothing to attest.
    expect(check.attestedWitness).toBeNull();
  });

  it("carries the attested figures on every outcome that read a row", () => {
    const check = compare({});
    expect(check.outcome).toBe("consistent");
    expect(check.attestedWitness).toBe(5);
    expect(check.attestedTail).toBe(5);
    expect(check.attestedAt).toBe(AT);
  });

  describe("the anchor's two halves", () => {
    // Read as a pair so a row carrying one half cannot reach the comparison on the strength of the
    // other — ADR-0318's rule, and the rule the row is written under.
    it.each([
      ["entry hash", { chainEntryHash: null }],
      ["sequence number", { chainSequenceNumber: null }],
      ["payload digest", { payloadSha256: null }],
    ])("answers prior_unanchored for a row missing its %s", (_label, missing) => {
      const check = compare({ read: read(attested(missing)) });
      expect(check.outcome).toBe("prior_unanchored");
      expect(WITNESS_MEMORY_GRADE[check.outcome]).toBe("no_claim");
      // The figures still travel: a reader needs to see what the unanchored row claimed.
      expect(check.attestedWitness).toBe(5);
    });
  });

  it("answers unverifiable_here when this pass holds no chain", () => {
    const check = compare({ chain: null });
    expect(check.outcome).toBe("unverifiable_here");
    expect(check.detail).toBe("this pass holds no chain to compare");
  });

  it("answers unverifiable_here for an entry below a bounded pass's window", () => {
    // A bounded pass loads the suffix after its anchor. Calling an entry below that window
    // destroyed would make every bounded pass on a healthy deployment report a compromise.
    const check = compare({ chain: chainOf([4, 5]), current: truncation(5, 5) });
    expect(check.outcome).toBe("unverifiable_here");
    expect(check.detail).toContain("below this pass's window");
  });

  it("contradicts the verdict over an EMPTY chain, which an earlier draft excused", () => {
    // The live A6 arm — chain and anchors both destroyed — answered `verified` while this clause
    // excused an empty chain as "absent says nothing". It says the most there is to say: a complete
    // reading of a chain holding nothing, against a verdict whose own anchor proves an entry
    // existed, because `record()` appends the entry and only then stores the row. The excuse
    // belongs to a *window*, which is the clause below.
    const check = compare({ chain: [], current: truncation(null, null) });
    expect(check.outcome).toBe("prior_verdict_contradicted");
    expect(witnessMemoryDisproves(check)).toBe(true);
  });

  describe("prior_verdict_contradicted", () => {
    it("fires when a genesis-anchored chain holds no entry at the verdict's sequence", () => {
      // The lowering attack's **second** detector, independent of the witness: the prior verdict's
      // own chain entry sat at sequence 3, and a truncation that removed it is refuted by its
      // absence whatever the anchor table was edited to say.
      const check = compare({ chain: chainOf([0, 1, 2]), current: truncation(2, 2) });
      expect(check.outcome).toBe("prior_verdict_contradicted");
      expect(witnessMemoryDisproves(check)).toBe(true);
    });

    it("fires when the entry at that sequence commits to different content", () => {
      const rewritten = chainOf([0, 1, 2, 3, 4, 5]).map((e) =>
        e.sequenceNumber === 3 ? { ...e, payloadSha256: payloadOf(9) } : e,
      );
      const check = compare({ chain: rewritten });
      expect(check.outcome).toBe("prior_verdict_contradicted");
      expect(check.detail).toContain("commits to different content");
    });

    it("fires on a rewritten entry hash with the payload digest intact", () => {
      const rewritten = chainOf([0, 1, 2, 3, 4, 5]).map((e) =>
        e.sequenceNumber === 3 ? { ...e, entryHash: entryHashOf(9) } : e,
      );
      expect(compare({ chain: rewritten }).outcome).toBe("prior_verdict_contradicted");
    });

    it("outranks the witness comparison, so one scope reports the stronger finding", () => {
      // Both would fire on the measured two-column lowering. The contradiction is reported because
      // it is a statement about the chain, which is the table being verified.
      const check = compare({ chain: chainOf([0, 1, 2]), current: truncation(null, 2) });
      expect(check.outcome).toBe("prior_verdict_contradicted");
    });
  });

  describe("witness_regressed", () => {
    it("fires when the anchor table now holds no witness at all", () => {
      // The measured anchor `DELETE`: 3 rows removed as the non-owner `serving` role, leaving
      // `witness=null` and a formatter printing "run the checkpoint scheduler".
      const check = compare({ current: truncation(null, 5) });
      expect(check.outcome).toBe("witness_regressed");
      expect(check.detail).toContain("now has none");
      expect(witnessMemoryDisproves(check)).toBe(true);
    });

    it("fires when the highest uncontradicted anchor is below one a prior verdict attested", () => {
      const check = compare({ current: truncation(2, 5) });
      expect(check.outcome).toBe("witness_regressed");
      expect(check.detail).toContain("below one a prior verdict attested");
    });

    it("does not fire when the witness advanced, which is the healthy direction", () => {
      expect(compare({ current: truncation(9, 9) }).outcome).toBe("consistent");
    });

    it("does not fire when a prior verdict attested no witness", () => {
      // Nothing to regress from. A pass whose anchor table was empty attests `null`, and an anchor
      // appearing afterwards is the scheduler doing its job.
      const check = compare({
        read: read(attested({ witnessSequence: null })),
        current: truncation(null, 5),
      });
      expect(check.outcome).toBe("consistent");
    });
  });

  describe("witness_not_comparable", () => {
    it("gates the comparison on this pass's scan having finished", () => {
      // Found by an adversarial measurement against the built tree: a memory cause outranks
      // `!anchorAudit.complete`, so a regression concluded from a lower-bound witness would page.
      // `auditAnchors` scans ascending, so a cut scan's witness is the highest among the *oldest*
      // rows it reached.
      const check = compare({ current: truncation(2, 5), currentScanComplete: false });
      expect(check.outcome).toBe("witness_not_comparable");
      expect(WITNESS_MEMORY_GRADE[check.outcome]).toBe("no_claim");
    });

    it("gates the no-witness-at-all arm too", () => {
      const check = compare({ current: truncation(null, 5), currentScanComplete: false });
      expect(check.outcome).toBe("witness_not_comparable");
    });

    it("does not gate the contradiction, which reads the chain rather than the scan", () => {
      // The correspondence half is about entries this pass loaded, so an incomplete *anchor* scan
      // says nothing about it — and gating it would disarm the detector on exactly the pass that
      // most needs it.
      const check = compare({
        chain: chainOf([0, 1, 2]),
        current: truncation(2, 2),
        currentScanComplete: false,
      });
      expect(check.outcome).toBe("prior_verdict_contradicted");
    });

    it("does not gate an attested witness that was itself a lower bound", () => {
      // Only the *current* side needs the gate: an attested lower bound can only make the
      // comparison harder to trip, which is the safe direction.
      expect(compare({ current: truncation(5, 5), currentScanComplete: true }).outcome).toBe(
        "consistent",
      );
    });
  });
});

describe("witnessMemoryShowsHistory", () => {
  it("is false for every outcome that read no row", () => {
    for (const outcome of ["not_recorded", "no_prior_verdict", "prior_unreadable"] as const) {
      expect(witnessMemoryShowsHistory({ ...noWitnessMemory(), outcome })).toBe(false);
    }
  });

  it("is true when either attested figure is present", () => {
    // Either, because a scope whose first pass found an empty anchor table attests
    // `witnessSequence: null` with a real tail — and that tail is the history `isEmptyScope` could
    // not ask about.
    expect(
      witnessMemoryShowsHistory(compare({ read: read(attested({ witnessSequence: null })) })),
    ).toBe(true);
    expect(
      witnessMemoryShowsHistory(
        compare({
          read: read(attested({ tailSequence: null })),
          current: truncation(5, 5),
        }),
      ),
    ).toBe(true);
  });

  it("is false for a prior verdict attesting neither figure", () => {
    // A pass over a scope that genuinely held nothing. There is no history to refute "this scope is
    // new" with, so `isEmptyScope` is right to discard such a report.
    const check = compare({
      read: read(attested({ witnessSequence: null, tailSequence: null })),
      current: truncation(null, null),
      chain: chainOf([0, 1, 2, 3, 4, 5]),
    });
    expect(check.outcome).toBe("consistent");
    expect(witnessMemoryShowsHistory(check)).toBe(false);
  });
});

describe("noWitnessMemory", () => {
  it("carries no claim about the table", () => {
    const check = noWitnessMemory();
    expect(check.outcome).toBe("not_recorded");
    expect(witnessMemoryDisproves(check)).toBe(false);
    expect(witnessMemoryUnproven(check)).toBe(false);
    expect(witnessMemoryShowsHistory(check)).toBe(false);
  });

  it("is not the clean answer, which a fixture built from it would be asserting", () => {
    expect(noWitnessMemory().outcome).not.toBe("consistent");
    expect(formatWitnessMemory(noWitnessMemory())).not.toEqual([]);
  });

  it("returns a fresh object, because reports built from it are mutated by tests", () => {
    expect(noWitnessMemory()).not.toBe(noWitnessMemory());
  });
});

describe("formatWitnessMemory", () => {
  it("is silent on the healthy steady state and on nothing else", () => {
    const silent = WITNESS_MEMORY_OUTCOMES.filter(
      (o) => formatWitnessMemory({ ...noWitnessMemory(), outcome: o }).length === 0,
    );
    expect(silent).toEqual(["consistent"]);
  });

  it("names every outcome it prints", () => {
    for (const outcome of WITNESS_MEMORY_OUTCOMES) {
      if (outcome === "consistent") continue;
      const lines = formatWitnessMemory({ ...noWitnessMemory(), outcome });
      expect(lines[0]).toMatch(/^ {2}witness memory: \S/);
      // A phrase that merely restates its own key tells a reader nothing.
      expect(lines[0]).not.toContain(outcome);
    }
  });

  it("appends the detail when there is one", () => {
    const lines = formatWitnessMemory(compare({ chain: null }));
    expect(lines).toEqual([
      "  witness memory: the newest stored verdict is outside this pass's window (this pass holds no chain to compare)",
    ]);
  });

  it("says a regression has no lawful cause, with the figures and the instant", () => {
    const lines = formatWitnessMemory(compare({ current: truncation(null, 5) }));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("ANCHORS LOST");
    expect(lines[1]).toBe(
      "    a prior verdict at 2026-11-01T00:00:00.000Z attested witness 5 and tail 5",
    );
    // The detail on its own line, not composed into the one above it — which is what made the live
    // output read "attested witness 5 at …, and this pass found a prior verdict attested a witness
    // and this scope's anchor table now has none".
    expect(lines[2]).toBe("    a prior verdict attested a witness and this scope's anchor table now has none");
    expect(lines[3]).toContain("nothing in this workspace deletes or lowers a checkpoint");
  });

  it("composes no sentence into another, on any line it prints", () => {
    // The general form of the defect above: every detail string is a full sentence, so a line that
    // interpolates one into surrounding prose reads as two clauses stitched together. Asserted by
    // shape rather than per arm, so a tenth outcome cannot reintroduce it.
    for (const outcome of WITNESS_MEMORY_OUTCOMES) {
      for (const line of formatWitnessMemory({ ...noWitnessMemory(), outcome, detail: "a detail" })) {
        // A detail may end a line or be parenthesised; it may not sit mid-sentence with prose after.
        expect(line, outcome).not.toMatch(/a detail\s+\S/);
      }
    }
  });

  it("never prints a value read out of the chain or the verdict row", () => {
    // The detail strings are literals by construction; this pins it, because the one thing a log
    // line must not carry from a tampered row is its content (ADR-0367's rule, ADR-0373's fix).
    const hostile = chainOf([0, 1, 2, 3, 4, 5]).map((e) =>
      e.sequenceNumber === 3 ? { ...e, payloadSha256: payloadOf(9) } : e,
    );
    const lines = formatWitnessMemory(compare({ chain: hostile })).join("\n");
    expect(lines).not.toContain(payloadOf(9));
    expect(lines).not.toContain(entryHashOf(3));
  });
});

describe("the detail strings", () => {
  it("are literals, so no outcome can carry a value into a log line", () => {
    // Enumerated across every arm that sets one, rather than asserted of the module as text: each
    // detail is a fixed sentence and a template would be the defect.
    const details = new Set<string | null>();
    const arms: Array<Parameters<typeof compare>[0]> = [
      {},
      { read: null },
      { read: { kind: "none" } },
      { read: read(attested({ chainEntryHash: null })) },
      { chain: null },
      { chain: chainOf([4, 5]) },
      { chain: chainOf([0, 1, 2]), current: truncation(2, 2) },
      { current: truncation(null, 5) },
      { current: truncation(2, 5) },
      { current: truncation(2, 5), currentScanComplete: false },
    ];
    const outcomes = new Set<WitnessMemoryOutcome>();
    for (const arm of arms) {
      const check = compare(arm);
      outcomes.add(check.outcome);
      details.add(check.detail);
    }
    // Non-vacuity: the arms reach eight of the nine outcomes (`prior_unreadable` is the ninth and
    // is the one arm whose detail is *supplied* by the caller, tested above).
    expect(outcomes.size).toBe(8);
    for (const detail of details) {
      if (detail === null) continue;
      expect(detail).not.toMatch(/[0-9a-f]{64}/);
      expect(detail).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });
});
