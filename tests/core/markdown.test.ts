// The Markdown subset in assistant replies. Runs on the parsed tree, since tests have no browser.
import { describe, expect, it } from "vitest";
import { parseMarkdown, type MdNode } from "../../src/ui/markdown";

const flat = (node: MdNode | string): string => (typeof node === "string" ? node : `<${node.tag}>${node.children.map(flat).join("")}</${node.tag}>`);
const render = (text: string) => parseMarkdown(text).map(flat).join("");

describe("assistant Markdown", () => {
  it("formats bold, italics and code within a paragraph", () => {
    expect(render("Result: **10 V** at *the output* on `R1`.")).toBe("<p>Result: <strong>10 V</strong> at <em>the output</em> on <code>R1</code>.</p>");
    expect(render("**bold `code`**")).toBe("<p><strong>bold <code>code</code></strong></p>");
  });

  it("keeps the asterisks that aren't formatting", () => {
    for (const text of ["2*3*4 ohms", "a * b * c", "V_out and I_in", "**not closed", "*not closed"]) {
      expect(render(text)).toBe(`<p>${text}</p>`);
    }
    expect(render("`**literal**`")).toBe("<p><code>**literal**</code></p>");
  });

  it("splits paragraphs on blank lines and keeps single line breaks", () => {
    expect(render("one\ntwo\n\nthree")).toBe("<p>one\ntwo</p><p>three</p>");
  });

  it("makes lists, even with blank lines between items", () => {
    expect(render("- a\n* b\n\n+ c")).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(render("1. a\n2) b")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(render("Before\n- a\nAfter")).toBe("<p>Before</p><ul><li>a</li></ul><p>After</p>");
    expect(render("- a\n  more")).toBe("<ul><li>a\nmore</li></ul>");
  });

  it("carries on counting when a numbered list is split up", () => {
    const blocks = parseMarkdown("1. a\n\nNote\n\n2. b");
    expect(blocks.map((b) => b.tag)).toEqual(["ol", "p", "ol"]);
    expect(blocks[0].start).toBeUndefined();
    expect(blocks[2].start).toBe(2);
  });

  it("keeps code fences literal, closed or not", () => {
    expect(render("```spice\nR1 a b **1k**\n\n- x\n```\nafter")).toBe("<pre>R1 a b **1k**\n\n- x</pre><p>after</p>");
    expect(render("```\nstill arriving")).toBe("<pre>still arriving</pre>");
  });

  it("turns headings into bold lines and drops rules", () => {
    expect(render("## Result ##\ntext\n\n---\n\nmore")).toBe("<p><strong>Result</strong></p><p>text</p><p>more</p>");
  });

  it("only ever produces its own tags, with model text as plain strings", () => {
    const text = `<img src=x onerror="alert(1)">\n\n**<script>x</script>**\n\n- <b onclick=x>\n\n\`<svg>\`\n\n[click](javascript:alert(1))\n\n\`\`\`\n</pre><iframe>\n\`\`\``;
    const tags = new Set<string>();
    const walk = (node: MdNode) => {
      tags.add(node.tag);
      for (const child of node.children) if (typeof child !== "string") walk(child);
    };
    parseMarkdown(text).forEach(walk);
    expect([...tags].every((tag) => ["p", "strong", "em", "code", "ul", "ol", "li", "pre"].includes(tag))).toBe(true);
    expect(render(text)).toContain("[click](javascript:alert(1))");
    expect(render(text)).toContain(`<p><img src=x onerror="alert(1)"></p>`);
  });

  it("copes with empty text", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\n")).toEqual([]);
  });
});
