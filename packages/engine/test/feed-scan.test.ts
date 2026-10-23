import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/feed-scan";

const epoch = (iso: string) => Date.parse(iso) / 1000;

describe("parseFeed", () => {
  it("reads RSS 2.0 items with CDATA, entities and namespaced fields", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Example</title><link>https://example.com/</link>
<item>
  <title>Tea &amp; biscuits &#8212; a review</title>
  <link>https://example.com/posts/1?a=1&amp;b=2</link>
  <guid isPermaLink="false">post-1</guid>
  <pubDate>Mon, 19 Oct 2026 08:30:00 +0800</pubDate>
  <dc:creator>Ada Example</dc:creator>
  <description><![CDATA[<p>Short &amp; sweet</p>]]></description>
  <content:encoded><![CDATA[<p>Full text</p>]]></content:encoded>
</item>
<item><title>Second</title><link>https://example.com/posts/2</link></item>
</channel></rss>`;

    expect(parseFeed(xml)).toEqual([
      {
        id: "post-1",
        title: "Tea & biscuits — a review",
        url: "https://example.com/posts/1?a=1&b=2",
        summary: "<p>Short &amp; sweet</p>",
        content: "<p>Full text</p>",
        author: "Ada Example",
        published: epoch("2026-10-19T00:30:00Z"),
      },
      { title: "Second", url: "https://example.com/posts/2" },
    ]);
  });

  it("reads Atom 1.0 entries and prefers the alternate link", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title>
<link rel="self" href="https://example.com/atom.xml"/>
<entry>
  <id>tag:example.com,2026:1</id>
  <title type="html">A &lt;b&gt;bold&lt;/b&gt; title</title>
  <link rel="replies" href="https://example.com/1#comments"/>
  <link rel="alternate" type="text/html" href="https://example.com/1"/>
  <published>2026-10-19T08:00:00Z</published>
  <updated>2026-10-20T09:00:00+08:00</updated>
  <author><name>Ben Example</name><email>ben@example.com</email></author>
  <summary>Summary</summary>
  <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
</entry>
<entry><id>tag:example.com,2026:2</id><title>No rel</title><link href="https://example.com/2"/></entry>
</feed>`;

    expect(parseFeed(xml)).toEqual([
      {
        id: "tag:example.com,2026:1",
        title: "A <b>bold</b> title",
        url: "https://example.com/1",
        summary: "Summary",
        content: "<p>Body</p>",
        author: "Ben Example",
        published: epoch("2026-10-19T08:00:00Z"),
        updated: epoch("2026-10-20T01:00:00Z"),
      },
      { id: "tag:example.com,2026:2", title: "No rel", url: "https://example.com/2" },
    ]);
  });

  it("reads Atom 0.3 entries", () => {
    const xml = `<feed version="0.3" xmlns="http://purl.org/atom/ns#">
<entry><title>Old style</title><link rel="alternate" type="text/html" href="https://example.com/old"/>
<id>old-1</id><issued>2004-01-02T03:04:05Z</issued><modified>2004-01-03T03:04:05Z</modified></entry>
</feed>`;
    expect(parseFeed(xml)).toEqual([
      {
        id: "old-1",
        title: "Old style",
        url: "https://example.com/old",
        published: epoch("2004-01-02T03:04:05Z"),
        updated: epoch("2004-01-03T03:04:05Z"),
      },
    ]);
  });

  it("reads RDF (RSS 1.0) items outside the channel and ignores <items>", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://example.com/"><title>Example</title>
<items><rdf:Seq><rdf:li rdf:resource="https://example.com/r1"/></rdf:Seq></items></channel>
<item rdf:about="https://example.com/r1"><title>RDF one</title><link>https://example.com/r1</link>
<dc:date>2026-10-19T10:00:00+08:00</dc:date></item>
</rdf:RDF>`;
    expect(parseFeed(xml)).toEqual([
      { title: "RDF one", url: "https://example.com/r1", published: epoch("2026-10-19T02:00:00Z") },
    ]);
  });

  it("reads RSS 0.91 items", () => {
    const xml = `<rss version="0.91"><channel><title>Old</title>
<item><title>Plain</title><link>https://example.com/p</link><description>Text</description></item>
</channel></rss>`;
    expect(parseFeed(xml)).toEqual([{ title: "Plain", url: "https://example.com/p", summary: "Text" }]);
  });

  it("ignores items inside XML comments", () => {
    const xml = `<rss><channel><!-- <item><title>Hidden</title></item> -->
<item><title>Shown</title></item></channel></rss>`;
    expect(parseFeed(xml)).toEqual([{ title: "Shown" }]);
  });

  it("drops a last item cut off before its closing tag", () => {
    const xml = `<rss><channel><item><title>One</title></item><item><title>Two</title><descr`;
    expect(parseFeed(xml)).toEqual([{ title: "One" }]);
  });

  it("returns every item, not only the first 100", () => {
    const items = Array.from({ length: 150 }, (_, i) => `<item><guid>${i}</guid></item>`).join("");
    expect(parseFeed(`<rss><channel>${items}</channel></rss>`)).toHaveLength(150);
  });

  it("leaves out an unparseable date", () => {
    expect(parseFeed("<rss><channel><item><title>x</title><pubDate>someday</pubDate></item></channel></rss>")).toEqual([
      { title: "x" },
    ]);
  });
});
