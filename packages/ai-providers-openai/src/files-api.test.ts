import { describe, expect, it } from "vitest";

import {
  OPENAI_FILES_PURPOSES,
  buildMultipartUpload,
  isOpenAIFilesPurpose,
} from "./files-api.js";

describe("OPENAI_FILES_PURPOSES", () => {
  it("includes the 5 documented purposes", () => {
    expect(OPENAI_FILES_PURPOSES).toEqual([
      "assistants",
      "batch",
      "fine-tune",
      "vision",
      "user_data",
    ]);
  });
});

describe("isOpenAIFilesPurpose", () => {
  it("returns true for each documented purpose", () => {
    for (const p of OPENAI_FILES_PURPOSES) {
      expect(isOpenAIFilesPurpose(p)).toBe(true);
    }
  });

  it("returns false for unknown purposes", () => {
    expect(isOpenAIFilesPurpose("training")).toBe(false);
    expect(isOpenAIFilesPurpose("")).toBe(false);
    expect(isOpenAIFilesPurpose("ASSISTANTS")).toBe(false);
  });
});

describe("buildMultipartUpload", () => {
  function decodeBody(body: Uint8Array): string {
    return new TextDecoder("utf-8").decode(body);
  }

  it("encodes purpose + file parts with the documented multipart structure", () => {
    const bytes = new TextEncoder().encode("PDF_BYTES_HERE");
    const result = buildMultipartUpload({
      bytes,
      filename: "report.pdf",
      purpose: "user_data",
      contentType: "application/pdf",
    });
    const text = decodeBody(result.body);
    expect(result.contentType).toMatch(
      /^multipart\/form-data; boundary=----CrossEnginFormBoundary[a-z0-9]+$/,
    );
    expect(text).toContain('name="purpose"\r\n\r\nuser_data');
    expect(text).toContain('name="file"; filename="report.pdf"');
    expect(text).toContain("Content-Type: application/pdf");
    expect(text).toContain("PDF_BYTES_HERE");
  });

  it("defaults contentType to application/octet-stream when omitted", () => {
    const result = buildMultipartUpload({
      bytes: new TextEncoder().encode("X"),
      filename: "x.bin",
      purpose: "user_data",
    });
    expect(decodeBody(result.body)).toContain(
      "Content-Type: application/octet-stream",
    );
  });

  it("escapes quotes in filename", () => {
    const result = buildMultipartUpload({
      bytes: new TextEncoder().encode("X"),
      filename: 'file"name".pdf',
      purpose: "user_data",
    });
    expect(decodeBody(result.body)).toContain(
      'filename="file\\"name\\".pdf"',
    );
  });

  it("rejects empty filename", () => {
    expect(() =>
      buildMultipartUpload({
        bytes: new TextEncoder().encode("X"),
        filename: "",
        purpose: "user_data",
      }),
    ).toThrow(/filename/);
  });

  it("rejects empty bytes", () => {
    expect(() =>
      buildMultipartUpload({
        bytes: new Uint8Array(0),
        filename: "x.pdf",
        purpose: "user_data",
      }),
    ).toThrow(/bytes/);
  });

  it("rejects invalid purpose", () => {
    expect(() =>
      buildMultipartUpload({
        bytes: new TextEncoder().encode("X"),
        filename: "x.pdf",
        purpose: "training" as never,
      }),
    ).toThrow(/invalid purpose/);
  });

  it("terminates the body with the closing boundary marker", () => {
    const result = buildMultipartUpload({
      bytes: new TextEncoder().encode("X"),
      filename: "x.pdf",
      purpose: "user_data",
    });
    const text = decodeBody(result.body);
    const boundaryMatch = /boundary=(-+CrossEnginFormBoundary[a-z0-9]+)/.exec(
      result.contentType,
    );
    expect(boundaryMatch).not.toBeNull();
    expect(text).toMatch(new RegExp(`--${boundaryMatch![1]}--\\r\\n$`));
  });

  it("preserves binary content (not just text)", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80]);
    const result = buildMultipartUpload({
      bytes,
      filename: "binary.dat",
      purpose: "user_data",
    });
    // Find the position of the binary bytes in the result
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
});
