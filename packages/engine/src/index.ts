import { DurableObject } from "cloudflare:workers";

export interface EngineEnv {
  RUNNER: DurableObjectNamespace<Runner>;
  API: DurableObjectNamespace<Api>;
}

export interface Source {
  apiVersion: 1;
  kind: string;
}

export interface FeedConfig {
  key: string;
  source: string;
  enabled: boolean;
  title?: string;
  siteUrl?: string;
  options?: unknown;
  schedule?: string[];
}

export interface Config {
  timezone: string;
  retentionDays: number;
  feeds: FeedConfig[];
}

export function defineConfig(config: Config): Config {
  return config;
}

const notImplemented = () => new Response("Not Implemented", { status: 501 });

export class Runner extends DurableObject<EngineEnv> {
  override async fetch(): Promise<Response> {
    return notImplemented();
  }
}

export class Api extends DurableObject<EngineEnv> {
  override async fetch(): Promise<Response> {
    return notImplemented();
  }
}

export function createWorker(_options: { sources: Source[]; config: Config }) {
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/health") return new Response("OK");
      return new Response("Not Found", { status: 404 });
    },
  } satisfies ExportedHandler<EngineEnv>;
}
