import { parseFeed, type DiscoverContext, type FeedFetch } from "@rss8/engine";
import { describe, expect, it } from "vitest";
import rss, { parseRssOptions, type RssOptions } from "../src/index";

const URL_ = "https://example.com/feed";
const feed = { id: 1, key: "example", title: "Example" };

function discoverContext(res: FeedFetch): DiscoverContext<RssOptions, unknown> {
  return {
    options: { url: URL_ },
    fetch: () => Promise.reject(new Error("unexpected fetch")),
    log: () => {},
    fetchFeed: async (url) => {
      if (url !== URL_) throw new Error(`unexpected feed ${url}`);
      return res;
    },
    parseFeed,
    state: { get: () => undefined, set: () => {} },
  };
}

const xml = (text: string): FeedFetch => ({ notModified: false, text, truncated: false });

// Shaped like a link blog's Atom feed: an external alternate link, a related
// permalink, and the article as CDATA HTML.
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Example</title>
<link rel="alternate" type="text/html" href="https://example.com/" />
<id>https://example.com/feed</id>
<updated>2026-10-23T17:05:55Z</updated><entry>
  <title>Someone Else&#8217;s Review</title>
  <link rel="alternate" type="text/html" href="https://elsewhere.example/review" />
  <link rel="related" type="text/html" href="https://example.com/linked/2026/10/23/review" />
  <id>tag:example.com,2026:/linked//6.1</id>
  <published>2026-10-23T16:52:56Z</published>
  <updated>2026-10-23T17:05:55Z</updated>
  <author><name>A. Writer</name></author>
  <content type="html" xml:base="https://example.com/linked/"><![CDATA[
<p>Quoted <a href="https://elsewhere.example/">text</a>.</p>
]]></content>
</entry>
<entry>
  <title>An Essay</title>
  <link rel="alternate" type="text/html" href="https://example.com/2026/10/essay" />
  <id>tag:example.com,2026:/essays/2</id>
  <published>2026-10-22T10:00:00Z</published>
  <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
</entry>
</feed>`;

describe("parseOptions", () => {
  it("accepts an http or https URL", () => {
    expect(parseRssOptions({ url: URL_ })).toEqual({ url: URL_ });
    expect(parseRssOptions({ url: "http://example.com/rss" })).toEqual({ url: "http://example.com/rss" });
  });

  it.each([undefined, {}, { url: 1 }, { url: "example.com/feed" }, { url: "ftp://example.com/feed" }])("rejects %j", (raw) => {
    expect(() => parseRssOptions(raw)).toThrow("options.url");
  });
});

describe("discover", () => {
  it("lists each entry complete, with a guid naming the feed and the entry id", async () => {
    expect(await rss.discover(feed, discoverContext(xml(ATOM)))).toEqual([
      {
        guid: "rss-example-tag:example.com,2026:/linked//6.1",
        url: "https://elsewhere.example/review",
        title: "Someone Else’s Review",
        content: '<p>Quoted <a href="https://elsewhere.example/">text</a>.</p>',
        author: "A. Writer",
        published: Date.parse("2026-10-23T16:52:56Z") / 1000,
        updated: Date.parse("2026-10-23T17:05:55Z") / 1000,
      },
      {
        guid: "rss-example-tag:example.com,2026:/essays/2",
        url: "https://example.com/2026/10/essay",
        title: "An Essay",
        content: "<p>Body</p>",
        published: Date.parse("2026-10-22T10:00:00Z") / 1000,
      },
    ]);
  });

  it("falls back to the link when an RSS item has no guid, and skips items with neither", async () => {
    const text = `<rss><channel>
      <item><link>https://example.com/a</link><title>A</title><description>Summary</description></item>
      <item><title>No id</title></item>
    </channel></rss>`;
    expect(await rss.discover(feed, discoverContext(xml(text)))).toEqual([
      { guid: "rss-example-https://example.com/a", url: "https://example.com/a", title: "A", summary: "Summary" },
    ]);
  });

  it("returns nothing on 304", async () => {
    expect(await rss.discover(feed, discoverContext({ notModified: true }))).toEqual([]);
  });

  it("has no fetchArticle, so the engine stores its items as ok", () => {
    expect(rss.fetchArticle).toBeUndefined();
  });
});
