import { describe, expect, it } from "vitest";
import {
  COMMON_CONTENT_TYPES,
  ContentNegotiationDecisionSchema,
  SUPPORTED_ENCODINGS,
  matchesMediaType,
  parseAcceptHeader,
  selectResponseContentType,
  selectResponseEncoding,
  selectResponseLanguage,
} from "./negotiation.js";

describe("constants", () => {
  it("has 10 common content types", () => {
    expect(COMMON_CONTENT_TYPES).toHaveLength(10);
  });
  it("has 5 supported encodings", () => {
    expect(SUPPORTED_ENCODINGS).toHaveLength(5);
  });
});

describe("parseAcceptHeader", () => {
  it("parses simple list with q values", () => {
    const entries = parseAcceptHeader(
      "application/json;q=0.9, application/xml;q=0.5",
    );
    expect(entries[0]?.mediaType).toBe("application/json");
    expect(entries[0]?.quality).toBe(0.9);
    expect(entries[1]?.quality).toBe(0.5);
  });

  it("defaults q to 1 when absent", () => {
    const entries = parseAcceptHeader("application/json");
    expect(entries[0]?.quality).toBe(1);
  });

  it("returns empty for null/empty", () => {
    expect(parseAcceptHeader(null)).toEqual([]);
    expect(parseAcceptHeader("")).toEqual([]);
  });

  it("parses parameters", () => {
    const entries = parseAcceptHeader(
      "application/vnd.cross+json; version=v2; charset=utf-8",
    );
    expect(entries[0]?.parameters.version).toBe("v2");
    expect(entries[0]?.parameters.charset).toBe("utf-8");
  });
});

describe("matchesMediaType", () => {
  it("matches exact", () => {
    expect(
      matchesMediaType("application/json", "application/json"),
    ).toBe(true);
  });
  it("matches */* wildcard", () => {
    expect(matchesMediaType("*/*", "application/json")).toBe(true);
  });
  it("matches type/*", () => {
    expect(matchesMediaType("application/*", "application/json")).toBe(true);
    expect(matchesMediaType("application/*", "text/csv")).toBe(false);
  });
  it("returns false for unrelated", () => {
    expect(matchesMediaType("application/json", "text/csv")).toBe(false);
  });
});

describe("selectResponseContentType", () => {
  it("picks highest-q supported offer", () => {
    expect(
      selectResponseContentType({
        acceptHeader: "application/xml;q=0.5, application/json;q=0.9",
        serverOffers: ["application/json", "text/csv"],
        defaultType: "application/json",
      }),
    ).toBe("application/json");
  });

  it("falls back to default when no offers match", () => {
    expect(
      selectResponseContentType({
        acceptHeader: null,
        serverOffers: ["application/json"],
        defaultType: "application/json",
      }),
    ).toBe("application/json");
  });

  it("returns null when client only accepts unsupported types", () => {
    expect(
      selectResponseContentType({
        acceptHeader: "image/png",
        serverOffers: ["application/json"],
        defaultType: "application/json",
      }),
    ).toBeNull();
  });

  it("skips q=0 entries", () => {
    expect(
      selectResponseContentType({
        acceptHeader: "application/xml;q=0, application/json",
        serverOffers: ["application/xml", "application/json"],
        defaultType: "application/json",
      }),
    ).toBe("application/json");
  });
});

describe("parseAcceptEncodingHeader / selectResponseEncoding", () => {
  it("defaults to identity when header absent", () => {
    expect(
      selectResponseEncoding({
        acceptEncodingHeader: null,
        serverSupports: ["gzip", "br"],
      }),
    ).toBe("identity");
  });

  it("picks highest-q supported encoding", () => {
    expect(
      selectResponseEncoding({
        acceptEncodingHeader: "gzip;q=0.5, br;q=0.9",
        serverSupports: ["gzip", "br"],
      }),
    ).toBe("br");
  });

  it("returns identity when no encoding matches", () => {
    expect(
      selectResponseEncoding({
        acceptEncodingHeader: "compress",
        serverSupports: ["gzip"],
      }),
    ).toBe("identity");
  });
});

describe("parseAcceptLanguageHeader / selectResponseLanguage", () => {
  it("picks highest-q matching language", () => {
    expect(
      selectResponseLanguage({
        acceptLanguageHeader: "fr;q=0.5, en-US;q=0.9",
        availableLanguages: ["en-US", "fr"],
        defaultLanguage: "en-US",
      }),
    ).toBe("en-US");
  });

  it("falls back to base tag (en for en-US)", () => {
    expect(
      selectResponseLanguage({
        acceptLanguageHeader: "es",
        availableLanguages: ["es-MX", "en-US"],
        defaultLanguage: "en-US",
      }),
    ).toBe("es-MX");
  });

  it("returns default when no match", () => {
    expect(
      selectResponseLanguage({
        acceptLanguageHeader: "zh-CN",
        availableLanguages: ["en-US"],
        defaultLanguage: "en-US",
      }),
    ).toBe("en-US");
  });
});

describe("ContentNegotiationDecisionSchema", () => {
  it("accepts a valid decision", () => {
    expect(() =>
      ContentNegotiationDecisionSchema.parse({
        requestContentType: "application/json",
        selectedResponseContentType: "application/json",
        selectedResponseEncoding: "gzip",
        selectedResponseLanguage: "en-US",
        acceptableLanguages: ["en-US", "fr"],
        requestContentTypeAccepted: true,
        rejectedReason: null,
      }),
    ).not.toThrow();
  });

  it("rejects rejected without reason", () => {
    expect(() =>
      ContentNegotiationDecisionSchema.parse({
        requestContentType: "image/png",
        selectedResponseContentType: "application/json",
        selectedResponseEncoding: "identity",
        selectedResponseLanguage: null,
        acceptableLanguages: [],
        requestContentTypeAccepted: false,
        rejectedReason: null,
      }),
    ).toThrow(/rejectedReason/);
  });
});
