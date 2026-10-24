import { describe, expect, it } from "vitest";
import { engineEnv, setup, testConfig } from "./fakes";

describe("GET /health", () => {
  it("reports the running version's tag and id", async () => {
    const worker = await setup(testConfig([]));
    const CF_VERSION_METADATA = { id: "0b1c2d3e-version", tag: "2026-1024-abcdef1", timestamp: "2026-10-24T00:00:00Z" };
    const res = await worker.fetch(new Request("https://rss8.test/health"), { ...engineEnv, CF_VERSION_METADATA });
    expect(await res.json()).toEqual({ status: "ok", version: "2026-1024-abcdef1", versionId: "0b1c2d3e-version" });
  });

  it("reports null versions without the binding", async () => {
    const worker = await setup(testConfig([]));
    const { CF_VERSION_METADATA: _, ...env } = engineEnv;
    const res = await worker.fetch(new Request("https://rss8.test/health"), env);
    expect(await res.json()).toEqual({ status: "ok", version: null, versionId: null });
  });
});
