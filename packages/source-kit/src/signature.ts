// Compares two cleaned articles by what a reader gets from them, not by markup.

/** The parts of an HTML document a reader sees or follows. */
export interface HtmlSignature {
  /** All text outside `script` and `style`, entities decoded, whitespace removed. */
  text: string;
  imgSrc: string[];
  aHref: string[];
  iframeSrc: string[];
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes numeric entities and the common named ones. Throws on any other name, so a comparison never passes by accident. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (_, ref: string) => {
    if (ref[0] === "#") {
      return String.fromCodePoint(ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
    }
    const named = NAMED[ref];
    if (named === undefined) throw new Error(`decodeEntities: unknown entity &${ref};`);
    return named;
  });
}

/** Uses HTMLRewriter, so it runs in workerd (tests and the `inspect` Worker), not in Node. */
export async function htmlSignature(html: string): Promise<HtmlSignature> {
  const text: string[] = [];
  const sig: HtmlSignature = { text: "", imgSrc: [], aHref: [], iframeSrc: [] };
  let hidden = 0;
  const attr = (list: string[], name: string) => ({
    element(el: Element) {
      const value = el.getAttribute(name);
      list.push(value === null ? "" : decodeEntities(value));
    },
  });
  await new HTMLRewriter()
    .on("script, style", {
      element(el) {
        hidden++;
        el.onEndTag(() => {
          hidden--;
        });
      },
    })
    .on("img", attr(sig.imgSrc, "src"))
    .on("a", attr(sig.aHref, "href"))
    .on("iframe", attr(sig.iframeSrc, "src"))
    .onDocument({
      text(chunk) {
        if (!hidden) text.push(chunk.text);
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .arrayBuffer();
  sig.text = decodeEntities(text.join("")).replace(/\s+/g, "");
  return sig;
}
