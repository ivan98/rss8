// npm run measure -- <kind> --url <worker url> [flags]
//
// Measures a source's article work in a deployed Runner object, once per saved
// page. The Worker must be deployed with DEV_ROUTES=1 (for example a throwaway
// Worker; never production). For each fixture id it calls /dev/clean/<kind>/<id>
// and reads the object invocation's CPU time from `wrangler tail`. A Worker
// can't time its own CPU: Date.now() doesn't advance during CPU work.
//
//   fetch mode: the object fetches the live page and processes it, as fetchArticle does.
//   page mode:  the saved page is posted and processed, so the input is the fixture itself.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const USAGE = `Usage: npm run measure -- <kind> --url <worker url> [flags]

  --url <url>          the measurement Worker, e.g. https://rss8-measure.<account>.workers.dev
  --config <path>      its Wrangler config, for wrangler tail (default: wrangler.measure.jsonc)
  --fixtures <dir>     saved pages, <id>.html (default: sources/<kind>/fixtures)
  --mode <mode>        fetch, page or both (default: both)
  --gap <ms>           pause between requests (default: 3500)
  --out <path>         write every result as JSON`;

type Mode = "fetch" | "page";

interface TailEvent {
  outcome?: string;
  cpuTime?: number;
  wallTime?: number;
  entrypoint?: string;
  event?: { request?: { url?: string } };
  exceptions?: { message?: string }[];
}

interface Result {
  id: string;
  mode: Mode;
  status: number;
  error?: string;
  requestMs: number;
  cpuTime?: number;
  wallTime?: number;
  outcome?: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    config: { type: "string", default: "wrangler.measure.jsonc" },
    fixtures: { type: "string" },
    mode: { type: "string", default: "both" },
    gap: { type: "string", default: "3500" },
    out: { type: "string" },
  },
});
const [kind] = positionals;
if (!kind || !flags.url) fail(USAGE);
const modes: Mode[] = flags.mode === "both" ? ["fetch", "page"] : [flags.mode as Mode];
if (!modes.every((m) => m === "fetch" || m === "page")) fail(USAGE);
const dir = flags.fixtures ?? join("sources", kind, "fixtures");
const ids = readdirSync(dir)
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -5))
  .sort();
const gapMs = Number(flags.gap);

const events = startTail();
console.error("Starting wrangler tail…");
await events.connected;

const results: Result[] = [];
for (const mode of modes) {
  for (const id of ids) {
    const init: RequestInit =
      mode === "page" ? { method: "POST", body: readFileSync(join(dir, `${id}.html`), "utf8") } : {};
    const started = performance.now();
    const res = await fetch(new URL(`/dev/clean/${kind}/${encodeURIComponent(id)}`, flags.url), init);
    const text = await res.text();
    const result: Result = { id, mode, status: res.status, requestMs: Math.round(performance.now() - started) };
    if (!res.ok) result.error = text.slice(0, 200);
    results.push(result);
    console.error(`${mode} ${id}: HTTP ${res.status} in ${result.requestMs} ms`);
    await sleep(gapMs);
  }
}

console.error("Waiting for the last tail events…");
await sleep(15_000);
events.stop();

for (const result of results) {
  const label = new URLSearchParams({ kind, id: result.id, mode: result.mode }).toString();
  const event = events.received.find((e) => e.event?.request?.url?.endsWith(`/inspect?${label}`));
  if (!event) continue;
  if (event.cpuTime !== undefined) result.cpuTime = event.cpuTime;
  if (event.wallTime !== undefined) result.wallTime = event.wallTime;
  if (event.outcome !== undefined) result.outcome = event.outcome;
}

console.log("| id | mode | HTTP | object CPU ms | object wall ms | outcome |");
console.log("|---|---|---|---|---|---|");
for (const r of results) {
  console.log(`| ${r.id} | ${r.mode} | ${r.status} | ${r.cpuTime ?? "no event"} | ${r.wallTime ?? ""} | ${r.outcome ?? ""}${r.error ? ` ${r.error}` : ""} |`);
}
for (const mode of modes) {
  const cpu = results.filter((r) => r.mode === mode && r.cpuTime !== undefined).map((r) => r.cpuTime!);
  const missing = results.filter((r) => r.mode === mode).length - cpu.length;
  console.log(`\n${mode}: n=${cpu.length} median ${quantile(cpu, 0.5)} p90 ${quantile(cpu, 0.9)} max ${Math.max(...cpu)} ms CPU` +
    (missing ? `; ${missing} without a tail event` : ""));
}
if (flags.out) writeFileSync(flags.out, `${JSON.stringify(results, null, 1)}\n`);

function quantile(values: number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** `wrangler tail --format json` prints one JSON object per event, possibly over several lines. */
function startTail(): { received: TailEvent[]; connected: Promise<void>; stop(): void } {
  const child = spawn("npx", ["wrangler", "tail", "-c", flags.config!, "--format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const received: TailEvent[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    // Anything before an event's "{" is a status line.
    const start = buffer.indexOf("{");
    buffer = start === -1 ? "" : buffer.slice(start);
    for (let end; (end = objectEnd(buffer)) !== -1; ) {
      const json = buffer.slice(0, end + 1).trim();
      buffer = buffer.slice(end + 1);
      try {
        received.push(JSON.parse(json) as TailEvent);
      } catch {
        console.error(`Skipping unparsable tail output: ${json.slice(0, 100)}`);
      }
      const next = buffer.indexOf("{");
      buffer = next === -1 ? "" : buffer.slice(next);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk));
  let stopping = false;
  // In JSON format the tail prints nothing when it connects, so give it time.
  // An exit after that only warns: the promise has already settled.
  const connected = new Promise<void>((resolve, reject) => {
    setTimeout(resolve, 10_000);
    child.on("exit", (code) => {
      if (stopping) return;
      console.error(`wrangler tail exited with ${code}; later requests will have no CPU time`);
      reject(new Error(`wrangler tail exited with ${code}`));
    });
  });
  return {
    received,
    connected,
    stop: () => {
      stopping = true;
      child.kill();
    },
  };
}

/** The index of the `}` that closes the first top-level JSON object in `s`, or -1. */
function objectEnd(s: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
