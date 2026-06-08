import { describe, expect, it } from "vitest";

import { renderPage } from "./render.js";

describe("renderPage", () => {
  it("wraps markup in a complete HTML document with a doctype + title", () => {
    const html = renderPage(<p>hello</p>, { title: "My Page" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>My Page</title>");
    expect(html).toContain("<p>hello</p>");
    expect(html).toContain("<style>");
  });

  it("defaults the title and escapes it", () => {
    const html = renderPage(<span>x</span>);
    expect(html).toContain("<title>CrossEngin Operate</title>");
    const escaped = renderPage(<span>x</span>, { title: "A & B <c>" });
    expect(escaped).toContain("<title>A &amp; B &lt;c&gt;</title>");
  });

  it("honors a custom lang attribute", () => {
    const html = renderPage(<span>x</span>, { lang: "ar" });
    expect(html).toContain('<html lang="ar">');
  });
});
