// Substack's feed HTML is its web page markup: each image as a <picture> with
// eight srcset URLs, a fixed width and height, an SVG "expand" button and its
// metadata as JSON. Embeds (equations, tweets, uploaded videos, linked posts)
// render as empty elements whose content sits only in that JSON. One rewriter
// pass turns the embeds into plain HTML and trims images; regex then drops the
// attributes and wrapper tags that touch every element.

const EXPAND_BUTTON = ".image-link-expand";
const LINKED_POST = ".digest-post-embed";

// Buttons that act on the publication rather than link to content.
const PUBLICATION_ACTION = /\/subscribe\b|\/comments?\b|[?&]action=share\b|utm_content=share\b/;

type Attrs = Record<string, unknown>;

/** The HTML that replaces an embed, or null to keep the element as it is. */
function embed(component: string, attrs: Attrs, postUrl: string | undefined): string | null {
  const text = (key: string) => (typeof attrs[key] === "string" ? (attrs[key] as string) : "");
  switch (component) {
    case "LatexBlockToDOM":
      return `<p><code>${escapeHtml(text("persistentExpression"))}</code></p>`;
    case "Youtube2ToDOM":
      return link(`https://www.youtube.com/watch?v=${encodeURIComponent(text("videoId"))}`, "Watch on YouTube");
    case "VimeoToDOM":
      return link(`https://vimeo.com/${encodeURIComponent(text("videoId"))}`, "Watch on Vimeo");
    case "VideoPlaceholder":
      return postUrl ? link(postUrl, "Watch the video in the original post") : "";
    case "Twitter2ToDOM": {
      // The tweet text may carry tags, such as a <span> around an @-handle.
      const body = escapeHtml(decodeEntities(text("full_text").replace(/<[^>]*>/g, ""))).replace(/\n/g, "<br>");
      return `<blockquote><p>${body}</p><p>&#8212; ${link(text("url"), `${text("name")} (@${text("username")})`, false)}</p></blockquote>`;
    }
    case "EmbeddedPostToDOM": {
      const from = text("publication_name");
      return link(text("url"), from ? `${text("title")} (${from})` : text("title"));
    }
    case "MentionToDOM":
      return escapeHtml(text("name"));
    case "ButtonCreateButton":
      return PUBLICATION_ACTION.test(text("url")) ? "" : link(text("url"), text("text"));
    case "SubscribeWidgetToDOM":
    case "PollToDOM":
      return "";
    default:
      return null;
  }
}

function link(href: string, label: string, paragraph = true): string {
  if (!href) return "";
  const a = `<a href="${escapeHtml(href)}">${escapeHtml(label || href)}</a>`;
  return paragraph ? `<p>${a}</p>` : a;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The rewriter returns attribute values as written, entities included.
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(quot|amp|lt|gt|apos));/gi, (_, dec, hex, name: string | undefined) => {
    if (name) return { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" }[name.toLowerCase()]!;
    return String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
  });
}

function readAttrs(el: Element): Attrs {
  try {
    const attrs = JSON.parse(decodeEntities(el.getAttribute("data-attrs") ?? "{}"));
    return attrs && typeof attrs === "object" ? attrs : {};
  } catch {
    return {};
  }
}

/**
 * Plain HTML for one Substack post body. `postUrl` is the post's own page, the
 * link given for uploaded videos, which the feed can't carry.
 */
export async function cleanSubstack(html: string, postUrl?: string): Promise<string> {
  const rewritten = await new HTMLRewriter()
    .on(`[data-component-name], ${LINKED_POST}`, {
      element(el) {
        const attrs = readAttrs(el);
        const replacement = el.getAttribute("class")?.split(" ").includes(LINKED_POST.slice(1))
          ? link(typeof attrs.canonical_url === "string" ? attrs.canonical_url : "", String(attrs.title ?? ""))
          : embed(el.getAttribute("data-component-name")!, attrs, postUrl);
        if (replacement !== null) el.replace(replacement, { html: true });
      },
    })
    .on(`${EXPAND_BUTTON}, picture > source, form`, {
      element(el) {
        el.remove();
      },
    })
    // The image links open the full-size file; Reeder opens its own viewer without them.
    .on("picture, a.image-link", {
      element(el) {
        el.removeAndKeepContent();
      },
    })
    .on("img", {
      element(el) {
        for (const [name] of [...el.attributes]) {
          if (name && name !== "src" && name !== "alt" && name !== "title") el.removeAttribute(name);
        }
      },
    })
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .text();
  return normalise(rewritten);
}

/**
 * Drops styling and editor attributes, then the wrapper tags, then empty
 * paragraphs. Assumes double-quoted attributes with no `>` in their values,
 * which holds for Substack's output (JSON in `data-attrs` is entity-encoded).
 */
function normalise(html: string): string {
  let out = html
    .replace(
      /\s(?:class|style|width|height|srcset|sizes|loading|target|tabindex|contenteditable|aria-hidden|data-[\w-]+)="[^"]*"/g,
      "",
    )
    .replace(/<\/?(?:div|span)\b[^>]*>/g, "");
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/<p>(?:\s|&nbsp;)*<\/p>/g, "");
  }
  return out.trim();
}
