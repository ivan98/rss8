import { sourceContext } from "./context";
import type { EngineEnv } from "./env";
import { getConfig, getSource, parseOptions, type InspectResult, type ProcessOptions } from "./source";

/** The body the Worker sends to a Runner object's `/inspect`. */
export interface InspectRequest {
  kind: string;
  id: string;
  stage?: string;
  /** A saved page to process instead of fetching one. */
  page?: string;
  /** Return the fetched page too, so the caller can save it as a fixture. */
  includePage?: boolean;
  /** Ask the source for diagnostics that cost extra work. */
  report?: boolean;
}

export interface InspectResponse extends InspectResult {
  page?: string;
}

/** The 422 body when the page was fetched but processing it failed. */
export interface InspectFailure {
  error: string;
  page?: string;
}

/** `/<prefix>/clean/<kind>/<id>`, capturing the kind and the encoded id. */
export function cleanPath(prefix: string): RegExp {
  return new RegExp(`^/${prefix}/clean/([a-z0-9-]+)/([^/]+)$`);
}

const DEV_CLEAN = cleanPath("dev");

/** Undefined when the path isn't a `/dev/clean` route. */
export async function devCleanRoute(request: Request, env: EngineEnv): Promise<Response | undefined> {
  const match = DEV_CLEAN.exec(new URL(request.url).pathname);
  return match ? cleanRoute(request, env, match) : undefined;
}

/**
 * `GET …/clean/<kind>/<id>` fetches and processes an item's page; `POST`
 * processes the page in the body instead. Query: `stage`, `page=1` to return
 * the fetched page, and `report=1` for the source's extra diagnostics. Each
 * request runs in a fresh Runner object, as each article does in production,
 * so its CPU time can be compared with an article invocation's.
 * `match` is `cleanPath`'s match on the request's path.
 */
export async function cleanRoute(request: Request, env: EngineEnv, match: RegExpExecArray): Promise<Response> {
  const url = new URL(request.url);
  const body: InspectRequest = { kind: match[1]!, id: decodeURIComponent(match[2]!) };
  const stage = url.searchParams.get("stage");
  if (stage) body.stage = stage;
  if (request.method === "POST") body.page = await request.text();
  else if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  if (url.searchParams.get("page") === "1") body.includePage = true;
  if (url.searchParams.get("report") === "1") body.report = true;
  // The query only labels the object's invocation in logs and tails.
  const label = new URLSearchParams({ kind: body.kind, id: body.id, mode: body.page === undefined ? "fetch" : "page" });
  const name = `inspect:${body.kind}:${body.id}:${crypto.randomUUID()}`;
  return env.RUNNER.getByName(name).fetch(`https://runner/inspect?${label}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Runs one inspect request inside a Runner object. */
export async function runInspect(request: InspectRequest): Promise<Response> {
  const source = getSource(request.kind);
  if (!source.inspect) return new Response(`Source "${source.kind}" has no inspect hooks`, { status: 404 });
  const feed = getConfig().feeds.find((f) => f.source === source.kind);
  const options = feed ? parseOptions(source, feed.options) : undefined;
  const page =
    request.page ?? (await source.inspect.fetchPage(request.id, sourceContext(options, `inspect:${request.id}`)));
  try {
    const options: ProcessOptions = {};
    if (request.stage !== undefined) options.stage = request.stage;
    if (request.report) options.report = true;
    const result: InspectResponse = await source.inspect.process(page, options);
    if (request.includePage) result.page = page;
    return Response.json(result);
  } catch (error) {
    // A page that fails to process is the one worth saving as a fixture.
    const failure: InspectFailure = { error: error instanceof Error ? error.message : String(error) };
    if (request.includePage) failure.page = page;
    return Response.json(failure, { status: 422 });
  }
}
