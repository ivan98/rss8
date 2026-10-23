import { DurableObject } from "cloudflare:workers";
import type { EngineEnv } from "./env";

export class Api extends DurableObject<EngineEnv> {
  override async fetch(): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  }
}
