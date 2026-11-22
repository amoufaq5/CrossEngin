import { describe, expect, it } from "vitest";

import {
  AI_MAX_OUTPUT_TOKENS_VAR,
  AI_MODEL_SOURCES,
  AI_MODEL_VAR,
  AI_PROVIDER_TIMEOUT_VAR,
  AiSettingInvalid,
  aiModelLine,
  aiSettingSource,
  parseAiMaxOutputTokens,
  parseAiProviderTimeoutMs,
  resolveAiModel,
  resolveAiSetting,
  type AiModelSource,
} from "./ai-model-source.js";

const MODEL = "qwen2.5:14b-instruct";
const OTHER = "llama3.1:70b";

describe("resolveAiModel", () => {
  it("takes the flag when only the flag names one", () => {
    expect(resolveAiModel(MODEL, {})).toEqual({ model: MODEL, source: "argv", ignored: null });
  });

  it("takes the variable when only the variable names one", () => {
    expect(resolveAiModel(null, { [AI_MODEL_VAR]: MODEL })).toEqual({
      model: MODEL,
      source: "env",
      ignored: null,
    });
  });

  it("prefers the flag and keeps what it ignored", () => {
    // An explicit argument outranks an ambient default, and the loser is carried so the boot line
    // can name it -- a deployment with both on file and no sentence about it is one where editing
    // the wrong one looks like the setting having no effect.
    expect(resolveAiModel(MODEL, { [AI_MODEL_VAR]: OTHER })).toEqual({
      model: MODEL,
      source: "both",
      ignored: OTHER,
    });
  });

  it("answers none when neither names one", () => {
    expect(resolveAiModel(null, {})).toEqual({ model: null, source: "none", ignored: null });
  });

  it("reads an empty or whitespace value as absent on BOTH routes", () => {
    // Load-bearing for the environment route specifically: `docker-compose.yml` writes
    // `${OPERATE_AI_MODEL:-}`, so an unset variable arrives as the empty string rather than as
    // undefined -- and an empty model name would be sent to the provider as a request for a model
    // called "".
    expect(resolveAiModel(null, { [AI_MODEL_VAR]: "" }).source).toBe("none");
    expect(resolveAiModel(null, { [AI_MODEL_VAR]: "   " }).source).toBe("none");
    expect(resolveAiModel("", {}).source).toBe("none");
    expect(resolveAiModel("  ", { [AI_MODEL_VAR]: MODEL })).toEqual({
      model: MODEL,
      source: "env",
      ignored: null,
    });
  });

  it("trims a value rather than passing the padding through", () => {
    expect(resolveAiModel(` ${MODEL} `, {}).model).toBe(MODEL);
    expect(resolveAiModel(null, { [AI_MODEL_VAR]: `\t${MODEL}\n` }).model).toBe(MODEL);
  });

  it("ignores an undefined variable", () => {
    expect(resolveAiModel(null, { [AI_MODEL_VAR]: undefined }).source).toBe("none");
  });
});

describe("aiModelLine", () => {
  it("names a source for every member of the enum", () => {
    // Derived from the enum rather than four hand-written cases, so a fifth source cannot be added
    // with no sentence -- which is the shape that leaves an operator with no line to read.
    for (const source of AI_MODEL_SOURCES) {
      const line = aiModelLine({ model: MODEL, source, ignored: OTHER });
      expect(line.startsWith("[ai-design] model:")).toBe(true);
      expect(line.length).toBeGreaterThan(24);
    }
  });

  it("names the route in each of the three naming cases", () => {
    expect(aiModelLine(resolveAiModel(MODEL, {}))).toContain("--ai-model");
    expect(aiModelLine(resolveAiModel(null, { [AI_MODEL_VAR]: MODEL }))).toContain(AI_MODEL_VAR);
    const both = aiModelLine(resolveAiModel(MODEL, { [AI_MODEL_VAR]: OTHER }));
    expect(both).toContain(MODEL);
    expect(both).toContain(OTHER);
    expect(both).toContain("ignored");
  });

  it("says so affirmatively when nothing named a model", () => {
    // "We checked and found nothing" cannot be claimed from the absence of a log line, which is
    // this binary's rule for every other boot survey.
    const line = aiModelLine(resolveAiModel(null, {}));
    expect(line).toContain("not named");
    expect(line).toContain(AI_MODEL_VAR);
    expect(line).toContain("default");
  });

  it("puts no value in the line when none was named", () => {
    expect(aiModelLine(resolveAiModel(null, {}))).not.toContain(MODEL);
  });
});

describe("the overlay this exists for", () => {
  it("is covered by a source for each way the two compose files can disagree", () => {
    // The reason this module exists is that `docker-compose.ai.yml` had to repeat the entire `api`
    // command to add one flag, and the copy drifted ten flags behind. The four sources are exactly
    // the four states that pair can be in, so a reader of a boot line can always tell which file
    // won.
    const sources = new Set<AiModelSource>(
      [
        resolveAiModel(null, {}),
        resolveAiModel(MODEL, {}),
        resolveAiModel(null, { [AI_MODEL_VAR]: MODEL }),
        resolveAiModel(MODEL, { [AI_MODEL_VAR]: OTHER }),
      ].map((r) => r.source),
    );
    expect([...sources].sort()).toEqual([...AI_MODEL_SOURCES].sort());
  });
});

describe("resolveAiSetting — the price, output budget and timeout environment routes", () => {
  it("reads absent, env, argv and both, and treats an empty variable as absent", () => {
    const parse = (raw: string, route: string) => parseAiMaxOutputTokens(raw, route);
    expect(resolveAiSetting(null, {}, AI_MAX_OUTPUT_TOKENS_VAR, parse)).toEqual({ value: null, source: "none", ignored: null });
    expect(resolveAiSetting(null, { [AI_MAX_OUTPUT_TOKENS_VAR]: "  " }, AI_MAX_OUTPUT_TOKENS_VAR, parse).source).toBe("none");
    expect(resolveAiSetting(null, { [AI_MAX_OUTPUT_TOKENS_VAR]: "4096" }, AI_MAX_OUTPUT_TOKENS_VAR, parse)).toEqual({
      value: 4096,
      source: "env",
      ignored: null,
    });
    expect(resolveAiSetting(2048, {}, AI_MAX_OUTPUT_TOKENS_VAR, parse)).toEqual({ value: 2048, source: "argv", ignored: null });
    const both = resolveAiSetting(2048, { [AI_MAX_OUTPUT_TOKENS_VAR]: "4096" }, AI_MAX_OUTPUT_TOKENS_VAR, parse);
    expect(both).toEqual({ value: 2048, source: "both", ignored: "4096" });
    expect(aiSettingSource(both, "--ai-max-output-tokens", AI_MAX_OUTPUT_TOKENS_VAR)).toContain(
      `${AI_MAX_OUTPUT_TOKENS_VAR}=4096 is ignored`,
    );
  });

  it("refuses a malformed variable by name even when the flag would win", () => {
    expect(() =>
      resolveAiSetting(2048, { [AI_MAX_OUTPUT_TOKENS_VAR]: "lots" }, AI_MAX_OUTPUT_TOKENS_VAR, parseAiMaxOutputTokens),
    ).toThrow(new RegExp(`invalid ${AI_MAX_OUTPUT_TOKENS_VAR}: lots`));
    expect(() =>
      resolveAiSetting(null, { [AI_PROVIDER_TIMEOUT_VAR]: "999" }, AI_PROVIDER_TIMEOUT_VAR, parseAiProviderTimeoutMs),
    ).toThrow(AiSettingInvalid);
  });

  it("bounds the output budget at 1024..32768 and the timeout at 1000..3600000", () => {
    expect(parseAiMaxOutputTokens("1024", "x")).toBe(1024);
    expect(parseAiMaxOutputTokens("32768", "x")).toBe(32_768);
    expect(() => parseAiMaxOutputTokens("1023", "x")).toThrow(AiSettingInvalid);
    expect(() => parseAiMaxOutputTokens("32769", "x")).toThrow(AiSettingInvalid);
    expect(() => parseAiMaxOutputTokens("4096.5", "x")).toThrow(AiSettingInvalid);
    expect(parseAiProviderTimeoutMs("900000", "x")).toBe(900_000);
    expect(() => parseAiProviderTimeoutMs("3600001", "x")).toThrow(AiSettingInvalid);
  });
});
