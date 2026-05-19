export const ANTHROPIC_FILES_BETA_HEADER = "files-api-2025-04-14";

export interface AnthropicFile {
  readonly id: string;
  readonly type: "file";
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly created_at: string;
  readonly downloadable?: boolean;
}

export interface AnthropicFileListResponse {
  readonly data: readonly AnthropicFile[];
  readonly has_more: boolean;
  readonly first_id: string | null;
  readonly last_id: string | null;
}

export interface AnthropicFileDeleteResponse {
  readonly id: string;
  readonly type: "file_deleted";
}

export interface BuildAnthropicMultipartInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType?: string;
}

export interface BuildAnthropicMultipartResult {
  readonly body: Uint8Array;
  readonly contentType: string;
}

const TEXT_ENCODER = new TextEncoder();

export function buildAnthropicMultipartUpload(
  input: BuildAnthropicMultipartInput,
): BuildAnthropicMultipartResult {
  if (input.filename.length === 0) {
    throw new Error("buildAnthropicMultipartUpload: filename must be non-empty");
  }
  if (input.bytes.byteLength === 0) {
    throw new Error("buildAnthropicMultipartUpload: bytes must be non-empty");
  }
  const boundary = `----CrossEnginAnthropicBoundary${Math.random().toString(36).slice(2, 18)}`;
  const contentType = input.contentType ?? "application/octet-stream";
  const fileEscaped = input.filename.replace(/"/g, '\\"');
  const preFile = TEXT_ENCODER.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileEscaped}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const postFile = TEXT_ENCODER.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(preFile.byteLength + input.bytes.byteLength + postFile.byteLength);
  body.set(preFile, 0);
  body.set(input.bytes, preFile.byteLength);
  body.set(postFile, preFile.byteLength + input.bytes.byteLength);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
