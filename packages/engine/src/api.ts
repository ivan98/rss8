import { DurableObject } from "cloudflare:workers";
import type { EngineEnv } from "./env";
import { handleGreader } from "./greader";

/** Serves the Google Reader API. Stateless: every request reads and writes D1. */
export class Api extends DurableObject<EngineEnv> {
  override async fetch(request: Request): Promise<Response> {
    return handleGreader(request, this.env);
  }
}
