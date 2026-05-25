import { describe, expect, it } from "vitest";

import {
  approximateTokenCount,
  bedrockEmbeddingFamily,
  buildCohereEmbedRequest,
  buildEmbeddingResponse,
  buildTitanEmbedRequest,
  buildTitanMultimodalRequest,
  COHERE_MAX_BATCH_SIZE,
  parseCohereEmbedResponse,
  parseTitanEmbedResponse,
  parseTitanMultimodalResponse,
  TITAN_MULTIMODAL_DEFAULT_DIMENSIONS,
  TITAN_MULTIMODAL_VALID_DIMENSIONS,
  TITAN_V2_DEFAULT_DIMENSIONS,
} from "./embeddings.js";
import { BedrockError } from "./errors.js";

describe("bedrockEmbeddingFamily", () => {
  it("classifies titan-embed-text-v2 as titan", () => {
    expect(bedrockEmbeddingFamily("amazon.titan-embed-text-v2:0")).toBe("titan");
  });

  it("classifies titan-embed-text-v1 as titan", () => {
    expect(bedrockEmbeddingFamily("amazon.titan-embed-text-v1")).toBe("titan");
  });

  it("classifies cohere.embed-english-v3 as cohere", () => {
    expect(bedrockEmbeddingFamily("cohere.embed-english-v3")).toBe("cohere");
  });

  it("classifies cohere.embed-multilingual-v3 as cohere", () => {
    expect(bedrockEmbeddingFamily("cohere.embed-multilingual-v3")).toBe("cohere");
  });
});

describe("buildTitanEmbedRequest", () => {
  it("titan-embed-text-v2 defaults to 1024 dimensions + normalize=true", () => {
    const req = buildTitanEmbedRequest({
      model: "amazon.titan-embed-text-v2:0",
      text: "hello",
    });
    expect(req).toEqual({
      inputText: "hello",
      dimensions: TITAN_V2_DEFAULT_DIMENSIONS,
      normalize: true,
    });
  });

  it("titan-embed-text-v2 accepts 256 / 512 / 1024 dimensions", () => {
    for (const dim of [256, 512, 1024]) {
      const req = buildTitanEmbedRequest({
        model: "amazon.titan-embed-text-v2:0",
        text: "x",
        dimensions: dim,
      });
      expect(req.dimensions).toBe(dim);
    }
  });

  it("titan-embed-text-v2 rejects non-supported dimensions", () => {
    expect(() =>
      buildTitanEmbedRequest({
        model: "amazon.titan-embed-text-v2:0",
        text: "x",
        dimensions: 768,
      }),
    ).toThrow(BedrockError);
  });

  it("titan-embed-text-v1 emits only inputText (no dimensions)", () => {
    const req = buildTitanEmbedRequest({
      model: "amazon.titan-embed-text-v1",
      text: "legacy",
    });
    expect(req).toEqual({ inputText: "legacy" });
  });
});

describe("buildCohereEmbedRequest", () => {
  it("defaults input_type to search_document", () => {
    const req = buildCohereEmbedRequest({ texts: ["a"] });
    expect(req.input_type).toBe("search_document");
  });

  it("threads a custom input_type", () => {
    const req = buildCohereEmbedRequest({
      texts: ["q"],
      inputType: "search_query",
    });
    expect(req.input_type).toBe("search_query");
  });

  it("rejects empty texts", () => {
    expect(() => buildCohereEmbedRequest({ texts: [] })).toThrow(BedrockError);
  });

  it(`rejects batches > ${COHERE_MAX_BATCH_SIZE.toString()}`, () => {
    const tooMany = new Array(COHERE_MAX_BATCH_SIZE + 1).fill("x");
    expect(() => buildCohereEmbedRequest({ texts: tooMany })).toThrow(BedrockError);
  });

  it("preserves the texts order", () => {
    const req = buildCohereEmbedRequest({ texts: ["c", "b", "a"] });
    expect(req.texts).toEqual(["c", "b", "a"]);
  });
});

describe("parseTitanEmbedResponse", () => {
  it("returns embedding + token count", () => {
    const parsed = parseTitanEmbedResponse({
      embedding: [0.1, 0.2],
      inputTextTokenCount: 3,
    });
    expect(parsed.embedding).toEqual([0.1, 0.2]);
    expect(parsed.inputTextTokenCount).toBe(3);
  });

  it("defaults inputTextTokenCount to 0 when missing", () => {
    const parsed = parseTitanEmbedResponse({ embedding: [0.5] });
    expect(parsed.inputTextTokenCount).toBe(0);
  });

  it("throws when embedding array is missing", () => {
    expect(() => parseTitanEmbedResponse({})).toThrow(BedrockError);
    expect(() => parseTitanEmbedResponse({ embedding: "not-an-array" })).toThrow(BedrockError);
  });

  it("throws on null payload", () => {
    expect(() => parseTitanEmbedResponse(null)).toThrow(BedrockError);
  });
});

describe("parseCohereEmbedResponse", () => {
  it("returns embeddings + meta.billed_units when present", () => {
    const parsed = parseCohereEmbedResponse({
      id: "abc",
      embeddings: [[0.1, 0.2]],
      texts: ["x"],
      response_type: "embeddings_floats",
      meta: { billed_units: { input_tokens: 5 } },
    });
    expect(parsed.embeddings).toEqual([[0.1, 0.2]]);
    expect(parsed.meta?.billed_units?.input_tokens).toBe(5);
  });

  it("throws when embeddings array is missing", () => {
    expect(() => parseCohereEmbedResponse({ id: "x" })).toThrow(BedrockError);
  });

  it("survives missing optional fields (id, texts, response_type, meta)", () => {
    const parsed = parseCohereEmbedResponse({ embeddings: [[0.1]] });
    expect(parsed.id).toBe("");
    expect(parsed.texts).toEqual([]);
    expect(parsed.response_type).toBeUndefined();
    expect(parsed.meta).toBeUndefined();
  });
});

describe("buildEmbeddingResponse", () => {
  it("rounds cost to 6 decimals + computes dim from vectors", () => {
    const result = buildEmbeddingResponse({
      model: "amazon.titan-embed-text-v2:0",
      aggregation: {
        vectors: [[0.1, 0.2, 0.3]],
        dim: 3,
        inputTokens: 1,
      },
    });
    expect(result.dim).toBe(3);
    expect(result.model).toBe("amazon.titan-embed-text-v2:0");
    expect(result.usage.inputTokens).toBe(1);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.cost).toBe(Number(((1 * 0.02) / 1_000_000).toFixed(6)));
  });

  it("deep-copies vectors so the caller can't mutate the response", () => {
    const original: number[][] = [[1, 2, 3]];
    const result = buildEmbeddingResponse({
      model: "cohere.embed-english-v3",
      aggregation: {
        vectors: original,
        dim: 3,
        inputTokens: 10,
      },
    });
    original[0]![0] = 999;
    expect(result.vectors[0]).toEqual([1, 2, 3]);
  });
});

describe("approximateTokenCount", () => {
  it("returns 0 for empty string", () => {
    expect(approximateTokenCount("")).toBe(0);
  });

  it("returns 1 for single character", () => {
    expect(approximateTokenCount("x")).toBe(1);
  });

  it("approximates 1 token per 4 characters", () => {
    expect(approximateTokenCount("12345678")).toBe(2);
    expect(approximateTokenCount("123456789")).toBe(3);
  });
});

describe("buildTitanMultimodalRequest (M2.9.7)", () => {
  it("text-only: emits {inputText, embeddingConfig} with default 1024 dimensions", () => {
    const req = buildTitanMultimodalRequest({ text: "hello world" });
    expect(req).toEqual({
      inputText: "hello world",
      embeddingConfig: { outputEmbeddingLength: TITAN_MULTIMODAL_DEFAULT_DIMENSIONS },
    });
    expect(req.inputImage).toBeUndefined();
  });

  it("image-only: emits {inputImage, embeddingConfig}", () => {
    const req = buildTitanMultimodalRequest({ imageBase64: "iVBORw0KGgo..." });
    expect(req).toEqual({
      inputImage: "iVBORw0KGgo...",
      embeddingConfig: { outputEmbeddingLength: 1024 },
    });
    expect(req.inputText).toBeUndefined();
  });

  it("text + image: emits both fields", () => {
    const req = buildTitanMultimodalRequest({
      text: "a cat",
      imageBase64: "iVBORw0KGgo...",
    });
    expect(req.inputText).toBe("a cat");
    expect(req.inputImage).toBe("iVBORw0KGgo...");
  });

  it("accepts 256/384/1024 dimensions", () => {
    for (const dim of TITAN_MULTIMODAL_VALID_DIMENSIONS) {
      const req = buildTitanMultimodalRequest({ text: "x", dimensions: dim });
      expect(req.embeddingConfig?.outputEmbeddingLength).toBe(dim);
    }
  });

  it("rejects invalid dimensions", () => {
    expect(() => buildTitanMultimodalRequest({ text: "x", dimensions: 512 })).toThrow(BedrockError);
    expect(() => buildTitanMultimodalRequest({ text: "x", dimensions: 768 })).toThrow(BedrockError);
  });

  it("rejects empty input (neither text nor image)", () => {
    expect(() => buildTitanMultimodalRequest({})).toThrow(BedrockError);
  });

  it("rejects empty text and empty image strings as no input", () => {
    expect(() => buildTitanMultimodalRequest({ text: "", imageBase64: "" })).toThrow(BedrockError);
  });
});

describe("parseTitanMultimodalResponse", () => {
  it("returns embedding + token count + null message on success", () => {
    const parsed = parseTitanMultimodalResponse({
      embedding: [0.1, 0.2, 0.3],
      inputTextTokenCount: 5,
      message: null,
    });
    expect(parsed.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(parsed.inputTextTokenCount).toBe(5);
    expect(parsed.message).toBeNull();
  });

  it("captures error message when present", () => {
    const parsed = parseTitanMultimodalResponse({
      embedding: [],
      inputTextTokenCount: 0,
      message: "image too large",
    });
    expect(parsed.message).toBe("image too large");
  });

  it("defaults inputTextTokenCount to 0 when missing", () => {
    const parsed = parseTitanMultimodalResponse({ embedding: [0.1] });
    expect(parsed.inputTextTokenCount).toBe(0);
  });

  it("throws when embedding array is missing", () => {
    expect(() => parseTitanMultimodalResponse({})).toThrow(BedrockError);
    expect(() => parseTitanMultimodalResponse({ embedding: "not-an-array" })).toThrow(BedrockError);
  });

  it("throws on null payload", () => {
    expect(() => parseTitanMultimodalResponse(null)).toThrow(BedrockError);
  });
});
