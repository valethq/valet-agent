import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CORE = process.env.VALET_CORE_DIR ?? join(import.meta.dir, "..", "..", "valet-core");
const CLI = join(CORE, "packages/core/src/cli.ts");
const PLUGINS = join(import.meta.dir, "fixtures", "plugins");
const ROOT = join(import.meta.dir, "..");
const AUTH = { authorization: "Bearer tok", "content-type": "application/json" };

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON bodies in tests
export type Json = any;

export interface Kernel {
  home: string;
  base: string;
  proc: Bun.Subprocess;
  stop(): Promise<void>;
  kill(): Promise<void>;
  api(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: Json }>;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 8000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

export async function startKernel(home = mkdtempSync(join(tmpdir(), "valet-agent-"))): Promise<Kernel> {
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const own = join(home, "plugins", "valet-agent");
  mkdirSync(own, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  writeFileSync(join(own, "manifest.json"), JSON.stringify({ ...manifest, main: "./index.ts" }));
  writeFileSync(
    join(own, "index.ts"),
    `export { default } from ${JSON.stringify(join(ROOT, "src", "index.ts"))};\n`,
  );
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      server: { port },
      pluginPaths: [PLUGINS, join(home, "plugins")],
      plugins: { "valet-fixture-auth": { config: { token: "tok" } } },
    }),
  );
  const proc = Bun.spawn(["bun", CLI, "start", "--home", home], {
    stdout: Bun.file(join(home, "out.log")),
    stderr: Bun.file(join(home, "err.log")),
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    () =>
      fetch(`${base}/`).then(
        (r) => r.status === 200,
        () => false,
      ),
    15000,
  );
  const kill = async () => {
    proc.kill("SIGKILL");
    await proc.exited;
  };
  return {
    home,
    base,
    proc,
    kill,
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
    },
    async api(path, init = {}) {
      const res = await fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: AUTH,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: res.status, body: await res.json().catch(() => undefined) };
    },
  };
}
