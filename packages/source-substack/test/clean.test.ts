import { parseFeed, type DiscoverContext, type FeedFetch } from "@rss8/engine";
import type { RssOptions } from "@rss8/source-rss";
import { describe, expect, it } from "vitest";
import substack, { cleanSubstack } from "../src/index";

// Synthetic markup shaped like Substack's feed output: example.com hosts, made-up ids.
const POST = "https://news.example.com/p/a-post";
const CDN = "https://cdn.example.com/image/fetch";

const attrs = (value: unknown) => JSON.stringify(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const srcset = (format: string) =>
  [424, 848, 1272, 1456].map((w) => `${CDN}/w_${w},f_${format}/photo.png ${w}w`).join(", ");

const FIGURE = `<div class="captioned-image-container"><figure><a class="image-link image2 is-viewable-img" target="_blank" href="${CDN}/f_auto/photo.png" data-component-name="Image2ToDOM"><div class="image2-inset"><picture><source type="image/webp" srcset="${srcset("webp")}" sizes="100vw"><img src="${CDN}/w_1456,f_auto/photo.png" width="1456" height="819" data-attrs="${attrs({ src: "https://media.example.com/photo.png", height: 819, width: 1456, bytes: 1234 })}" class="sizing-normal" alt="A chart" title="Figure 1" srcset="${srcset("auto")}" sizes="100vw" loading="lazy"></picture><div class="image-link-expand"><div class="pencraft pc-display-flex pc-gap-8 pc-reset"><button tabindex="0" type="button" class="pencraft pc-reset icon-container restack-image"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke-width="1.5" class="icon"><path d="M2 7L17 8"></path></svg></button><button tabindex="0" type="button" class="pencraft pc-reset icon-container view-image"><svg class="lucide lucide-maximize2" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"></polyline><line x1="14" x2="21" y1="10" y2="3"></line></svg></button></div></div></div></a><figcaption class="image-caption">Figure 1: A chart.</figcaption></figure></div>`;

describe("cleanSubstack", () => {
  it("reduces an image to one img with its caption", async () => {
    expect(await cleanSubstack(`<p>Before</p>${FIGURE}<p>After</p>`)).toBe(
      `<p>Before</p><figure><img src="${CDN}/w_1456,f_auto/photo.png" alt="A chart" title="Figure 1"><figcaption>Figure 1: A chart.</figcaption></figure><p>After</p>`,
    );
  });

  it("keeps code blocks, footnotes and plain text", async () => {
    const html =
      `<p>Text<a class="footnote-anchor" data-component-name="FootnoteAnchorToDOM" id="footnote-anchor-1" href="#footnote-1" target="_self">1</a> &amp; more.</p>` +
      `<div class="highlighted_code_block" data-attrs="${attrs({ language: "bash", nodeId: "n1" })}" data-component-name="HighlightedCodeBlockToDOM"><pre class="shiki"><code class="language-bash">echo "a &lt;b&gt;"\n  indented</code></pre></div>` +
      `<div><hr></div><p></p>` +
      `<div class="footnote" data-component-name="FootnoteToDOM"><a id="footnote-1" href="#footnote-anchor-1" class="footnote-number" contenteditable="false" target="_self">1</a><div class="footnote-content"><p><span>The note.</span></p></div></div>`;
    expect(await cleanSubstack(html)).toBe(
      `<p>Text<a id="footnote-anchor-1" href="#footnote-1">1</a> &amp; more.</p>` +
        `<pre><code>echo "a &lt;b&gt;"\n  indented</code></pre>` +
        `<hr>` +
        `<a id="footnote-1" href="#footnote-anchor-1">1</a><p>The note.</p>`,
    );
  });

  it("writes out embeds whose content is only in their JSON", async () => {
    const html =
      `<div class="latex-rendered" data-attrs="${attrs({ persistentExpression: "a < b & c", id: "X" })}" data-component-name="LatexBlockToDOM"></div>` +
      `<div id="youtube2-abc" class="youtube-wrap" data-attrs="${attrs({ videoId: "abc", startTime: null })}" data-component-name="Youtube2ToDOM"><div class="youtube-inner"><iframe src="https://www.youtube-nocookie.com/embed/abc" width="728" height="409"></iframe></div></div>` +
      `<div id="vimeo-42" class="vimeo-wrap" data-attrs="${attrs({ videoId: "42" })}" data-component-name="VimeoToDOM"><div class="vimeo-inner"><iframe src="https://player.vimeo.com/video/42"></iframe></div></div>` +
      `<div class="native-video-embed" data-component-name="VideoPlaceholder" data-attrs="${attrs({ mediaUploadId: "u1" })}"></div>` +
      `<div class="twitter-embed" data-attrs="${attrs({ url: "https://social.example/s/1", full_text: '<span class="tweet-fake-link">@other</span> Line one &amp;\nLine "two"',username: "someone", name: "Some One" })}" data-component-name="Twitter2ToDOM"></div>` +
      `<div class="embedded-post-wrap" data-attrs="${attrs({ url: "https://other.example.com/p/x", title: "Another Post", publication_name: "Other" })}" data-component-name="EmbeddedPostToDOM"></div>` +
      `<div class="digest-post-embed" data-attrs="${attrs({ title: "An Older Post", canonical_url: "https://news.example.com/p/older" })}"></div>` +
      `<p>Thanks to <span class="mention-wrap" data-attrs="${attrs({ name: "A. Person", id: 1 })}" data-component-name="MentionToDOM"></span>.</p>`;
    expect(await cleanSubstack(html, POST)).toBe(
      `<p><code>a &lt; b &amp; c</code></p>` +
        `<p><a href="https://www.youtube.com/watch?v=abc">Watch on YouTube</a></p>` +
        `<p><a href="https://vimeo.com/42">Watch on Vimeo</a></p>` +
        `<p><a href="${POST}">Watch the video in the original post</a></p>` +
        `<blockquote><p>@other Line one &amp;<br>Line &quot;two&quot;</p><p>&#8212; <a href="https://social.example/s/1">Some One (@someone)</a></p></blockquote>` +
        `<p><a href="https://other.example.com/p/x">Another Post (Other)</a></p>` +
        `<p><a href="https://news.example.com/p/older">An Older Post</a></p>` +
        `<p>Thanks to A. Person.</p>`,
    );
  });

  it("drops subscribe and share prompts and polls, but keeps other buttons as links", async () => {
    const button = (url: string, text: string) =>
      `<p class="button-wrapper" data-attrs="${attrs({ url, text, action: null })}" data-component-name="ButtonCreateButton"><a class="button primary" href="${url}"><span>${text}</span></a></p>`;
    const html =
      `<div class="subscription-widget-wrap-editor" data-attrs="${attrs({ url: `${POST}/subscribe?`, text: "Subscribe" })}" data-component-name="SubscribeWidgetToDOM"><div class="subscription-widget show-subscribe"><form class="subscription-widget-subscribe"><input type="email" class="email-input" name="email" placeholder="Type your email…"><input type="submit" class="button primary" value="Subscribe"></form></div></div>` +
      button("https://news.example.com/subscribe?", "Subscribe now") +
      button(`${POST}?utm_source=substack&utm_medium=email&utm_content=share&action=share`, "Share") +
      button(`${POST}/comments`, "Leave a comment") +
      button("https://files.example.com/slides.pdf", "Download the slides") +
      `<div class="poll-embed" data-attrs="${attrs({ id: 7 })}" data-component-name="PollToDOM"></div>`;
    expect(await cleanSubstack(html, POST)).toBe(`<p><a href="https://files.example.com/slides.pdf">Download the slides</a></p>`);
  });

  it("drops an uploaded video when the post has no link", async () => {
    expect(await cleanSubstack(`<div class="native-video-embed" data-component-name="VideoPlaceholder"></div><p>Text</p>`)).toBe("<p>Text</p>");
  });

  it("leaves the content of an unknown embed in place", async () => {
    expect(await cleanSubstack(`<div class="new-thing" data-component-name="NewThingToDOM"><p>Inside</p></div>`)).toBe("<p>Inside</p>");
  });
});

describe("discover", () => {
  const URL_ = "https://news.example.com/feed";
  const feed = { id: 1, key: "news", title: "News" };
  const ctx = (res: FeedFetch): DiscoverContext<RssOptions, unknown> => ({
    options: { url: URL_ },
    fetch: () => Promise.reject(new Error("unexpected fetch")),
    log: () => {},
    fetchFeed: async () => res,
    parseFeed,
    state: { get: () => undefined, set: () => {} },
  });

  it("cleans each entry's content and names the guid after the source", async () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0"><channel><title>News</title>
      <item><title>A Post</title><description>Subtitle</description><link>${POST}</link><guid isPermaLink="false">${POST}</guid><pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Hi</p>${FIGURE}<div class="native-video-embed" data-component-name="VideoPlaceholder"></div>]]></content:encoded></item>
    </channel></rss>`;
    expect(await substack.discover(feed, ctx({ notModified: false, text, truncated: false }))).toEqual([
      {
        guid: `substack-news-${POST}`,
        url: POST,
        title: "A Post",
        summary: "Subtitle",
        content: `<p>Hi</p><figure><img src="${CDN}/w_1456,f_auto/photo.png" alt="A chart" title="Figure 1"><figcaption>Figure 1: A chart.</figcaption></figure><p><a href="${POST}">Watch the video in the original post</a></p>`,
        published: Date.parse("2026-10-22T10:00:00Z") / 1000,
      },
    ]);
  });

  it("returns nothing on 304", async () => {
    expect(await substack.discover(feed, ctx({ notModified: true }))).toEqual([]);
  });
});
