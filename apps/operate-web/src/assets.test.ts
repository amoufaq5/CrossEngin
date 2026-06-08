import { describe, expect, it } from "vitest";

import { CLIENT_BUNDLE_PATH, serveClientBundle } from "./assets.js";

describe("client bundle path constant", () => {
  it("is the URL the SSR pages load the hydration bundle from", () => {
    expect(CLIENT_BUNDLE_PATH).toBe("/assets/operate-web-client.js");
  });
});

describe("serveClientBundle", () => {
  it("serves the bytes as application/javascript when the bundle exists", async () => {
    const bytes = new TextEncoder().encode('"use strict";(()=>{})();');
    const res = await serveClientBundle(async () => bytes);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["content-length"]).toBe(bytes.byteLength.toString());
    expect(res.body).toEqual(bytes);
  });

  it("returns a helpful 503 pointing at build:client when the bundle is missing", async () => {
    const res = await serveClientBundle(async () => null);
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toContain("problem+json");
    const body = JSON.parse(new TextDecoder().decode(res.body!)) as { detail: string };
    expect(body.detail).toContain("build:client");
  });
});
