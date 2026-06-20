import { AnthropicProvider } from "@crossengin/ai-providers-anthropic";
import { LocalLlmProvider } from "@crossengin/ai-providers-local";
import { OpenAiProvider } from "@crossengin/ai-providers-openai";
import { DefaultLlmRouter } from "@crossengin/ai-router";
import type { CompletionRequest, CompletionChunk } from "@crossengin/ai-providers";
import { describe, expect, it } from "vitest";
import { buildChatProvider, DEFAULT_CHAT_OPENAI_MODEL, type RunContext } from "./commands.js";

function ctx(env: NodeJS.ProcessEnv, providerOverride?: RunContext["providerOverride"]): RunContext {
  return {
    io: { stdout: { write: () => {} }, stderr: { write: () => {} } },
    env,
    providerOverride,
  };
}

const opts = { model: "claude-sonnet-4-6" as const, openaiModel: DEFAULT_CHAT_OPENAI_MODEL, choice: "auto" };

describe("buildChatProvider", () => {
  it("returns the providerOverride when set (test seam)", () => {
    const stub = {
      // eslint-disable-next-line require-yield
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        return;
      },
    };
    const built = buildChatProvider(ctx({}, stub as RunContext["providerOverride"]), opts);
    expect("provider" in built && built.provider).toBe(stub);
  });

  it("builds a multi-vendor router when both API keys are present (auto)", () => {
    const built = buildChatProvider(
      ctx({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" }),
      opts,
    );
    expect("provider" in built && built.provider).toBeInstanceOf(DefaultLlmRouter);
  });

  it("falls back to a single Anthropic provider when only its key is present", () => {
    const built = buildChatProvider(ctx({ ANTHROPIC_API_KEY: "sk-ant" }), opts);
    expect("provider" in built && built.provider).toBeInstanceOf(AnthropicProvider);
  });

  it("falls back to a single OpenAI provider when only its key is present", () => {
    const built = buildChatProvider(ctx({ OPENAI_API_KEY: "sk-oai" }), opts);
    expect("provider" in built && built.provider).toBeInstanceOf(OpenAiProvider);
  });

  it("errors when no API key is available", () => {
    const built = buildChatProvider(ctx({}), opts);
    expect("error" in built && built.code).toBe(1);
  });

  it("forces Anthropic with --provider anthropic and errors without its key", () => {
    expect(buildChatProvider(ctx({ OPENAI_API_KEY: "sk-oai" }), { ...opts, choice: "anthropic" })).toMatchObject({
      code: 1,
    });
    expect(
      "provider" in buildChatProvider(ctx({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" }), {
        ...opts,
        choice: "anthropic",
      }),
    ).toBe(true);
  });

  it("forces OpenAI with --provider openai even when both keys are present", () => {
    const built = buildChatProvider(ctx({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" }), {
      ...opts,
      choice: "openai",
    });
    expect("provider" in built && built.provider).toBeInstanceOf(OpenAiProvider);
  });

  it("labels single-provider turns with provider/model", () => {
    const anthropic = buildChatProvider(ctx({ ANTHROPIC_API_KEY: "sk-ant" }), opts);
    expect("describeLastTurn" in anthropic && anthropic.describeLastTurn()).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    const openai = buildChatProvider(ctx({ OPENAI_API_KEY: "sk-oai" }), { ...opts, choice: "openai" });
    expect("describeLastTurn" in openai && openai.describeLastTurn()).toBe("openai/gpt-4o");
  });

  it("labels the router as null until a turn resolves", () => {
    const built = buildChatProvider(ctx({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" }), opts);
    expect("describeLastTurn" in built && built.describeLastTurn()).toBeNull();
  });

  it("builds a local provider with --provider local and needs no API key", () => {
    const built = buildChatProvider(ctx({}), { ...opts, choice: "local" });
    expect("provider" in built && built.provider).toBeInstanceOf(LocalLlmProvider);
    expect("describeLastTurn" in built && built.describeLastTurn()).toBe("local/llama3.1");
  });

  it("honors --local-model for the local provider label", () => {
    const built = buildChatProvider(ctx({}), {
      ...opts,
      choice: "local",
      localModel: "qwen2.5",
    });
    expect("describeLastTurn" in built && built.describeLastTurn()).toBe("local/qwen2.5");
  });
});
