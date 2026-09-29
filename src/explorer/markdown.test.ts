// markdown.ts unit tests
// Run: node --test src/explorer/markdown.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMarkdownPath, renderMarkdown } from "./markdown.ts";

describe("isMarkdownPath", () => {
  it("matches .md", () => assert.equal(isMarkdownPath("foo.md"), true));
  it("matches .markdown", () => assert.equal(isMarkdownPath("foo.markdown"), true));
  it("rejects .txt", () => assert.equal(isMarkdownPath("foo.txt"), false));
  it("rejects .tsx", () => assert.equal(isMarkdownPath("foo.tsx"), false));
});

describe("renderMarkdown", () => {
  it("escapes raw HTML", () => {
    const out = renderMarkdown('<script>alert("xss")</script>');
    assert.ok(!out.includes("<script>"));
    assert.ok(out.includes("&lt;script&gt;"));
  });

  it("renders headings", () => {
    assert.ok(renderMarkdown("# Hello").includes("<h1>Hello</h1>"));
    assert.ok(renderMarkdown("## Sub").includes("<h2>Sub</h2>"));
  });

  it("renders fenced code blocks", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    assert.ok(out.includes("<pre"));
    assert.ok(out.includes("const x = 1;"));
    assert.ok(!out.includes("<script>"));
  });

  it("renders bold and italic", () => {
    const out = renderMarkdown("**bold** and *italic*");
    assert.ok(out.includes("<strong>bold</strong>"));
    assert.ok(out.includes("<em>italic</em>"));
  });

  it("renders inline code without further formatting", () => {
    const out = renderMarkdown("`**not bold**`");
    assert.ok(out.includes("<code>**not bold**</code>"));
    assert.ok(!out.includes("<strong>"));
  });

  it("renders links", () => {
    const out = renderMarkdown("[click](https://example.com)");
    assert.ok(out.includes('href="https://example.com"'));
    assert.ok(out.includes("click</a>"));
  });

  it("strips unsafe links", () => {
    const out = renderMarkdown("[bad](javascript:alert(1))");
    assert.ok(!out.includes("<a"));
    assert.ok(out.includes("bad"));
  });

  it("strips protocol-relative and backslash-normalized links", () => {
    for (const href of ["//evil.example", "/\\evil.example", "\\\\evil.example"]) {
      const out = renderMarkdown(`[bad](${href})`);
      assert.ok(!out.includes("<a"), href);
      assert.ok(out.includes("bad"), href);
    }
  });

  it("renders blockquotes", () => {
    const out = renderMarkdown("> quote");
    assert.ok(out.includes("<blockquote>"));
    assert.ok(out.includes("quote"));
  });

  it("renders unordered lists", () => {
    const out = renderMarkdown("- a\n- b");
    assert.ok(out.includes("<ul>"));
    assert.ok(out.includes("<li>a</li>"));
    assert.ok(out.includes("<li>b</li>"));
  });

  it("renders ordered lists", () => {
    const out = renderMarkdown("1. first\n2. second");
    assert.ok(out.includes("<ol>"));
    assert.ok(out.includes("<li>first</li>"));
  });

  it("renders task lists", () => {
    const out = renderMarkdown("- [x] done\n- [ ] todo");
    assert.ok(out.includes('checked'));
    assert.ok(out.includes("done"));
    assert.ok(out.includes("todo"));
    assert.ok(out.includes('type="checkbox"'));
  });

  it("renders horizontal rules", () => {
    assert.ok(renderMarkdown("---").includes("<hr>"));
  });

  it("renders tables", () => {
    const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    assert.ok(out.includes("<table>"));
    assert.ok(out.includes("<th>"));
    assert.ok(out.includes("<td>1</td>"));
  });

  it("renders images as alt text", () => {
    const out = renderMarkdown("![alt text](image.png)");
    assert.ok(out.includes("alt text"));
    assert.ok(!out.includes("<img"));
    assert.ok(!out.includes("image.png"));
  });

  it("renders paragraphs", () => {
    const out = renderMarkdown("hello world");
    assert.ok(out.includes("<p>hello world</p>"));
  });

  it("preserves order: code before emphasis", () => {
    const out = renderMarkdown("`**x**`");
    assert.ok(out.includes("<code>**x**</code>"));
    assert.ok(!out.includes("<strong>"));
  });
});
