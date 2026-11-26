import "./test-environment.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Skip only a demonstrated OS capability restriction. Once sockets work, a
// missing broker is a failure, never a reason to skip the assertions.
let socketCapability;
export async function requireLocalSockets(t) {
  socketCapability ??= (async () => {
    const dir = makeTempDir("cx-socket-");
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\codex-test-${process.pid}` : path.join(dir, "s");
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
      });
      return null;
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
      return `Local socket bind denied (${error.code}); rerun outside the sandbox.`;
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
  const reason = await socketCapability;
  if (reason) t.skip(reason);
  return !reason;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

let staticBinCacheDir = null;
const staticBinCache = new Map();
function ensureStaticBinCacheDir() {
  if (!staticBinCacheDir) {
    staticBinCacheDir = makeTempDir("fixture-bin-");
    process.on("exit", () => {
      if (process.platform === "win32") {
        for (const cached of staticBinCache.values()) {
          try { fs.chmodSync(cached, 0o666); } catch {}
        }
      }
      try { fs.rmSync(staticBinCacheDir, { recursive: true, force: true }); } catch {}
    });
  }
  return staticBinCacheDir;
}

// Copy each static fixture script once per test process into a read-only cache
// inode, then hardlink per-test paths to it so macOS skips per-test first-exec
// overhead and accidental in-place writes fail loudly without touching repo files.
export function linkStaticExecutable(targetPath, fixturePath, { rewriteShebang = false } = {}) {
  const resolved = path.resolve(fixturePath);
  const key = `${resolved}\0${rewriteShebang ? "1" : "0"}`;
  let cached = staticBinCache.get(key);
  if (!cached || !fs.existsSync(cached)) {
    const dir = ensureStaticBinCacheDir();
    cached = path.join(dir, `${staticBinCache.size}-${path.basename(resolved)}`);
    let content = fs.readFileSync(resolved, "utf8");
    if (rewriteShebang) content = content.replace(/^#![^\r\n]*/, `#!${process.execPath}`);
    fs.writeFileSync(cached, content, { encoding: "utf8", mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(cached, 0o555);
    staticBinCache.set(key, cached);
  }
  fs.rmSync(targetPath, { force: true });
  try { fs.linkSync(cached, targetPath); }
  catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.symlinkSync(cached, targetPath);
  }
  return targetPath;
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

// Establish a real listener before a transport assertion. A live socket pins the
// broker until release, so a slow test runner cannot trigger its idle policy.
export async function readyBroker(cwd, env) {
  const module = new URL('../plugins/codex/scripts/lib/broker-lifecycle.mjs', import.meta.url).href;
  const result = run(process.execPath, ['--input-type=module', '-e', `
    import { ensureBrokerSession } from ${JSON.stringify(module)};
    const session = await ensureBrokerSession(process.cwd(), { timeoutMs: 60000 });
    if (!session) throw new Error('Fixture broker never became ready');
    console.log(JSON.stringify(session));
  `], { cwd, env });
  if (result.status !== 0) throw new Error(result.stderr);
  const session = JSON.parse(result.stdout);
  const { parseBrokerEndpoint } = await import('../plugins/codex/scripts/lib/broker-endpoint.mjs');
  const target = parseBrokerEndpoint(session.endpoint).path;
  const keeper = net.createConnection(target);
  await new Promise((resolve, reject) => { keeper.once('connect', resolve); keeper.once('error', reject); });
  return { ...session, close: () => keeper.destroy() };
}

export async function waitForCondition(predicate, label = 'fixture state', timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
