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
    expect(DEFAULT_TASK_POLICIES["executor"]?.primary).toBe("anthropic/claude-sonnet-4-6");
    expect(DEFAULT_TASK_POLICIES["executor"]?.fallback).toContain("openai/gpt-4o-mini");
  });

  it("routes embeddings to OpenAI primary with Bedrock Titan v2 as fallback", () => {
    expect(DEFAULT_TASK_POLICIES["embedding"]?.primary).toBe("openai/text-embedding-3-small");
    expect(DEFAULT_TASK_POLICIES["embedding"]?.fallback).toEqual([
      "bedrock/amazon.titan-embed-text-v2:0",
    ]);
  });

  it("routes cheap tasks (summarizer / classifier) to OpenAI gpt-4o-mini primary", () => {
    expect(DEFAULT_TASK_POLICIES["summarizer"]?.primary).toBe("openai/gpt-4o-mini");
    expect(DEFAULT_TASK_POLICIES["classifier"]?.primary).toBe("openai/gpt-4o-mini");
  });

  it("every task fallback chain ends with a Bedrock entry (third control plane)", () => {
    for (const [task, policy] of Object.entries(DEFAULT_TASK_POLICIES)) {
      const allRefs = [policy.primary, ...policy.fallback];
      const hasBedrock = allRefs.some((r) => r.startsWith("bedrock/"));
      expect(hasBedrock, `task '${task}' missing Bedrock fallback`).toBe(true);
    }
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

  it("returns a single BedrockProvider when only AWS credentials are set", () => {
    const out = buildChatCompleter({
      env: {
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret/secret",
      },
    });
    expect(out.providerKind).toBe("single");
    expect(out.availableProviders).toEqual(["bedrock"]);
    expect(out.provider.id).toBe("bedrock");
  });

  it("returns a router when both Anthropic + OpenAI keys are set (no AWS)", () => {
    const out = buildChatCompleter({
      env: { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-oai-x" },
    });
    expect(out.providerKind).toBe("router");
    expect(out.availableProviders).toEqual(["anthropic", "openai"]);
    expect(out.provider.id).toBe("router");
    expect(out.provider.capabilities.embedding).toBe(true);
    expect(out.provider.capabilities.supportsThinking).toBe(true);
  });

  it("returns a 3-provider router when ANTHROPIC + OPENAI + AWS are all set", () => {
    const out = buildChatCompleter({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-x",
        OPENAI_API_KEY: "sk-oai-x",
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret/secret",
      },
    });
    expect(out.providerKind).toBe("router");
    expect(out.availableProviders).toEqual(["anthropic", "openai", "bedrock"]);
    expect(out.provider.models).toContain("claude-sonnet-4-6");
    expect(out.provider.models).toContain("gpt-4o-mini");
    expect(out.provider.models).toContain("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(out.provider.models).toContain("amazon.titan-embed-text-v2:0");
  });

  it("returns a 2-provider router when only Anthropic + AWS are set", () => {
    const out = buildChatCompleter({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-x",
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret/secret",
      },
    });
    expect(out.providerKind).toBe("router");
    expect(out.availableProviders).toEqual(["anthropic", "bedrock"]);
  });

  it("ignores AWS_ACCESS_KEY_ID alone without AWS_SECRET_ACCESS_KEY", () => {
    expect(() => buildChatCompleter({ env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE" } })).toThrow(
      NoProvidersConfiguredError,
    );
  });

  it("ignores AWS_SECRET_ACCESS_KEY alone without AWS_ACCESS_KEY_ID", () => {
    expect(() => buildChatCompleter({ env: { AWS_SECRET_ACCESS_KEY: "secret/secret" } })).toThrow(
      NoProvidersConfiguredError,
    );
  });

  it("throws NoProvidersConfiguredError when no credentials are set", () => {
    expect(() => buildChatCompleter({ env: {} })).toThrow(NoProvidersConfiguredError);
  });

  it("error message mentions all three provider environment variables", () => {
    try {
      buildChatCompleter({ env: {} });
      throw new Error("should have thrown");
    } catch (err) {
      if (!(err instanceof NoProvidersConfiguredError)) throw err;
      expect(err.message).toContain("ANTHROPIC_API_KEY");
      expect(err.message).toContain("OPENAI_API_KEY");
      expect(err.message).toContain("AWS_ACCESS_KEY_ID");
    }
  });

  it("threads forceModel into the matching provider default", () => {
    const out = buildChatCompleter({
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
      forceModel: "claude-opus-4-7",
    });
    expect(out.provider.id).toBe("anthropic");
    expect(out.provider.models).toContain("claude-opus-4-7");
  });

  it("threads a Bedrock forceModel into the Bedrock provider default", () => {
    const out = buildChatCompleter({
      env: {
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret/secret",
      },
      forceModel: "anthropic.claude-3-5-haiku-20241022-v1:0",
    });
    expect(out.provider.id).toBe("bedrock");
    expect(out.provider.models).toContain("anthropic.claude-3-5-haiku-20241022-v1:0");
  });

  it("router exposes the union of all configured providers' model lists", () => {
    const out = buildChatCompleter({
      env: { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-oai-x" },
    });
    expect(out.provider.models).toContain("claude-sonnet-4-6");
    expect(out.provider.models).toContain("gpt-4o-mini");
    expect(out.provider.models).toContain("text-embedding-3-small");
  });

  it("honours AWS_SESSION_TOKEN + AWS_REGION when present", () => {
    const out = buildChatCompleter({
      env: {
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret/secret",
        AWS_SESSION_TOKEN: "tok-123",
        AWS_REGION: "eu-west-1",
      },
    });
    expect(out.provider.id).toBe("bedrock");
    // eu-west-1 derives residency to ["eu"]
    expect(out.provider.residency).toEqual(["eu"]);
  });

  it("falls back to AWS_DEFAULT_REGION when AWS_REGION is unset", () => {
    const out = buildChatCompleter({
      env: {
        AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "secret/secret",
        AWS_DEFAULT_REGION: "ap-southeast-1",
      },
    });
    expect(out.provider.residency).toEqual(["ap"]);
  });
});
