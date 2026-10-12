import { MockLlmProvider, type CompletionChunk, type ProviderPricing } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";

import { DESIGN_OUTPUT_SHAPES, DESIGN_OUTPUT_WRAPPERS, classifyDesignOutput } from "./design-output.js";
import {
  DEFAULT_DESIGN_MAX_ATTEMPTS,
  DESIGN_SHAPE_RETRIABILITY,
  DESIGN_WRAPPER_RECOVERY,
  planDesignRetry,
  runDesignWithRetry,
  type DesignAttemptOutcome,
} from "./design-retry.js";

const PAID: ProviderPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15 };

const MANIFEST = '{"manifestVersion":"1","meta":{"name":"x"},"entities":[]}';
const FENCED_MANIFEST = "```json\n" + MANIFEST + "\n```";
const FENCED_ARRAY = '```json\n[{"entities":[]}]\n```';
const TRUNCATED = '{"entities":[{"name":"Invoice"';
const PROSE = "Sure! I can help you design that schema.";

const diagnose = (text: string) => classifyDesignOutput(text);

const cost = { pricing: PAID, promptChars: 3500, maxOutputTokens: 1000 } as const;

describe("the retriability maps", () => {
  it("is total over every shape", () => {
    for (const shape of DESIGN_OUTPUT_SHAPES) {
      expect(DESIGN_SHAPE_RETRIABILITY[shape]).toBeDefined();
    }
    expect(Object.keys(DESIGN_SHAPE_RETRIABILITY).sort()).toEqual([...DESIGN_OUTPUT_SHAPES].sort());
  });

  it("is total over every wrapper", () => {
    for (const wrapper of DESIGN_OUTPUT_WRAPPERS) {
      expect(DESIGN_WRAPPER_RECOVERY[wrapper]).toBeDefined();
    }
    expect(Object.keys(DESIGN_WRAPPER_RECOVERY).sort()).toEqual([...DESIGN_OUTPUT_WRAPPERS].sort());
  });

  it("marks exactly one shape as succeeded", () => {
    const succeeded = DESIGN_OUTPUT_SHAPES.filter(
      (s) => DESIGN_SHAPE_RETRIABILITY[s] === "succeeded",
    );
    expect(succeeded).toEqual(["manifest_shaped_object"]);
  });

  it("marks a well-formed answer to a different question as never retriable", () => {
    expect(DESIGN_SHAPE_RETRIABILITY.array_not_object).toBe("wrong_question");
    expect(DESIGN_SHAPE_RETRIABILITY.scalar_not_object).toBe("wrong_question");
    expect(DESIGN_SHAPE_RETRIABILITY.object_not_manifest).toBe("wrong_question");
  });

  it("marks a failure to produce the answer as retriable", () => {
    expect(DESIGN_SHAPE_RETRIABILITY.empty).toBe("retry_production");
    expect(DESIGN_SHAPE_RETRIABILITY.no_json).toBe("retry_production");
    expect(DESIGN_SHAPE_RETRIABILITY.truncated_json).toBe("retry_production");
    expect(DESIGN_SHAPE_RETRIABILITY.malformed_json).toBe("retry_production");
  });

  it("treats a wrapper as already recovered, so it is never itself a reason to retry", () => {
    expect(DESIGN_WRAPPER_RECOVERY.code_fence).toBe("mechanically_recovered");
    expect(DESIGN_WRAPPER_RECOVERY.surrounding_prose).toBe("mechanically_recovered");
    expect(DESIGN_WRAPPER_RECOVERY.none).toBe("not_wrapped");
  });
});

describe("planDesignRetry", () => {
  it("accepts a manifest and hands back its object", () => {
    const plan = planDesignRetry({ diagnosis: diagnose(MANIFEST), attemptsMade: 1, maxAttempts: 3 });
    expect(plan.action).toBe("accept");
    if (plan.action !== "accept") return;
    expect(plan.object).not.toBeNull();
  });

  it("accepts a *fenced* manifest without spending another call on it", () => {
    const d = diagnose(FENCED_MANIFEST);
    expect(d.wrapper).toBe("code_fence");
    expect(planDesignRetry({ diagnosis: d, attemptsMade: 1, maxAttempts: 3 }).action).toBe("accept");
  });

  it("refuses to retry a fenced array, however many attempts are left", () => {
    const d = diagnose(FENCED_ARRAY);
    expect(d.shape).toBe("array_not_object");
    expect(d.wrapper).toBe("code_fence");
    const plan = planDesignRetry({ diagnosis: d, attemptsMade: 1, maxAttempts: 10 });
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.reason).toBe("wrong_question");
  });

  it("retries a truncated reply", () => {
    const plan = planDesignRetry({
      diagnosis: diagnose(TRUNCATED),
      attemptsMade: 1,
      maxAttempts: 3,
    });
    expect(plan.action).toBe("retry");
    if (plan.action !== "retry") return;
    expect(plan.attemptNumber).toBe(2);
    expect(plan.estimate).toBeUndefined();
  });

  it("retries prose, which is a formatting failure and not a wrong answer", () => {
    expect(
      planDesignRetry({ diagnosis: diagnose(PROSE), attemptsMade: 1, maxAttempts: 3 }).action,
    ).toBe("retry");
  });

  it("retries an empty reply", () => {
    expect(
      planDesignRetry({ diagnosis: diagnose(""), attemptsMade: 1, maxAttempts: 3 }).action,
    ).toBe("retry");
  });

  it("stops on the attempt count once a retriable shape has used them all", () => {
    const plan = planDesignRetry({
      diagnosis: diagnose(TRUNCATED),
      attemptsMade: 3,
      maxAttempts: 3,
    });
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.reason).toBe("attempts_exhausted");
  });

  it("reports a wrong answer as wrong_question even on the last attempt", () => {
    const plan = planDesignRetry({
      diagnosis: diagnose("[1,2,3]"),
      attemptsMade: 3,
      maxAttempts: 3,
    });
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.reason).toBe("wrong_question");
  });

  it("allows at least one attempt however the limit is spelled", () => {
    for (const maxAttempts of [0, -5]) {
      const plan = planDesignRetry({ diagnosis: diagnose(TRUNCATED), attemptsMade: 1, maxAttempts });
      expect(plan.action).toBe("stop");
      if (plan.action !== "stop") continue;
      expect(plan.reason).toBe("attempts_exhausted");
    }
    // A non-finite limit reads as the default rather than as "one attempt".
    expect(
      planDesignRetry({
        diagnosis: diagnose(TRUNCATED),
        attemptsMade: 1,
        maxAttempts: Number.NaN,
      }).action,
    ).toBe("retry");
  });

  it("prices the next attempt against what is LEFT of the per-request ceiling", () => {
    const plan = planDesignRetry({
      diagnosis: diagnose(TRUNCATED),
      attemptsMade: 1,
      maxAttempts: 3,
      budget: { ceiling: { maxDollars: 1 }, spentDollars: 0.1, nextAttempt: cost },
    });
    expect(plan.action).toBe("retry");
    if (plan.action !== "retry") return;
    expect(plan.estimate?.kind).toBe("bounded");
  });

  it("stops when the ceiling is already spent, so a retry cannot multiply the cap", () => {
    const plan = planDesignRetry({
      diagnosis: diagnose(TRUNCATED),
      attemptsMade: 1,
      maxAttempts: 5,
      budget: { ceiling: { maxDollars: 0.02 }, spentDollars: 0.02, nextAttempt: cost },
    });
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.reason).toBe("budget_exhausted");
  });

  it("stops when the next attempt does not fit the remainder", () => {
    const plan = planDesignRetry({
      diagnosis: diagnose(TRUNCATED),
      attemptsMade: 1,
      maxAttempts: 5,
      budget: {
        ceiling: { maxDollars: 0.02 },
        spentDollars: 0.0199,
        nextAttempt: cost,
      },
    });
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.reason).toBe("budget_exhausted");
    expect(plan.detail).toMatch(/per-request ceiling/);
  });

  it("applies the session's inflation factor to the retry's own estimate", () => {
    const plain = planDesignRetry({
      diagnosis: diagnose(TRUNCATED),
      attemptsMade: 1,
      maxAttempts: 5,
      budget: { ceiling: { maxDollars: 0.02 }, spentDollars: 0, nextAttempt: cost },
    });
    const inflated = planDesignRetry({
      diagnosis: diagnose(TRUNCATED),
      attemptsMade: 1,
      maxAttempts: 5,
      budget: { ceiling: { maxDollars: 0.02 }, spentDollars: 0, nextAttempt: cost, inflation: 50 },
    });
    expect(plain.action).toBe("retry");
    expect(inflated.action).toBe("stop");
  });

  it("checks the wrong answer before either bound, so the reason is the honest one", () => {
    const plan = planDesignRetry({
      diagnosis: diagnose("[1]"),
      attemptsMade: 9,
      maxAttempts: 1,
      budget: { ceiling: { maxDollars: 0.0001 }, spentDollars: 1, nextAttempt: cost },
    });
    expect(plan.action).toBe("stop");
    if (plan.action !== "stop") return;
    expect(plan.reason).toBe("wrong_question");
  });
});

describe("runDesignWithRetry", () => {
  const scripted = (replies: readonly string[], dollars = 0) => {
    const seen: number[] = [];
    const attempt = async (n: number): Promise<DesignAttemptOutcome> => {
      seen.push(n);
      return { text: replies[n - 1] ?? "", actualDollars: dollars };
    };
    return { attempt, seen };
  };

  it("accepts on the first attempt and reports one attempt made", async () => {
    const { attempt, seen } = scripted([MANIFEST]);
    const report = await runDesignWithRetry(attempt);
    expect(report.outcome).toBe("accepted");
    expect(report.attemptsMade).toBe(1);
    expect(report.stopReason).toBe("accepted");
    expect(report.object).not.toBeNull();
    expect(seen).toEqual([1]);
  });

  it("recovers on a later attempt and reports every attempt it made", async () => {
    const { attempt } = scripted([TRUNCATED, PROSE, MANIFEST]);
    const report = await runDesignWithRetry(attempt, { maxAttempts: 3 });
    expect(report.outcome).toBe("accepted");
    expect(report.attemptsMade).toBe(3);
    expect(report.diagnoses.map((d) => d.shape)).toEqual([
      "truncated_json",
      "no_json",
      "manifest_shaped_object",
    ]);
  });

  it("spends exactly one call on a wrong answer", async () => {
    const { attempt, seen } = scripted([FENCED_ARRAY, MANIFEST]);
    const report = await runDesignWithRetry(attempt, { maxAttempts: 5 });
    expect(report.outcome).toBe("failed");
    expect(report.stopReason).toBe("wrong_question");
    expect(report.attemptsMade).toBe(1);
    expect(seen).toEqual([1]);
  });

  it("stops at the attempt limit on a retriable failure", async () => {
    const { attempt, seen } = scripted([TRUNCATED, TRUNCATED, TRUNCATED, MANIFEST]);
    const report = await runDesignWithRetry(attempt, { maxAttempts: 3 });
    expect(report.outcome).toBe("failed");
    expect(report.stopReason).toBe("attempts_exhausted");
    expect(report.attemptsMade).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("defaults to three attempts", async () => {
    const { seen, attempt } = scripted([TRUNCATED, TRUNCATED, TRUNCATED, TRUNCATED]);
    const report = await runDesignWithRetry(attempt);
    expect(report.attemptsMade).toBe(DEFAULT_DESIGN_MAX_ATTEMPTS);
    expect(seen.length).toBe(DEFAULT_DESIGN_MAX_ATTEMPTS);
  });

  it("accumulates each attempt's real cost and stops when the shared ceiling is spent", async () => {
    // Each attempt really costs $0.009 against a $0.02 ceiling, and the next one is estimated
    // at $0.0018 — so three calls fit and the fourth has no ceiling left to be priced against.
    const smallCost = { pricing: PAID, promptChars: 350, maxOutputTokens: 100 } as const;
    const { attempt, seen } = scripted([TRUNCATED, TRUNCATED, TRUNCATED, TRUNCATED], 0.009);
    const report = await runDesignWithRetry(attempt, {
      maxAttempts: 10,
      ceiling: { maxDollars: 0.02 },
      attemptCost: smallCost,
    });
    expect(report.outcome).toBe("failed");
    expect(report.stopReason).toBe("budget_exhausted");
    expect(report.spentDollars).toBeCloseTo(0.027, 10);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("a retry sequence cannot spend more than the per-request ceiling plus one attempt", async () => {
    const { attempt } = scripted(Array.from({ length: 20 }, () => TRUNCATED), 0.004);
    const report = await runDesignWithRetry(attempt, {
      maxAttempts: 20,
      ceiling: { maxDollars: 0.02 },
      attemptCost: { pricing: PAID, promptChars: 350, maxOutputTokens: 100 },
    });
    expect(report.stopReason).toBe("budget_exhausted");
    expect(report.spentDollars).toBeLessThanOrEqual(0.02 + 0.004);
  });

  it("ignores a non-finite or negative reported cost rather than corrupting the total", async () => {
    const attempt = async (n: number): Promise<DesignAttemptOutcome> => ({
      text: n < 2 ? TRUNCATED : MANIFEST,
      actualDollars: n === 1 ? Number.NaN : -5,
    });
    const report = await runDesignWithRetry(attempt, { maxAttempts: 3 });
    expect(report.outcome).toBe("accepted");
    expect(report.spentDollars).toBe(0);
  });

  it("prices a growing prompt through nextAttemptCost", async () => {
    const seenAttempts: number[] = [];
    const { attempt } = scripted([TRUNCATED, TRUNCATED, MANIFEST]);
    const report = await runDesignWithRetry(attempt, {
      maxAttempts: 3,
      ceiling: { maxDollars: 1 },
      nextAttemptCost: (n) => {
        seenAttempts.push(n);
        return { pricing: PAID, promptChars: 3500 * n, maxOutputTokens: 1000 };
      },
    });
    expect(report.outcome).toBe("accepted");
    expect(seenAttempts).toEqual([2, 3]);
  });

  it("honours a custom recognizer, so a non-manifest target is not a wrong question", async () => {
    const { attempt } = scripted(['{"widgets":[]}']);
    const report = await runDesignWithRetry(attempt, {
      classify: { recognize: (o) => o["widgets"] !== undefined },
    });
    expect(report.outcome).toBe("accepted");
  });

  it("does not catch a throw from the attempt: a transport failure is not a design output", async () => {
    let calls = 0;
    const attempt = async (): Promise<DesignAttemptOutcome> => {
      calls += 1;
      throw new Error("socket hang up");
    };
    await expect(runDesignWithRetry(attempt, { maxAttempts: 3 })).rejects.toThrow(/socket hang up/);
    expect(calls).toBe(1);
  });

  /**
   * The same loop over a real `LlmProvider`, which is what `operate-server` will hand it: the
   * attempt function drains a stream, prices it, and hands back the text. Offline — a mock
   * provider, no clock, no network.
   */
  const providerAttempt = (
    replies: readonly string[],
    costs: readonly number[] = [],
  ): ((n: number) => Promise<DesignAttemptOutcome>) => {
    let turn = 0;
    const provider = new MockLlmProvider({
      pricing: PAID,
      completeBehavior: () => {
        const reply = replies[turn] ?? "";
        const spent = costs[turn] ?? 0;
        turn += 1;
        return (async function* (): AsyncIterable<CompletionChunk> {
          yield { kind: "text", text: reply };
          yield { kind: "usage_final", usage: { inputTokens: 100, outputTokens: 50, cost: spent } };
        })();
      },
    });
    return async (): Promise<DesignAttemptOutcome> => {
      let text = "";
      let actualDollars = 0;
      for await (const chunk of provider.complete({
        task: "planner",
        messages: [{ role: "user", content: "design me an ERP" }],
        maxTokens: 1000,
        tenantId: "t",
        sessionId: "s",
      })) {
        if (chunk.kind === "text") text += chunk.text;
        if (chunk.kind === "usage_final") actualDollars = chunk.usage.cost;
      }
      return { text, actualDollars };
    };
  };

  it("drives a real provider stream and recovers a drifting model on a later attempt", async () => {
    const report = await runDesignWithRetry(providerAttempt([PROSE, TRUNCATED, MANIFEST]), {
      maxAttempts: 3,
    });
    expect(report.outcome).toBe("accepted");
    expect(report.attemptsMade).toBe(3);
    expect(report.diagnoses.map((d) => d.shape)).toEqual([
      "no_json",
      "truncated_json",
      "manifest_shaped_object",
    ]);
  });

  it("does not pay a provider twice for the same wrong answer", async () => {
    const report = await runDesignWithRetry(providerAttempt([FENCED_ARRAY, MANIFEST], [0.02, 0.02]), {
      maxAttempts: 3,
    });
    expect(report.outcome).toBe("failed");
    expect(report.stopReason).toBe("wrong_question");
    expect(report.attemptsMade).toBe(1);
    expect(report.spentDollars).toBeCloseTo(0.02, 10);
  });

  it("reports attemptsMade on every outcome, never leaving it to be inferred", async () => {
    const accepted = await runDesignWithRetry(scripted([MANIFEST]).attempt);
    const wrong = await runDesignWithRetry(scripted([FENCED_ARRAY]).attempt);
    const exhausted = await runDesignWithRetry(scripted([TRUNCATED, TRUNCATED, TRUNCATED]).attempt);
    for (const r of [accepted, wrong, exhausted]) {
      expect(r.attemptsMade).toBeGreaterThan(0);
      expect(r.diagnoses.length).toBe(r.attemptsMade);
    }
  });
});
