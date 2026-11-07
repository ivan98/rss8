// The deployment entry: register the sources this deployment uses, and
// re-export the engine's Durable Object classes under the names that
// wrangler.jsonc binds.
import { createWorker } from "@rss8/engine";
import rss from "@rss8/source-rss";
import substack from "@rss8/source-substack";
import config from "../rss8.config";

export { Runner, Api } from "@rss8/engine";
export default createWorker({ sources: [rss, substack], config });
