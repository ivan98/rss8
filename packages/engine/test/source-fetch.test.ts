import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, readCapped } from "../src/context";

function respondWith(make: (signal: AbortSignal) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => make(init!.signal!));
}

/** The timer fetchWithTimeout sets, and whether it has been cleared. */
function watchTimer() {
  const set = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  return () => clear.mock.calls.some(([id]) => id === set.mock.results[0]?.value);
}

describe("fetchWithTimeout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clears its timer once the body has been read, not before", async () => {
    respondWith(() => new Response("hello"));
    const cleared = watchTimer();
    const res = await fetchWithTimeout("https://example.com/", {}, 20_000);
    expect(cleared()).toBe(false);
    expect(await res.text()).toBe("hello");
    expect(cleared()).toBe(true);
  });

  it("clears its timer when the body is cancelled", async () => {
    respondWith(() => new Response("hello"));
    const cleared = watchTimer();
    const res = await fetchWithTimeout("https://example.com/", {}, 20_000);
    await res.body!.cancel();
    expect(cleared()).toBe(true);
  });

  it("clears its timer at once for a response without a body", async () => {
    respondWith(() => new Response(null, { status: 304 }));
    const cleared = watchTimer();
    const res = await fetchWithTimeout("https://example.com/", {}, 20_000);
    expect(res.status).toBe(304);
    expect(cleared()).toBe(true);
  });

  it("fails a body that stalls past the deadline", async () => {
    respondWith(() => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })));
    const res = await fetchWithTimeout("https://example.com/", {}, 50);
    await expect(res.text()).rejects.toThrow("timed out after 50 ms");
  });

  it("fails when the headers don't arrive before the deadline", async () => {
    respondWith(
      (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    );
    await expect(fetchWithTimeout("https://example.com/", {}, 50)).rejects.toThrow("timed out after 50 ms");
  });

  it("keeps the status, headers, final URL and a body a BYOB reader can read", async () => {
    respondWith(() => {
      const res = new Response("hello world", { status: 201, headers: { etag: '"1"' } });
      Object.defineProperties(res, { url: { value: "https://example.com/final" }, redirected: { value: true } });
      return res;
    });
    const res = await fetchWithTimeout("https://example.com/start", {}, 20_000);
    expect([res.status, res.headers.get("etag"), res.url, res.redirected]).toEqual([201, '"1"', "https://example.com/final", true]);
    expect(await readCapped(res.body, 4)).toEqual({ text: "hell", truncated: true });
  });
});
