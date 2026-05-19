# ADR-0096: Anthropic URL-source image support (Phase 2 M2.X.5.z)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0094 (M2.X.5.y ImageUrlContentBlock), ADR-0088 (M2.X.5 content union), ADR-0053 (M2.7 Anthropic provider) |

## Context

M2.X.5.y added `ImageUrlContentBlock` to the kernel content union. OpenAI's Chat Completions + Responses API both accept URL-based images natively, so the translator passes the URL through. Anthropic's API at the time required `source: {type: "base64", media_type, data}` exclusively — the translator threw with a "pre-fetch the URL to bytes" message.

ADR-0094 Q3 noted that Anthropic had recently added URL source support to their image content blocks API:

```ts
{
  type: "image",
  source: { type: "url", url: "https://..." }
}
```

The throw is no longer needed. M2.X.5.z removes it and threads URLs through to the new Anthropic source format.

## Decision

Two coordinated changes in `@crossengin/ai-providers-anthropic`.

### 1. Extend `AnthropicContentBlock` image source union

```ts
| {
    readonly type: "image";
    readonly source:
      | {
          readonly type: "base64";
          readonly media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
          readonly data: string;
        }
      | { readonly type: "url"; readonly url: string };
  }
```

The `source` field becomes a discriminated union on `source.type`. Both variants share the outer `type: "image"` discriminator. The existing `base64` variant is unchanged; the new `url` variant carries a single string field.

### 2. Replace the throw in `translateKernelBlock`

Pre-M2.X.5.z:
```ts
if (block.type === "image_url") {
  throw new Error("Anthropic provider does not support image_url ...");
}
```

Post-M2.X.5.z:
```ts
if (block.type === "image_url") {
  return {
    type: "image",
    source: { type: "url", url: block.url },
  };
}
```

The kernel `ImageUrlContentBlock.url` field maps directly to Anthropic's `source.url`. No format hint is passed — Anthropic infers it from the response Content-Type, same as OpenAI.

### Test update

The existing M2.X.5.y test asserting the throw is replaced with two tests:

1. **Translation test** — verifies `image_url` block produces `{type: "image", source: {type: "url", url: ...}}` Anthropic content block.
2. **Mixed-mode test** — verifies a user message with BOTH `{type: "image", format, bytes}` AND `{type: "image_url", url}` blocks produces two Anthropic image blocks with the correct `base64` + `url` source variants respectively.

## Cross-cutting invariants enforced

- **Two source variants supported.** Bytes-based image (M2.X.5) continues to work; URL-based image (M2.X.5.y) now also flows through.
- **Source variant is a discriminated union on `source.type`.** TypeScript distinguishes `base64` from `url` at the type level.
- **No kernel changes.** `ImageUrlContentBlock` shape is unchanged. The translator-level update is the only change.
- **Bedrock still throws.** Bedrock's image source format doesn't have a URL variant; the throw in the Bedrock translator remains. Operators with cross-provider URL workflows pre-fetch bytes when targeting Bedrock.
- **No format passed in URL source.** Anthropic infers format from URL response Content-Type. The kernel's optional `format` field on `ImageUrlContentBlock` is currently dropped on this path (could be added as a hint if Anthropic exposes a `media_type` field on URL sources in the future).

## End-to-end semantic

```ts
// Pre-M2.X.5.z: Anthropic throws "pre-fetch the URL to bytes"
// Post-M2.X.5.z: URL flows through to Anthropic natively

const msg: LlmMessage = {
  role: "user",
  content: [
    { type: "text", text: "describe" },
    { type: "image_url", url: "https://example.com/cat.png" },
  ],
};

// Translates to:
//   {
//     role: "user",
//     content: [
//       { type: "text", text: "describe" },
//       { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
//     ],
//   }
```

Provider parity for URL-based images is now: OpenAI Chat Completions ✓, OpenAI Responses ✓, Anthropic ✓. Bedrock ✗ (still requires bytes).

## Alternatives considered

- **Keep the throw and require operators to pre-fetch.**
  - **Considered.** Conservative — matches Bedrock's behavior.
  - **Cons.** Anthropic DOES support URLs natively now; the throw is operationally wrong. Operators would do unnecessary fetch work for no benefit.
  - **Decision.** Pass URLs through to the native source format.

- **Auto-detect URL accessibility at request-build time** (HEAD request to verify the URL).
  - **Considered.** Catch typos / inaccessible URLs early.
  - **Cons.** Adds latency + complexity (timeout, retry, network policy). Anthropic does its own fetch + returns a clear error if the URL is unreachable. Pre-flight checks are operator territory.
  - **Decision.** Pass through. Trust Anthropic's server-side fetch.

- **Pass the `format` field from `ImageUrlContentBlock` as a `media_type` hint on the URL source.**
  - **Considered.** Disambiguates when URL Content-Type might be wrong.
  - **Cons.** Anthropic's URL source schema doesn't accept `media_type` (Content-Type is authoritative). Adding the field would be rejected by the API.
  - **Decision.** Drop `format` on the URL path. If Anthropic later adds a media-type hint field, thread it then.

- **Support data URLs through the `url` source variant** (e.g. `data:image/png;base64,...`).
  - **Considered.** Operators with pre-encoded data URLs could use either the bytes-based variant or wrap as `image_url`.
  - **Cons.** Mixing data URLs with the URL variant blurs the distinction. The bytes-based variant is the canonical inline path.
  - **Decision.** No special handling — if an operator passes a `data:` URL through `image_url`, Anthropic will fetch + decode it the same way it does any URL.

- **Add fallback logic — if Anthropic's URL fetch fails, retry with the bytes-based path after client-side fetch.**
  - **Considered.** Graceful degradation.
  - **Cons.** Significant scope creep (operator can already implement this in their retry layer using `isInputTooLargeError` / network error classification). Provider stays simple.
  - **Decision.** Out of scope.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,751 tests** (+1 net from M2.X.5.z: replaced the throw test with a passthrough test + added a mixed-mode test). All green, zero type errors.
- **ADR-0094 Q3 closed.** Anthropic's URL-source feature is now first-class in the provider.
- **Provider parity expanded.** OpenAI (both API paths) + Anthropic accept URL-based images. Only Bedrock requires bytes.
- **Payload size + latency win extends to Anthropic.** Same benefit as M2.X.5.y for OpenAI: a 5 MB image URL is ~100 bytes vs ~6.7 MB inline.
- **The `AnthropicContentBlock` image source is a discriminated union.** Downstream code reading Anthropic image blocks should switch on `source.type`.
- **Pattern for future Anthropic format additions.** If Anthropic adds `file_id` or other source variants, the same extension shape applies.

## Open questions

- **Q1:** Should the kernel `ImageUrlContentBlock.format` field be passed to Anthropic when Anthropic adds a media-type hint field?
  - _Current direction:_ Currently dropped. Add to the translator when the API supports it.
- **Q2:** Should the Bedrock translator gain URL support if AWS Bedrock adds it?
  - _Current direction:_ Watch the Bedrock changelog. Currently still throws.
- **Q3:** What about signed-URL inputs (e.g., S3 pre-signed URLs)?
  - _Current direction:_ Treated identically — the URL field is opaque to the kernel. Anthropic's server-side fetch handles the signed URL the same as a public URL.
- **Q4:** Should there be a way for operators to FORCE the bytes path even when `image_url` is provided?
  - _Current direction:_ Out of scope. Operators wanting the bytes path use `{type: "image", format, bytes}` directly.
- **Q5:** What about per-image URL caching headers (`cache-control` for Anthropic's server-side fetch)?
  - _Current direction:_ The URL response carries its own cache headers. Anthropic respects them on their end.
- **Q6:** Anthropic's URL source supports both http(s) and file URLs in some SDKs — should we restrict to https only at the kernel layer?
  - _Current direction:_ The kernel `z.string().url()` allows any valid URL scheme. Per-provider restrictions are deferred to provider-level validation if needed (e.g., reject file:// schemes for security).
- **Q7:** What about Anthropic's PDF / document URL inputs (separate content variant)?
  - _Current direction:_ Out of scope. Anthropic supports document content blocks via a separate `document` type. Future M2.X.5.aa could add a `DocumentContentBlock` variant.
