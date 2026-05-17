import { describe, expect, it } from "vitest";

import {
  DEFAULT_TASK_POLICIES,
  NoProvidersConfiguredError,
  buildChatCompleter,
} from "./router-setup.js";

describe("DEFAULT_TASK_POLICIES", () => {
  it("covers the seven TaskKind values", () => {
    expect(Object.keys(DEFAULT_TASK_POLICIES).sort()).toEqual([
      "classifier",
      "diff-narrator",
      "embedding",
      "executor",
      "planner",
      "rerank",
      "summarizer",
    ]);
  });

  it("routes executor to Claude sonnet primary, OpenAI mini fallback", () => {
    expect(DEFAULT_TASK_POLICIES["executor"]?.primary).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(DEFAULT_TASK_POLICIES["executor"]?.fallback).toContain(
      "openai/gpt-4o-mini",
    );
  });

  it("routes embeddings to OpenAI text-embedding-3-small (Anthropic has no embeddings)", () => {
    expect(DEFAULT_TASK_POLICIES["embedding"]?.primary).toBe(
      "openai/text-embedding-3-small",
    );
    expect(DEFAULT_TASK_POLICIES["embedding"]?.fallback).toEqual([]);
  });

  it("routes cheap tasks (summarizer / classifier) to OpenAI gpt-4o-mini primary", () => {
    expect(DEFAULT_TASK_POLICIES["summarizer"]?.primary).toBe(
      "openai/gpt-4o-mini",
    );
    expect(DEFAULT_TASK_POLICIES["classifier"]?.primary).toBe(
      "openai/gpt-4o-mini",
    );
  });
});

describe("buildChatCompleter", () => {
  it("returns a single AnthropicProvider when only ANTHROPIC_API_KEY is set", () => {
    const out = buildChatCompleter({ env: { ANTHROPIC_API_KEY: "sk-ant-x" } });
    expect(out.providerKind).toBe("single");
    expect(out.availableProviders).toEqual(["anthropic"]);
    expect(out.provider.id).toBe("anthropic");
  });

  it("returns a single OpenAIProvider when only OPENAI_API_KEY is set", () => {
    const out = buildChatCompleter({ env: { OPENAI_API_KEY: "sk-oai-x" } });
    expect(out.providerKind).toBe("single");
    expect(out.availableProviders).toEqual(["openai"]);
    expect(out.provider.id).toBe("openai");
  });

  it("returns a router-wrapped provider when both keys are set", () => {
    const out = buildChatCompleter({
      env: { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-oai-x" },
    });
    expect(out.providerKind).toBe("router");
    expect(out.availableProviders).toEqual(["anthropic", "openai"]);
    expect(out.provider.id).toBe("router");
    expect(out.provider.capabilities.embedding).toBe(true);
    expect(out.provider.capabilities.supportsThinking).toBe(true);
  });

  it("throws NoProvidersConfiguredError when neither key is set", () => {
    expect(() => buildChatCompleter({ env: {} })).toThrow(
      NoProvidersConfiguredError,
    );
  });

  it("threads forceModel into the matching provider default", () => {
    const out = buildChatCompleter({
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
      forceModel: "claude-opus-4-7",
    });
    expect(out.provider.id).toBe("anthropic");
    expect(out.provider.models).toContain("claude-opus-4-7");
  });

  it("router exposes the union of both providers' model lists", () => {
    const out = buildChatCompleter({
      env: { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-oai-x" },
    });
    expect(out.provider.models).toContain("claude-sonnet-4-6");
    expect(out.provider.models).toContain("gpt-4o-mini");
    expect(out.provider.models).toContain("text-embedding-3-small");
  });
});
