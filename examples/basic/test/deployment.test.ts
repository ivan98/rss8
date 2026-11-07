import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { assertTriggerFitsTimezone, MAX_RETRIES } from "@rss8/engine";
import config from "../rss8.config";
import { Runner } from "../src/index";

describe("example deployment", () => {
  it("runs the re-exported Runner class with usable SQLite storage", async () => {
    const stub = env.RUNNER.getByName("feed:test");
    const value = await runInDurableObject(stub, (instance, state) => {
      expect(instance).toBeInstanceOf(Runner);
      state.storage.sql.exec("CREATE TABLE t (v TEXT)");
      state.storage.sql.exec("INSERT INTO t (v) VALUES (?)", "stored");
      return state.storage.sql.exec<{ v: string }>("SELECT v FROM t").one().v;
    });
    expect(value).toBe("stored");
  });

  it("serves the Google Reader mount from the Api object", async () => {
    const res = await env.API.getByName("api").fetch("https://rss8.test/api/greader.php");
    expect(await res.text()).toBe("OK");
  });

  it("answers GET /health with 200", async () => {
    const res = await exports.default.fetch("https://rss8.test/health");
    expect(res.status).toBe(200);
  });

  it("answers an unknown path with 404", async () => {
    const res = await exports.default.fetch("https://rss8.test/nope");
    expect(res.status).toBe(404);
  });

  it("consumes one message at a time with the retry count the consumer assumes", () => {
    expect(JSON.parse(env.TEST_QUEUE_CONSUMERS)).toEqual([
      { queue: "rss8", max_batch_size: 1, max_retries: MAX_RETRIES },
    ]);
  });

  it("has a single cron trigger that ticks on the same minutes in the config time zone", () => {
    const crons: string[] = JSON.parse(env.TEST_CRONS);
    expect(crons).toHaveLength(1);
    assertTriggerFitsTimezone(crons[0]!, config.timezone);
  });
});
