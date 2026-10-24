import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineEnv, fakeOrigin, setup, testConfig, type Worker } from "./fakes";

const devEnv = { ...engineEnv, DEV_ROUTES: "1" };

describe("/dev/clean", () => {
  let worker: Worker;
  beforeEach(async () => {
    worker = await setup(testConfig([{ key: "a", source: "fake-article", enabled: true, title: "A", options: { url: "https://example.com/feed" } }]));
  });
  afterEach(() => vi.restoreAllMocks());

  it("is not served unless DEV_ROUTES is 1", async () => {
    const res = await worker.fetch(new Request("https://rss8.test/dev/clean/fake-article/7"), engineEnv);
    expect(res.status).toBe(404);
  });

  it("fetches and processes an item's page in a Runner object", async () => {
    const requests = fakeOrigin({ "https://example.com/article/7": () => new Response("  hello ") });
    const res = await worker.fetch(new Request("https://rss8.test/dev/clean/fake-article/7?page=1"), devEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "HELLO", details: { bytes: 8 }, page: "  hello " });
    expect(requests.map((r) => r.url)).toEqual(["https://example.com/article/7"]);
  });

  it("processes a posted page up to a stage without fetching", async () => {
    const requests = fakeOrigin({});
    const res = await worker.fetch(
      new Request("https://rss8.test/dev/clean/fake-article/7?stage=trim", { method: "POST", body: " saved " }),
      devEnv,
    );
    expect(await res.json()).toEqual({ content: "saved", details: { bytes: 7 } });
    expect(requests).toEqual([]);
  });

  it("reports an unknown stage, an unknown kind and a source without hooks", async () => {
    const post = (path: string) => worker.fetch(new Request(`https://rss8.test${path}`, { method: "POST", body: "x" }), devEnv);
    const stage = await post("/dev/clean/fake-article/7?stage=nope&page=1");
    expect([stage.status, await stage.json()]).toEqual([422, { error: 'Unknown stage "nope"', page: "x" }]);
    const kind = await post("/dev/clean/nope/7");
    expect([kind.status, await kind.text()]).toEqual([500, 'No source registered for kind "nope"']);
    const hooks = await post("/dev/clean/fake-feed/7");
    expect(hooks.status).toBe(404);
  });
});
