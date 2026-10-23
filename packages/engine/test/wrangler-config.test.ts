import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { MAX_RETRIES } from "../src/messages";
import { TICK_MINUTES } from "../src/worker";

it("consumes one message at a time with the retry count the consumer assumes", () => {
  expect(JSON.parse(env.TEST_QUEUE_CONSUMERS)).toEqual([
    { queue: "rss8", max_batch_size: 1, max_retries: MAX_RETRIES },
  ]);
});

it("has a single cron trigger at the interval the dispatcher assumes", () => {
  expect(TICK_MINUTES).toBe(15);
  expect(JSON.parse(env.TEST_CRONS)).toEqual(["0,15,30,45 * * * *"]);
});
