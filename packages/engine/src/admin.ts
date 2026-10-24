import type { Config } from "./config";
import { syncConfig } from "./config-sync";
import type { EngineEnv } from "./env";
import { equal } from "./greader-auth";
import { cleanPath, cleanRoute } from "./inspect";
import { ARTICLE_STAGGER_SECONDS, MAX_DELAY_SECONDS, sendAll, type EngineMessage } from "./messages";

/** What the admin routes need from `createWorker`. */
export interface Deployment {
  config: Config;
  kinds: readonly string[];
}

interface AdminRequest {
  request: Request;
  url: URL;
  env: EngineEnv;
  deployment: Deployment;
  match: RegExpExecArray;
}

interface AdminRoute {
  methods: readonly string[];
  pattern: RegExp;
  handler: (req: AdminRequest) => Promise<Response>;
}

const MIN_TOKEN_LENGTH = 32;

// The work runs in Runner objects; the Worker only routes, within its 10 ms of CPU.
const ROUTES: readonly AdminRoute[] = [
  { methods: ["POST"], pattern: /^\/admin\/discover$/, handler: discover },
  { methods: ["POST"], pattern: /^\/admin\/article$/, handler: article },
  { methods: ["POST"], pattern: /^\/admin\/requeue$/, handler: requeue },
  {
    methods: ["GET", "POST"],
    pattern: cleanPath("admin"),
    handler: ({ request, env, match }) => cleanRoute(request, env, match),
  },
];

/**
 * The `/admin/` routes, behind `Authorization: Bearer <ADMIN_TOKEN>`. Without
 * a token of at least 32 characters every route answers 503. Undefined when
 * the path isn't under `/admin/`.
 */
export async function adminRoute(
  request: Request,
  env: EngineEnv,
  deployment: Deployment,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/")) return undefined;
  const token = env.ADMIN_TOKEN;
  if (!token || token.length < MIN_TOKEN_LENGTH) return new Response("Admin routes are not configured", { status: 503 });
  const given = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (given === undefined || !equal(given, token)) return new Response("Unauthorized", { status: 401 });

  for (const route of ROUTES) {
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    if (!route.methods.includes(request.method)) {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: route.methods.join(", ") } });
    }
    return route.handler({ request, url, env, deployment, match });
  }
  return new Response("Not Found", { status: 404 });
}

/**
 * `POST /admin/discover?feed=<key>`: one discover run of the feed, even a
 * disabled one, answering `{"itemIds": [...]}`. Syncs the config first: a
 * Preview never runs the cron, so its feed table would otherwise stay empty.
 */
async function discover({ url, env, deployment }: AdminRequest): Promise<Response> {
  const key = url.searchParams.get("feed");
  if (!key) return new Response("feed is required", { status: 400 });
  await syncConfig(env.DB, deployment.config, deployment.kinds);
  const feedId = await env.DB.prepare("SELECT id FROM feed WHERE key = ? AND archived_at IS NULL")
    .bind(key)
    .first<number>("id");
  if (feedId === null) return new Response(`No feed "${key}"`, { status: 404 });
  return runInObject(env, `feed:${key}`, { type: "discover", feedId, manual: true });
}

/** `POST /admin/article?id=<id>`: fetches and stores one pending item's article, answering `{id, status}`. */
async function article({ url, env }: AdminRequest): Promise<Response> {
  const id = itemId(url.searchParams.get("id"));
  if (id === undefined) return new Response("id must be a decimal item id", { status: 400 });
  const res = await runInObject(env, `item:${id}`, { type: "article", itemId: id });
  if (!res.ok) return res;
  const status = await env.DB.prepare("SELECT status FROM item WHERE id = ?").bind(id).first<string>("status");
  if (status === null) return new Response(`No item ${id}`, { status: 404 });
  return Response.json({ id, status });
}

/** `POST /admin/requeue?status=error`: sets every error item back to pending and queues its article again. */
async function requeue({ url, env }: AdminRequest): Promise<Response> {
  if (url.searchParams.get("status") !== "error") return new Response("status must be error", { status: 400 });
  const { results } = await env.DB.prepare(
    "UPDATE item SET status = 'pending', attempts = 0 WHERE status = 'error' RETURNING id",
  ).all<{ id: number }>();
  const ids = results.map((r) => r.id).sort((a, b) => a - b);
  await sendAll(
    env.QUEUE,
    ids.map((itemId, i) => ({
      body: { type: "article", itemId },
      delaySeconds: Math.min(i * ARTICLE_STAGGER_SECONDS, MAX_DELAY_SECONDS),
    })),
  );
  return Response.json({ requeued: ids.length });
}

function runInObject(env: EngineEnv, name: string, message: EngineMessage): Promise<Response> {
  return env.RUNNER.getByName(name).fetch(`https://runner/${message.type}`, {
    method: "POST",
    body: JSON.stringify(message),
  });
}

function itemId(raw: string | null): number | undefined {
  if (raw === null || !/^[1-9]\d*$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}
