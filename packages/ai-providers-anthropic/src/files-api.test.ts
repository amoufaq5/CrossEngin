import { describe, expect, it } from "vitest";

import { ANTHROPIC_FILES_BETA_HEADER, buildAnthropicMultipartUpload } from "./files-api.js";

describe("ANTHROPIC_FILES_BETA_HEADER", () => {
  it("is the documented beta header value", () => {
    expect(ANTHROPIC_FILES_BETA_HEADER).toBe("files-api-2025-04-14");
  });
});

describe("buildAnthropicMultipartUpload", () => {
  function decodeBody(body: Uint8Array): string {
    return new TextDecoder("utf-8").decode(body);
  }

  it("encodes a file part with no purpose field (Anthropic doesn't use purpose)", () => {
    const result = buildAnthropicMultipartUpload({
      bytes: new TextEncoder().encode("PDF_BYTES"),
      filename: "spec.pdf",
      contentType: "application/pdf",
    });
    const text = decodeBody(result.body);
    expect(result.contentType).toMatch(
      /^multipart\/form-data; boundary=----CrossEnginAnthropicBoundary[a-z0-9]+$/,
    );
    expect(text).toContain('name="file"; filename="spec.pdf"');
    expect(text).toContain("Content-Type: application/pdf");
    expect(text).toContain("PDF_BYTES");
    expect(text).not.toContain('name="purpose"');
  });

  it("defaults contentType to application/octet-stream", () => {
    const result = buildAnthropicMultipartUpload({
      bytes: new TextEncoder().encode("X"),
      filename: "x.bin",
    });
    expect(decodeBody(result.body)).toContain("Content-Type: application/octet-stream");
  });

  it("escapes quotes in filename", () => {
    const result = buildAnthropicMultipartUpload({
      bytes: new TextEncoder().encode("X"),
      filename: 'file"name".pdf',
    });
    expect(decodeBody(result.body)).toContain('filename="file\\"name\\".pdf"');
  });

  it("rejects empty filename", () => {
    expect(() =>
      buildAnthropicMultipartUpload({
        bytes: new TextEncoder().encode("X"),
        filename: "",
      }),
    ).toThrow(/filename/);
  });

  it("rejects empty bytes", () => {
    expect(() =>
      buildAnthropicMultipartUpload({
        bytes: new Uint8Array(0),
        filename: "x.pdf",
      }),
    ).toThrow(/bytes/);
  });

  it("preserves binary content byte-for-byte", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80]);
    const result = buildAnthropicMultipartUpload({
      bytes,
      filename: "binary.dat",
    });
    const haystack = result.body;
    let found = false;
    for (let i = 0; i <= haystack.length - bytes.length; i++) {
      let match = true;
      for (let j = 0; j < bytes.length; j++) {
        if (haystack[i + j] !== bytes[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("terminates the body with the closing boundary marker", () => {
    const result = buildAnthropicMultipartUpload({
      bytes: new TextEncoder().encode("X"),
      filename: "x.pdf",
    });
    const text = decodeBody(result.body);
    const boundaryMatch = /boundary=(-+CrossEnginAnthropicBoundary[a-z0-9]+)/.exec(
      result.contentType,
    );
    expect(boundaryMatch).not.toBeNull();
    expect(text).toMatch(new RegExp(`--${boundaryMatch![1]}--\\r\\n$`));
  });
});
