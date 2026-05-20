import type { BedrockProvider } from "./provider.js";
import { BedrockError } from "./errors.js";
import type { BedrockTag } from "./tagging-api.js";

export interface SetExactTagsInput {
  readonly resourceArn: string;
  readonly desiredTags: ReadonlyArray<BedrockTag>;
}

export interface SetExactTagsResult {
  readonly added: readonly BedrockTag[];
  readonly removed: readonly string[];
  readonly unchanged: readonly BedrockTag[];
}

export async function setExactTags(
  provider: BedrockProvider,
  input: SetExactTagsInput,
): Promise<SetExactTagsResult> {
  if (input.resourceArn.length === 0) {
    throw new BedrockError({
      kind: "invalid_request_error",
      message: "setExactTags: resourceArn must be a non-empty string",
    });
  }
  const seenKeys = new Set<string>();
  for (const tag of input.desiredTags) {
    if (seenKeys.has(tag.key)) {
      throw new BedrockError({
        kind: "invalid_request_error",
        message: `setExactTags: duplicate desired tag key '${tag.key}'`,
      });
    }
    seenKeys.add(tag.key);
  }
  const { tags: current } = await provider.listTagsForResource({
    resourceArn: input.resourceArn,
  });
  const currentByKey = new Map<string, string>();
  for (const tag of current) currentByKey.set(tag.key, tag.value);
  const desiredByKey = new Map<string, string>();
  for (const tag of input.desiredTags) desiredByKey.set(tag.key, tag.value);
  const added: BedrockTag[] = [];
  const unchanged: BedrockTag[] = [];
  for (const tag of input.desiredTags) {
    const currentValue = currentByKey.get(tag.key);
    if (currentValue === undefined || currentValue !== tag.value) {
      added.push(tag);
    } else {
      unchanged.push(tag);
    }
  }
  const removed: string[] = [];
  for (const tag of current) {
    if (!desiredByKey.has(tag.key)) removed.push(tag.key);
  }
  if (added.length > 0) {
    await provider.tagResource({
      resourceArn: input.resourceArn,
      tags: added,
    });
  }
  if (removed.length > 0) {
    await provider.untagResource({
      resourceArn: input.resourceArn,
      tagKeys: removed,
    });
  }
  return { added, removed, unchanged };
}
