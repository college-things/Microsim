// Basic Markdown for assistant replies. Tags come only from this file and model text only ever
// becomes text nodes, so a reply can't add markup. Links stay as text, since a model chose them.
export interface MdNode {
  tag: string;
  start?: number;
  children: (MdNode | string)[];
}

// Code comes first so its contents stay literal. An asterisk must hug its text and not sit inside
// a word, so 2*3*4 stays as it is. Older WebKit can't parse a lookbehind, hence the captured prefix.
const INLINE = /`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)?)\*\*|(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g;

function inline(text: string): MdNode["children"] {
  const out: MdNode["children"] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, code, bold, before = "", italic] = match;
    out.push(text.slice(at, match.index) + before);
    if (code !== undefined) out.push({ tag: "code", children: [code] });
    else if (bold !== undefined) out.push({ tag: "strong", children: inline(bold) });
    else out.push({ tag: "em", children: inline(italic) });
    at = match.index + whole.length;
  }
  out.push(text.slice(at));
  return out.filter((child) => child !== "");
}

/** A reply still arriving may end anywhere, so an open code fence or bold just waits for its end. */
export function parseMarkdown(text: string): MdNode[] {
  const blocks: MdNode[] = [];
  let paragraph: string[] = [];
  let list: MdNode | undefined;
  let fence: string[] | undefined;
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ tag: "p", children: inline(paragraph.join("\n")) });
    paragraph = [];
  };
  const endFence = () => {
    if (fence) blocks.push({ tag: "pre", children: [fence.join("\n")] });
    fence = undefined;
  };
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      if (/^\s*```\s*$/.test(line)) endFence();
      else fence.push(line);
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*?)[\s#]*$/.exec(line);
    const item = /^\s*(?:[-*+]|(\d{1,9})[.)])\s+(.*)$/.exec(line);
    if (/^\s*```/.test(line) || heading || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      endParagraph();
      list = undefined;
      if (heading) blocks.push({ tag: "p", children: [{ tag: "strong", children: inline(heading[1]) }] });
      else if (line.includes("```")) fence = [];
    } else if (item) {
      endParagraph();
      const tag = item[1] ? "ol" : "ul";
      if (list?.tag !== tag) {
        list = { tag, children: [] };
        // A numbered list split up by something else carries on counting.
        if (item[1] && Number(item[1]) !== 1) list.start = Number(item[1]);
        blocks.push(list);
      }
      list.children.push({ tag: "li", children: inline(item[2]) });
    } else if (list && /^\s/.test(line)) {
      (list.children.at(-1) as MdNode).children.push("\n", ...inline(line.trim()));
    } else {
      list = undefined;
      paragraph.push(line);
    }
  }
  endParagraph();
  endFence();
  return blocks;
}

function build(node: MdNode): HTMLElement {
  const element = document.createElement(node.tag);
  if (node.start !== undefined) element.setAttribute("start", String(node.start));
  element.append(...node.children.map((child) => (typeof child === "string" ? child : build(child))));
  return element;
}

export function renderMarkdown(text: string): HTMLElement[] {
  return parseMarkdown(text).map(build);
}
