import { describe, expect, it } from "vitest";
import { decodeEntities, htmlSignature } from "../src/index";

describe("htmlSignature", () => {
  it("collects decoded text without whitespace, scripts or styles, and the link lists", async () => {
    const sig = await htmlSignature(
      `<article><p>Fish &amp; chips&nbsp;&#8212; <a href="/a?x=1&amp;y=2">here</a></p>
       <script>var x = "<p>no</p>";</script><style>p { color: red }</style>
       <img src="https://example.com/i.jpg" alt="ignored"><iframe src="https://example.com/v"></iframe><a>bare</a></article>`,
    );
    expect(sig).toEqual({
      text: "Fish&chips—herebare",
      imgSrc: ["https://example.com/i.jpg"],
      aHref: ["/a?x=1&y=2", ""],
      iframeSrc: ["https://example.com/v"],
    });
  });

  it("treats markup differences that change nothing visible as equal", async () => {
    const a = await htmlSignature(`<div class="x"><p>One <b>two</b></p>\n\n<p>three</p></div>`);
    const b = await htmlSignature(`<article><p>One <strong>two</strong></p><p>three</p></article>`);
    expect(a).toEqual(b);
  });

  it("tells apart outputs that lose an iframe", async () => {
    const a = await htmlSignature(`<p>x</p><iframe src="https://example.com/v"></iframe>`);
    const b = await htmlSignature(`<p>x</p>`);
    expect(a).not.toEqual(b);
  });
});

describe("decodeEntities", () => {
  it("decodes numeric and common named entities", () => {
    expect(decodeEntities("&#39;&#x27;&quot;&lt;&gt;&apos;")).toBe(`''"<>'`);
  });

  it("throws on an entity it doesn't know, rather than comparing it raw", () => {
    expect(() => decodeEntities("&hellip;")).toThrow("unknown entity &hellip;");
  });
});
