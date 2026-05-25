import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import {
  BEDROCK_MAX_TAGS_PER_REQUEST,
  BEDROCK_TAG_KEY_MAX_LEN,
  BEDROCK_TAG_VALUE_MAX_LEN,
  buildListTagsForResourceBody,
  buildTagResourceBody,
  buildTagResourceQuery,
  buildUntagResourceBody,
  buildUntagResourceQuery,
  parseListTagsForResourceResponse,
  type BedrockTag,
  type BedrockTagResourceInput,
  type BedrockUntagResourceInput,
} from "./tagging-api.js";

const VALID_ARN = "arn:aws:bedrock:us-east-1:123456789012:custom-model/abc123def456";

describe("buildTagResourceBody (M2.X.5.aa.z.24)", () => {
  function valid(overrides: Partial<BedrockTagResourceInput> = {}): BedrockTagResourceInput {
    return {
      resourceArn: VALID_ARN,
      tags: [{ key: "env", value: "prod" }],
      ...overrides,
    };
  }

  it("emits the tags array as JSON", () => {
    const body = JSON.parse(buildTagResourceBody(valid())) as Record<string, unknown>;
    expect(body["tags"]).toEqual([{ key: "env", value: "prod" }]);
  });

  it("does NOT include resourceArn in the body (it goes in the query)", () => {
    const body = JSON.parse(buildTagResourceBody(valid())) as Record<string, unknown>;
    expect("resourceArn" in body).toBe(false);
    expect("resourceARN" in body).toBe(false);
  });

  it("rejects empty tags array", () => {
    expect(() => buildTagResourceBody(valid({ tags: [] }))).toThrow(
      /tags must contain at least one entry/,
    );
  });

  it("rejects more than 200 tags", () => {
    const tags: BedrockTag[] = Array.from({ length: 201 }, (_, i) => ({
      key: `k${i.toString()}`,
      value: "v",
    }));
    expect(() => buildTagResourceBody(valid({ tags }))).toThrow(/tags count/);
  });

  it("rejects blank resourceArn", () => {
    expect(() => buildTagResourceBody(valid({ resourceArn: "" }))).toThrow(/invalid resourceArn/);
  });

  it("rejects resourceArn not starting with arn:aws", () => {
    expect(() => buildTagResourceBody(valid({ resourceArn: "not-an-arn" }))).toThrow(
      /invalid resourceArn/,
    );
  });

  it("rejects empty tag key", () => {
    expect(() => buildTagResourceBody(valid({ tags: [{ key: "", value: "v" }] }))).toThrow(
      /invalid tag key at index 0/,
    );
  });

  it("rejects tag key > 128 chars", () => {
    expect(() =>
      buildTagResourceBody(
        valid({ tags: [{ key: "a".repeat(BEDROCK_TAG_KEY_MAX_LEN + 1), value: "v" }] }),
      ),
    ).toThrow(/invalid tag key at index 0/);
  });

  it("rejects tag value > 256 chars", () => {
    expect(() =>
      buildTagResourceBody(
        valid({ tags: [{ key: "k", value: "a".repeat(BEDROCK_TAG_VALUE_MAX_LEN + 1) }] }),
      ),
    ).toThrow(/invalid tag value at index 0/);
  });

  it("accepts empty tag value (valid per AWS contract)", () => {
    expect(() => buildTagResourceBody(valid({ tags: [{ key: "k", value: "" }] }))).not.toThrow();
  });

  it("rejects tag key violating the pattern (e.g., comma)", () => {
    expect(() => buildTagResourceBody(valid({ tags: [{ key: "has,comma", value: "v" }] }))).toThrow(
      /invalid tag key/,
    );
  });

  it("reports the index of the bad tag in the error message", () => {
    expect(() =>
      buildTagResourceBody(
        valid({
          tags: [
            { key: "ok", value: "v" },
            { key: "ok2", value: "v" },
            { key: "", value: "bad" },
          ],
        }),
      ),
    ).toThrow(/index 2/);
  });

  it(`accepts exactly ${BEDROCK_MAX_TAGS_PER_REQUEST.toString()} tags (boundary)`, () => {
    const tags: BedrockTag[] = Array.from({ length: BEDROCK_MAX_TAGS_PER_REQUEST }, (_, i) => ({
      key: `k${i.toString()}`,
      value: "v",
    }));
    expect(() => buildTagResourceBody(valid({ tags }))).not.toThrow();
  });
});

describe("buildUntagResourceBody (M2.X.5.aa.z.24)", () => {
  function valid(overrides: Partial<BedrockUntagResourceInput> = {}): BedrockUntagResourceInput {
    return {
      resourceArn: VALID_ARN,
      tagKeys: ["env"],
      ...overrides,
    };
  }

  it("emits the tagKeys array as JSON", () => {
    const body = JSON.parse(buildUntagResourceBody(valid())) as Record<string, unknown>;
    expect(body["tagKeys"]).toEqual(["env"]);
  });

  it("does NOT include resourceArn in the body (it goes in the query)", () => {
    const body = JSON.parse(buildUntagResourceBody(valid())) as Record<string, unknown>;
    expect("resourceArn" in body).toBe(false);
  });

  it("rejects empty tagKeys array", () => {
    expect(() => buildUntagResourceBody(valid({ tagKeys: [] }))).toThrow(
      /tagKeys must contain at least one entry/,
    );
  });

  it("rejects more than 200 tag keys", () => {
    const tagKeys = Array.from({ length: 201 }, (_, i) => `k${i.toString()}`);
    expect(() => buildUntagResourceBody(valid({ tagKeys }))).toThrow(/tagKeys count/);
  });

  it("rejects empty tag key in the array", () => {
    expect(() => buildUntagResourceBody(valid({ tagKeys: [""] }))).toThrow(
      /invalid tag key at index 0/,
    );
  });

  it("rejects blank resourceArn", () => {
    expect(() => buildUntagResourceBody(valid({ resourceArn: "" }))).toThrow(BedrockError);
  });

  it("rejects tag key violating the pattern", () => {
    expect(() => buildUntagResourceBody(valid({ tagKeys: ["bad,comma"] }))).toThrow(
      /invalid tag key/,
    );
  });
});

describe("buildListTagsForResourceBody (M2.X.5.aa.z.24)", () => {
  it("emits resourceARN in the body (AWS uses uppercase ARN here)", () => {
    const body = JSON.parse(buildListTagsForResourceBody({ resourceArn: VALID_ARN })) as Record<
      string,
      unknown
    >;
    expect(body["resourceARN"]).toBe(VALID_ARN);
  });

  it("rejects blank resourceArn", () => {
    expect(() => buildListTagsForResourceBody({ resourceArn: "" })).toThrow(/invalid resourceArn/);
  });

  it("rejects resourceArn not starting with arn:aws", () => {
    expect(() => buildListTagsForResourceBody({ resourceArn: "garbage" })).toThrow(
      /invalid resourceArn/,
    );
  });
});

describe("buildTagResourceQuery + buildUntagResourceQuery (M2.X.5.aa.z.24)", () => {
  it("tagResource query passes resourceARN through as a query param", () => {
    const q = buildTagResourceQuery({
      resourceArn: VALID_ARN,
      tags: [{ key: "k", value: "v" }],
    });
    expect(q).toEqual({ resourceARN: VALID_ARN });
  });

  it("untagResource query passes resourceARN through as a query param", () => {
    const q = buildUntagResourceQuery({
      resourceArn: VALID_ARN,
      tagKeys: ["k"],
    });
    expect(q).toEqual({ resourceARN: VALID_ARN });
  });
});

describe("parseListTagsForResourceResponse (M2.X.5.aa.z.24)", () => {
  it("parses an empty tags array", () => {
    const r = parseListTagsForResourceResponse({ tags: [] });
    expect(r.tags).toEqual([]);
  });

  it("parses a populated tags array", () => {
    const r = parseListTagsForResourceResponse({
      tags: [
        { key: "env", value: "prod" },
        { key: "team", value: "platform" },
      ],
    });
    expect(r.tags).toEqual([
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);
  });

  it("treats missing tags field as empty array", () => {
    const r = parseListTagsForResourceResponse({});
    expect(r.tags).toEqual([]);
  });

  it("rejects non-object input", () => {
    expect(() => parseListTagsForResourceResponse(null)).toThrow(/not a JSON object/);
  });

  it("rejects non-array tags", () => {
    expect(() => parseListTagsForResourceResponse({ tags: "nope" })).toThrow(
      /tags is not an array/,
    );
  });

  it("rejects tag entry missing key/value strings", () => {
    expect(() => parseListTagsForResourceResponse({ tags: [{ key: "k" }] })).toThrow(
      /missing key\/value strings/,
    );
  });

  it("rejects non-object tag entries", () => {
    expect(() => parseListTagsForResourceResponse({ tags: ["nope"] })).toThrow(/is not an object/);
  });
});
