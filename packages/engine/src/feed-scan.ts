// An indexOf-based RSS 2.0/0.9x, RDF and Atom 1.0/0.3 scanner. It reads only
// the fields the engine stores and returns every complete item in document
// order. A last item without its closing tag (a body cut at the byte cap) is
// dropped. A full XML parser costs more CPU for the same result.

export interface FeedEntry {
  id?: string;
  title?: string;
  url?: string;
  summary?: string;
  content?: string;
  author?: string;
  /** Epoch seconds. */
  published?: number;
  /** Epoch seconds. */
  updated?: number;
}

export function parseFeed(xml: string): FeedEntry[] {
  if (xml.includes("<!--")) xml = xml.replace(/<!--[\s\S]*?-->/g, "");
  const atom = rootElement(xml).replace(/^.*:/, "") === "feed";
  const open = atom ? "<entry" : "<item";
  const close = atom ? "</entry>" : "</item>";
  const entries: FeedEntry[] = [];
  let i = 0;
  while ((i = xml.indexOf(open, i)) !== -1) {
    if (!endsName(xml.charCodeAt(i + open.length))) {
      i += open.length;
      continue;
    }
    const end = xml.indexOf(close, i);
    if (end === -1) break;
    const block = xml.slice(i + open.length, end);
    entries.push(atom ? atomEntry(block) : rssItem(block));
    i = end + close.length;
  }
  return entries;
}

function rssItem(b: string): FeedEntry {
  return clean({
    id: text(b, "guid"),
    title: text(b, "title"),
    url: text(b, "link"),
    summary: text(b, "description"),
    content: text(b, "content:encoded"),
    author: text(b, "dc:creator") ?? text(b, "author"),
    published: date(text(b, "pubDate") ?? text(b, "dc:date")),
    updated: date(text(b, "dc:modified")),
  });
}

function atomEntry(b: string): FeedEntry {
  const author = raw(b, "author");
  return clean({
    id: text(b, "id"),
    title: text(b, "title"),
    url: atomLink(b),
    summary: text(b, "summary"),
    content: text(b, "content"),
    author: author === undefined ? undefined : (text(author, "name") ?? decode(author)),
    published: date(text(b, "published") ?? text(b, "issued")),
    updated: date(text(b, "updated") ?? text(b, "modified")),
  });
}

function rootElement(xml: string): string {
  return /<(?![?!])([A-Za-z_][\w:.-]*)/.exec(xml)?.[1] ?? "";
}

// After `<name`, the next character must end the name (`>`, `/` or whitespace),
// so `<item` does not match `<items>`.
function endsName(ch: number): boolean {
  return ch === 62 || ch === 47 || ch === 32 || ch === 10 || ch === 13 || ch === 9;
}

/** The raw inner XML of the first `<name>` element, or undefined (also for `<name/>`). */
function raw(block: string, name: string): string | undefined {
  const open = "<" + name;
  let s = block.indexOf(open);
  while (s !== -1 && !endsName(block.charCodeAt(s + open.length))) s = block.indexOf(open, s + 1);
  if (s === -1) return undefined;
  const gt = block.indexOf(">", s);
  if (gt === -1 || block.charCodeAt(gt - 1) === 47) return undefined;
  const e = block.indexOf("</" + name + ">", gt);
  return e === -1 ? undefined : block.slice(gt + 1, e);
}

function text(block: string, name: string): string | undefined {
  const inner = raw(block, name);
  if (inner === undefined) return undefined;
  const value = decode(inner);
  return value === "" ? undefined : value;
}

function atomLink(block: string): string | undefined {
  let first: string | undefined;
  let s = 0;
  while ((s = block.indexOf("<link", s)) !== -1) {
    const gt = block.indexOf(">", s);
    if (gt === -1) break;
    const attrs = block.slice(s, gt);
    s = gt;
    if (!endsName(attrs.charCodeAt(5))) continue;
    const href = /\bhref\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    if (href === undefined) continue;
    const rel = /\brel\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    if (rel === undefined || rel === "alternate") return entities(href);
    first ??= entities(href);
  }
  return first;
}

/** Text content: CDATA sections verbatim, entities decoded outside them, trimmed. */
function decode(s: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const c = s.indexOf("<![CDATA[", i);
    if (c === -1) {
      out += entities(s.slice(i));
      break;
    }
    out += entities(s.slice(i, c));
    const e = s.indexOf("]]>", c + 9);
    if (e === -1) {
      out += s.slice(c + 9);
      break;
    }
    out += s.slice(c + 9, e);
    i = e + 3;
  }
  return out.trim();
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function entities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, g: string) => {
    if (g[0] !== "#") return NAMED[g] ?? m;
    const n = g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  });
}

function date(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function clean(entry: FeedEntry): FeedEntry {
  for (const key of Object.keys(entry) as (keyof FeedEntry)[]) {
    if (entry[key] === undefined) delete entry[key];
  }
  return entry;
}
