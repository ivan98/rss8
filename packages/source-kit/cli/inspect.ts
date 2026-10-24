// npm run inspect -- <kind> <id> [flags]
//
// Runs a source's article pipeline in real workerd and prints the result:
// clean HTML on stdout, details on stderr. It starts the deployment's Worker
// with the `/dev` routes on and calls `/dev/clean/<kind>/<id>`, which runs the
// same code as production in a Runner object. HTMLRewriter doesn't exist in
// Node, so the pipeline can't run here directly.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: npm run inspect -- <kind> <id> [flags]

  --pretty              format the HTML with Prettier
  --stage <name>        stop after a stage (the source defines them, e.g. isolate or clean)
  --no-cleanup          only extract the article (the source's first stage, "isolate")
  --save-raw <path>     save the fetched page, e.g. as a fixture
  --file <path>         process a saved page instead of fetching (the id defaults to its file name)
  --open                open the result in a browser
  --diff                compare with the expected output for this id; exit 1 if it differs
  --update-golden       write the result as the expected output for this id
  --remote              call /admin/clean/<kind>/<id> on the deployed Worker (RSS8_URL, RSS8_ADMIN_TOKEN)
  --expected-dir <dir>  expected outputs (default: sources/<kind>/golden)
  --config <path>       Wrangler config of the deployment (default: wrangler.jsonc)`;

interface InspectResponse {
  content: string;
  details: Record<string, unknown>;
  page?: string;
}

interface InspectFailure {
  error: string;
  page?: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values: flags, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        pretty: { type: "boolean" },
        stage: { type: "string" },
        "no-cleanup": { type: "boolean" },
        "save-raw": { type: "string" },
        file: { type: "string" },
        open: { type: "boolean" },
        diff: { type: "boolean" },
        "update-golden": { type: "boolean" },
        remote: { type: "boolean" },
        "expected-dir": { type: "string" },
        config: { type: "string", default: "wrangler.jsonc" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail(`${(error as Error).message}\n\n${USAGE}`);
  }
})();

const [kind, idArg] = positionals;
if (flags.help || !kind) fail(USAGE);
const id = idArg ?? (flags.file ? basename(flags.file).replace(/\.[^.]*$/, "") : undefined);
if (!id) fail(`An id is required unless --file is given.\n\n${USAGE}`);
if (flags["no-cleanup"] && flags.stage) fail("--no-cleanup and --stage can't be combined");
const stage = flags["no-cleanup"] ? "isolate" : flags.stage;
if (stage && (flags.diff || flags["update-golden"])) fail("--diff and --update-golden compare the full output; drop --stage");
if (flags.file && flags["save-raw"]) fail("--save-raw saves a fetched page; --file doesn't fetch one");
const expectedFile = join(flags["expected-dir"] ?? join("sources", kind, "golden"), `${id}.html`);

const query = new URLSearchParams();
if (stage) query.set("stage", stage);
if (flags["save-raw"]) query.set("page", "1");
query.set("report", "1");
const path = `/${flags.remote ? "admin" : "dev"}/clean/${kind}/${encodeURIComponent(id)}?${query}`;
const init: RequestInit = flags.file ? { method: "POST", body: readFileSync(flags.file, "utf8") } : {};

const started = performance.now();
const res = flags.remote ? await callRemote(path, init) : await callLocal(path, init);
const wallMs = Math.round(performance.now() - started);
// 422: the page was fetched (and is returned with --save-raw) but processing it failed.
const body = res.ok || res.status === 422 ? (JSON.parse(res.text) as InspectResponse | InspectFailure) : undefined;
if (flags["save-raw"] && body?.page !== undefined) {
  mkdirSync(dirname(flags["save-raw"]), { recursive: true });
  writeFileSync(flags["save-raw"], body.page);
  console.error(`Saved the page to ${flags["save-raw"]}`);
}
if (!body || "error" in body) fail(`${path}: HTTP ${res.status}: ${body ? body.error : res.text}`);
const result = body;
const { page: _page, ...shown } = result;
console.error(JSON.stringify({ kind, id, stage: stage ?? "all", ...shown.details, wallMs }, null, 2));
console.error(`(wallMs is measured from this process and includes startup and network, not CPU)`);

const output = flags.pretty ? await pretty(result.content) : result.content;
if (flags["update-golden"]) {
  mkdirSync(dirname(expectedFile), { recursive: true });
  writeFileSync(expectedFile, result.content);
  console.error(`Wrote ${expectedFile}`);
}
if (flags.open) openInBrowser(result.content);
if (flags.diff) {
  if (!existsSync(expectedFile)) fail(`No expected output at ${expectedFile}`);
  const expected = readFileSync(expectedFile, "utf8");
  if (expected === result.content) {
    console.error(`Same as ${expectedFile}`);
  } else {
    process.stdout.write(diff(await pretty(expected), await pretty(result.content)));
    process.exitCode = 1;
  }
} else {
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

async function callLocal(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: string }> {
  const { unstable_startWorker } = await import("wrangler");
  const worker = await unstable_startWorker({
    config: flags.config,
    bindings: { DEV_ROUTES: { type: "plain_text", value: "1" } },
    dev: { server: { port: 0 }, inspector: false, watch: false, logLevel: "error" },
  });
  try {
    const res = await worker.fetch(`http://localhost${path}`, init as never);
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    await worker.dispose();
  }
}

async function callRemote(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: string }> {
  const base = process.env.RSS8_URL;
  const token = process.env.RSS8_ADMIN_TOKEN;
  if (!base || !token) fail("--remote needs RSS8_URL (the deployed Worker's URL) and RSS8_ADMIN_TOKEN");
  const res = await fetch(new URL(path, base), { ...init, headers: { authorization: `Bearer ${token}` } });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function pretty(html: string): Promise<string> {
  const prettier = await import("prettier");
  return prettier.format(html, { parser: "html", printWidth: 120 });
}

function scratchFile(name: string, content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "rss8-inspect-")), name);
  writeFileSync(file, content);
  return file;
}

function openInBrowser(content: string): void {
  const file = scratchFile(`${kind}-${id}.html`, `<!doctype html><meta charset="utf-8"><title>${kind} ${id}</title>\n${content}`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFileSync(opener, [file]);
  console.error(`Opened ${file}`);
}

function diff(expected: string, actual: string): string {
  const a = scratchFile("expected.html", expected);
  const b = scratchFile("actual.html", actual);
  try {
    execFileSync("git", ["diff", "--no-index", a, b], { encoding: "utf8" });
    return "";
  } catch (error) {
    // git diff exits 1 when the files differ.
    return (error as { stdout?: string }).stdout ?? "";
  }
}
