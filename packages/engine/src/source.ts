import type { Config } from "./config";
import type { FeedEntry } from "./feed-scan";

/** One item a source lists in `discover`. */
export interface Candidate {
  /** Unique across all sources: prefix the source's native id, as in `<kind>-<id>`. */
  guid: string;
  url?: string;
  title?: string;
  summary?: string;
  author?: string;
  /** Epoch seconds. */
  published?: number;
  /** Epoch seconds. */
  updated?: number;
  /** The complete item body, for sources without `fetchArticle`. */
  content?: string;
}

/** The result of `fetchArticle`. Fields left out keep the candidate's values. */
export interface Article {
  content: string;
  url?: string;
  title?: string;
  summary?: string;
  author?: string;
  published?: number;
  updated?: number;
}

export interface Feed {
  id: number;
  key: string;
  title: string;
  siteUrl?: string;
}

export type FeedFetch = { notModified: true } | { notModified: false; text: string; truncated: boolean };

export interface SourceContext<Options> {
  /** `fetch` with a desktop browser user agent (unless the request sets one) and a timeout. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  options: Options;
  log(...data: unknown[]): void;
}

export interface DiscoverContext<Options, State> extends SourceContext<Options> {
  /**
   * A conditional GET using this URL's stored validators. The body is read up
   * to the byte cap; `truncated` says it was cut. New validators are stored
   * only when the whole discover run succeeds.
   */
  fetchFeed(url: string): Promise<FeedFetch>;
  parseFeed(xml: string): FeedEntry[];
  /** The feed's own bookkeeping. A `set` is stored only when the whole discover run succeeds. */
  state: { get(): State | undefined; set(value: State): void };
}

export interface Source<Options = unknown, State = unknown> {
  apiVersion: 1;
  kind: string;
  defaultSchedule: readonly string[];
  /** Checks a feed's `options` from the config. Throw to reject them. */
  parseOptions?(raw: unknown): Options;
  discover(feed: Feed, ctx: DiscoverContext<Options, State>): Promise<Candidate[]>;
  fetchArticle?(candidate: Candidate, ctx: SourceContext<Options>): Promise<Article>;
}

// `any`, not `unknown`: a Source<{ url: string }> must be assignable here, and
// its callbacks take Options as a parameter.
export type AnySource = Source<any, any>;

export function defineSource<Options = unknown, State = unknown>(
  source: Source<Options, State>,
): Source<Options, State> {
  return source;
}

export function parseOptions(source: AnySource, raw: unknown): unknown {
  return source.parseOptions ? source.parseOptions(raw) : raw;
}

// The Runner class is exported under a fixed name and built by the runtime, so
// it can't receive the sources or the config as arguments. `createWorker`
// registers them here when the deployment module loads, before any object
// handles a request.
const registry = new Map<string, AnySource>();
let registeredConfig: Config | undefined;

export function registerDeployment(sources: readonly AnySource[], config: Config): void {
  registeredConfig = config;
  registry.clear();
  for (const source of sources) {
    if (registry.has(source.kind)) throw new Error(`Source kind "${source.kind}" is registered twice`);
    registry.set(source.kind, source);
  }
}

export function getSource(kind: string): AnySource {
  const source = registry.get(kind);
  if (!source) throw new Error(`No source registered for kind "${kind}"`);
  return source;
}

export function getConfig(): Config {
  if (!registeredConfig) throw new Error("No config registered");
  return registeredConfig;
}
