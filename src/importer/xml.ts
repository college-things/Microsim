// Small XML scanner that keeps attribute text raw, so huge values cost nothing until they are read.

export interface XmlNode {
  tag: string;
  /** Raw attribute text, entities still encoded. Read through textValue() or decodeEntities(). */
  attrs: Record<string, string>;
  children: XmlNode[];
}

const NO_CHILDREN: XmlNode[] = [];

const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9;

/** Converts single-byte text to a string, dropping stray NUL bytes. */
export function bytesToText(bytes: Uint8Array): string {
  const clean = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) clean[n++] = bytes[i];
  }
  const parts: string[] = [];
  const STEP = 0x8000;
  for (let i = 0; i < n; i += STEP) {
    parts.push(String.fromCharCode.apply(null, clean.subarray(i, Math.min(i + STEP, n)) as unknown as number[]));
  }
  return parts.join("");
}

export function parseXml(text: string): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const length = text.length;
  let i = 0;
  const bad = (what: string) => new Error(`Corrupt circuit file: ${what} in XML at offset ${i}.`);

  while (i < length) {
    const open = text.indexOf("<", i);
    if (open < 0) break;
    i = open + 1;
    const next = text.charCodeAt(i);
    if (next === 63 /* ? */) {
      const close = text.indexOf("?>", i);
      if (close < 0) throw bad("unterminated declaration");
      i = close + 2;
      continue;
    }
    if (next === 33 /* ! */) {
      let closer = ">";
      if (text.startsWith("!--", i)) closer = "-->";
      else if (text.startsWith("![CDATA[", i)) closer = "]]>";
      const close = text.indexOf(closer, i);
      if (close < 0) throw bad("unterminated markup");
      i = close + closer.length;
      continue;
    }
    if (next === 47 /* / */) {
      const close = text.indexOf(">", i);
      if (close < 0) throw bad("unterminated end tag");
      const name = text.slice(i + 1, close).trim();
      const top = stack.pop();
      if (!top || top.tag !== name) throw bad(`mismatched end tag </${name}>`);
      i = close + 1;
      continue;
    }

    let j = i;
    while (j < length) {
      const c = text.charCodeAt(j);
      if (isSpace(c) || c === 47 || c === 62) break;
      j++;
    }
    const tag = text.slice(i, j);
    if (!tag) throw bad("empty tag name");
    const attrs: Record<string, string> = Object.create(null);
    i = j;
    let selfClosed = false;
    for (;;) {
      while (isSpace(text.charCodeAt(i))) i++;
      if (i >= length) throw bad("unterminated tag");
      const c = text.charCodeAt(i);
      if (c === 62 /* > */) {
        i++;
        break;
      }
      if (c === 47 /* / */) {
        if (text.charCodeAt(i + 1) !== 62) throw bad("bad tag end");
        i += 2;
        selfClosed = true;
        break;
      }
      const eq = text.indexOf("=", i);
      if (eq < 0) throw bad("bad attribute");
      const name = text.slice(i, eq).trim();
      let q = eq + 1;
      while (isSpace(text.charCodeAt(q))) q++;
      const quote = text[q];
      if (quote !== '"' && quote !== "'") throw bad("unquoted attribute");
      const end = text.indexOf(quote, q + 1);
      if (end < 0) throw bad("unterminated attribute");
      attrs[name] = text.slice(q + 1, end);
      i = end + 1;
    }
    const node: XmlNode = { tag, attrs, children: NO_CHILDREN };
    const parent = stack[stack.length - 1];
    if (parent) {
      if (parent.children === NO_CHILDREN) parent.children = [node];
      else parent.children.push(node);
    } else if (!root) {
      root = node;
    } else {
      throw bad("second root element");
    }
    if (!selfClosed) stack.push(node);
  }
  if (stack.length) throw new Error(`Corrupt circuit file: XML ends inside <${stack[stack.length - 1].tag}>.`);
  if (!root) throw new Error("Corrupt circuit file: no XML content.");
  return root;
}

export function child(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) if (c.tag === tag) return c;
  return undefined;
}

/** Follows a path of first-matching children. */
export function path(node: XmlNode | undefined, ...tags: string[]): XmlNode | undefined {
  let at = node;
  for (const tag of tags) at = child(at, tag);
  return at;
}

export function kids(node: XmlNode | undefined): XmlNode[] {
  return node ? node.children : NO_CHILDREN;
}

/** Calls visit on a node and all its descendants, iteratively so deep trees cannot overflow. */
export function walk(root: XmlNode, visit: (node: XmlNode) => void): void {
  const stack: XmlNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

const ENTITY = /&(amp|lt|gt|quot|apos);/g;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(raw: string): string {
  return raw.indexOf("&") < 0 ? raw : raw.replace(ENTITY, (_, name: string) => ENTITIES[name]);
}

/** Decodes a string value, removing the &ASC prefix or expanding the &UNI escaped form. */
export function textValue(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.startsWith("&amp;ASC")) {
    const body = raw.slice(8);
    return body.indexOf("&") < 0 ? body : decodeEntities(body);
  }
  const decoded = decodeEntities(raw);
  if (decoded.startsWith("&ASC")) return decoded.slice(4);
  if (decoded.startsWith("&UNI")) {
    return decoded.slice(4).replace(/_uc1([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return decoded;
}
