export const OPENAI_FILES_PURPOSES = [
  "assistants",
  "batch",
  "fine-tune",
  "vision",
  "user_data",
] as const;
export type OpenAIFilesPurpose = (typeof OPENAI_FILES_PURPOSES)[number];

export function isOpenAIFilesPurpose(value: string): value is OpenAIFilesPurpose {
  return (OPENAI_FILES_PURPOSES as readonly string[]).includes(value);
}

export interface OpenAIFile {
  readonly id: string;
  readonly object: "file";
  readonly bytes: number;
  readonly created_at: number;
  readonly filename: string;
  readonly purpose: OpenAIFilesPurpose;
}

export interface OpenAIFileListResponse {
  readonly object: "list";
  readonly data: readonly OpenAIFile[];
}

export interface OpenAIFileDeleteResponse {
  readonly id: string;
  readonly object: "file";
  readonly deleted: boolean;
}

export interface BuildMultipartUploadInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly purpose: OpenAIFilesPurpose;
  readonly contentType?: string;
}

export interface BuildMultipartUploadResult {
  readonly body: Uint8Array;
  readonly contentType: string;
}

const TEXT_ENCODER = new TextEncoder();

export function buildMultipartUpload(
  input: BuildMultipartUploadInput,
): BuildMultipartUploadResult {
  if (input.filename.length === 0) {
    throw new Error("buildMultipartUpload: filename must be non-empty");
  }
  if (input.bytes.byteLength === 0) {
    throw new Error("buildMultipartUpload: bytes must be non-empty");
  }
  if (!isOpenAIFilesPurpose(input.purpose)) {
    throw new Error(
      `buildMultipartUpload: invalid purpose '${input.purpose}' — must be one of ${OPENAI_FILES_PURPOSES.join(", ")}`,
    );
  }
  const boundary = `----CrossEnginFormBoundary${Math.random().toString(36).slice(2, 18)}`;
  const contentType = input.contentType ?? "application/octet-stream";
  const fileEscaped = input.filename.replace(/"/g, '\\"');
  const preFile = TEXT_ENCODER.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
      `${input.purpose}\r\n` +
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
