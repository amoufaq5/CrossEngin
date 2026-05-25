import { describe, expect, it } from "vitest";

import { BedrockError } from "./errors.js";
import { BedrockProvider, type FetchLike } from "./provider.js";
import type { BedrockTag } from "./tagging-api.js";
import { setExactTags } from "./tagging-helpers.js";

const VALID_ARN = "arn:aws:bedrock:us-east-1:123456789012:custom-model/abc123def456";

interface FetchCallRecord {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

function buildProviderWithMockFetch(opts: {
  listTagsResponse: { tags: BedrockTag[] };
  records?: FetchCallRecord[];
  onError?: (sql: string) => void;
}): BedrockProvider {
  const records = opts.records ?? [];
  const fetchImpl: FetchLike = async (url, init) => {
    const bodyStr = init.body.byteLength > 0 ? new TextDecoder().decode(init.body) : "";
    records.push({ method: init.method, url, body: bodyStr });
    if (url.includes("/listTagsForResource")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(opts.listTagsResponse),
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    }
    if (url.includes("/tags?") || url.includes("/untag?")) {
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    }
    return {
      ok: false,
      status: 500,
      text: async () => "unexpected url",
      arrayBuffer: async () => new ArrayBuffer(0),
      body: null,
    };
  };
  return new BedrockProvider({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    fetch: fetchImpl,
    clock: () => new Date("2026-05-20T12:00:00.000Z"),
  });
}

describe("setExactTags (M6.8.y)", () => {
  it("adds missing tags + leaves no current tags untouched (empty current, non-empty desired)", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: { tags: [] },
      records,
    });
    const result = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [
        { key: "env", value: "prod" },
        { key: "owner", value: "platform" },
      ],
    });
    expect(result.added).toEqual([
      { key: "env", value: "prod" },
      { key: "owner", value: "platform" },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(records.length).toBe(2); // list + tag
    expect(records[1]?.url).toContain("/tags?");
  });

  it("removes extra tags + leaves nothing to add (non-empty current, empty desired)", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: {
        tags: [
          { key: "stale", value: "v1" },
          { key: "removed", value: "v2" },
        ],
      },
      records,
    });
    const result = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [],
    });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["stale", "removed"]);
    expect(result.unchanged).toEqual([]);
    expect(records.length).toBe(2); // list + untag
    expect(records[1]?.url).toContain("/untag?");
  });

  it("noop when current matches desired exactly (no tag/untag calls issued)", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: {
        tags: [
          { key: "env", value: "prod" },
          { key: "team", value: "platform" },
        ],
      },
      records,
    });
    const result = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [
        { key: "env", value: "prod" },
        { key: "team", value: "platform" },
      ],
    });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);
    expect(records.length).toBe(1); // only list
  });

  it("updates value on an existing key (treats as add since the value changed)", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: { tags: [{ key: "env", value: "staging" }] },
      records,
    });
    const result = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [{ key: "env", value: "prod" }],
    });
    expect(result.added).toEqual([{ key: "env", value: "prod" }]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it("computes the minimum tag/untag set with mixed add/remove/unchanged", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: {
        tags: [
          { key: "env", value: "prod" }, // unchanged
          { key: "owner", value: "old" }, // changed → re-add
          { key: "stale", value: "x" }, // removed
        ],
      },
      records,
    });
    const result = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [
        { key: "env", value: "prod" },
        { key: "owner", value: "new" },
        { key: "team", value: "platform" }, // added
      ],
    });
    expect(result.added).toEqual([
      { key: "owner", value: "new" },
      { key: "team", value: "platform" },
    ]);
    expect(result.removed).toEqual(["stale"]);
    expect(result.unchanged).toEqual([{ key: "env", value: "prod" }]);
    expect(records.length).toBe(3); // list + tag + untag
  });

  it("issues tag THEN untag (additions before removals)", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: { tags: [{ key: "old", value: "v" }] },
      records,
    });
    await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [{ key: "new", value: "v" }],
    });
    const tagIdx = records.findIndex((r) => r.url.includes("/tags?"));
    const untagIdx = records.findIndex((r) => r.url.includes("/untag?"));
    expect(tagIdx).toBeGreaterThan(0);
    expect(untagIdx).toBeGreaterThan(tagIdx);
  });

  it("validates resourceArn BEFORE the list call", async () => {
    let called = 0;
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "x",
      region: "us-east-1",
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      setExactTags(provider, {
        resourceArn: "",
        desiredTags: [{ key: "env", value: "prod" }],
      }),
    ).rejects.toMatchObject({ kind: "invalid_request_error" });
    expect(called).toBe(0);
  });

  it("rejects duplicate desired tag keys BEFORE the list call", async () => {
    let called = 0;
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "x",
      region: "us-east-1",
      fetch: async () => {
        called += 1;
        return {
          ok: true,
          status: 200,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      },
    });
    await expect(
      setExactTags(provider, {
        resourceArn: VALID_ARN,
        desiredTags: [
          { key: "env", value: "prod" },
          { key: "env", value: "staging" }, // duplicate
        ],
      }),
    ).rejects.toThrow(/duplicate desired tag key 'env'/);
    expect(called).toBe(0);
  });

  it("supports tag value updates without forcing untag-then-tag round-trip (single tag call)", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: { tags: [{ key: "env", value: "v1" }] },
      records,
    });
    await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [{ key: "env", value: "v2" }],
    });
    // AWS tagResource overwrites the value for an existing key — no untag needed.
    const tagCalls = records.filter((r) => r.url.includes("/tags?"));
    const untagCalls = records.filter((r) => r.url.includes("/untag?"));
    expect(tagCalls).toHaveLength(1);
    expect(untagCalls).toHaveLength(0);
  });

  it("idempotent: running setExactTags twice with same desired set is a noop on the second run", async () => {
    const records: FetchCallRecord[] = [];
    let listCallCount = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const bodyStr = init.body.byteLength > 0 ? new TextDecoder().decode(init.body) : "";
      records.push({ method: init.method, url, body: bodyStr });
      if (url.includes("/listTagsForResource")) {
        listCallCount += 1;
        // First call: no tags. Second call: includes the previously-added tag.
        const tags = listCallCount === 1 ? [] : [{ key: "env", value: "prod" }];
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tags }),
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    };
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "x",
      region: "us-east-1",
      fetch: fetchImpl,
    });
    const desired = [{ key: "env", value: "prod" }];
    await setExactTags(provider, { resourceArn: VALID_ARN, desiredTags: desired });
    records.length = 0;
    const secondResult = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: desired,
    });
    expect(secondResult.added).toEqual([]);
    expect(secondResult.removed).toEqual([]);
    expect(secondResult.unchanged).toEqual(desired);
    // Second run: list-only, no tag/untag.
    expect(records.length).toBe(1);
    expect(records[0]?.url).toContain("/listTagsForResource");
  });

  it("propagates underlying provider errors (e.g., 404 on listTagsForResource)", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({
          __type: "ResourceNotFoundException",
          message: "no",
        }),
      arrayBuffer: async () => new ArrayBuffer(0),
      body: null,
    });
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "x",
      region: "us-east-1",
      fetch: fetchImpl,
    });
    await expect(
      setExactTags(provider, {
        resourceArn: VALID_ARN,
        desiredTags: [{ key: "env", value: "prod" }],
      }),
    ).rejects.toMatchObject({ kind: "not_found_error" });
  });

  it("supports empty values (AWS contract allows empty tag values)", async () => {
    const records: FetchCallRecord[] = [];
    const provider = buildProviderWithMockFetch({
      listTagsResponse: { tags: [] },
      records,
    });
    const result = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [{ key: "marker", value: "" }],
    });
    expect(result.added).toEqual([{ key: "marker", value: "" }]);
  });

  it("returns the result types for downstream operator audit", async () => {
    const provider = buildProviderWithMockFetch({
      listTagsResponse: {
        tags: [
          { key: "env", value: "prod" },
          { key: "stale", value: "x" },
        ],
      },
    });
    const result = await setExactTags(provider, {
      resourceArn: VALID_ARN,
      desiredTags: [
        { key: "env", value: "prod" },
        { key: "team", value: "platform" },
      ],
    });
    // result is the audit trail of what changed
    expect(result.added).toContainEqual({ key: "team", value: "platform" });
    expect(result.removed).toContain("stale");
    expect(result.unchanged).toContainEqual({ key: "env", value: "prod" });
  });

  it("throws BedrockError (not generic Error) for validation failures", async () => {
    const provider = buildProviderWithMockFetch({ listTagsResponse: { tags: [] } });
    await expect(
      setExactTags(provider, { resourceArn: "", desiredTags: [] }),
    ).rejects.toBeInstanceOf(BedrockError);
  });
});
