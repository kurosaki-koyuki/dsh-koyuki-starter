// dsh-koyuki-starter — host half.
//
// Mounts the /dsh-koyuki-starter HTTP routes behind the same browser-trust fence
// every DSH plugin route applies:
//   POST /dsh-koyuki-starter/run   { file }   -> spawn `python <file>`, return runId
//   GET  /dsh-koyuki-starter/log?runId=&since= -> { lines, done, exitCode }
//   POST /dsh-koyuki-starter/kill  { runId }  -> stop the process (process tree on Win)
//   GET  /dsh-koyuki-starter/status            -> { python } (for debugging)
//
// The client half (lib/client.js) does all the DOM work. This half only
// spawns python and keeps a small ring buffer per run; output is polled by
// the browser (no WebSocket dependency).

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------- fence ---
// Same browser-trust fence used by sibling plugins (loopback / trusted-host +
// same-origin markers). Copies of the helpers in @dsh-better-sidebar-icons.
function header(headers, name) {
  const value = headers[name];
  return typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return;
  }
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === void 0) return true;
  try {
    return new URL(origin).hostname === hostUrl.hostname;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- utilities ---
const ROUTE_PREFIX = "/dsh-koyuki-starter";
const MAX_LINES = 3000;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1 << 20) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Split a decoded chunk into lines, keeping a trailing partial line. */
function appendDecoded(target, chunk, partial) {
  const text = partial + chunk;
  const parts = text.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  for (const line of parts) {
    if (target.length >= MAX_LINES) target.shift();
    target.push(line);
  }
  return rest;
}

// ------------------------------------------------------------- process mgmt
/** Probe the first candidate tool that answers `--version` (cached per key). */
const toolCache = new Map();
function detectTool(key, candidates) {
  if (toolCache.has(key)) return toolCache.get(key);
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });
      if (probe.status === 0) {
        toolCache.set(key, candidate);
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  toolCache.set(key, null);
  return null;
}

/**
 * Build the runner plan for a file path. Supported kinds:
 *   .py            -> python <file>
 *   .r             -> Rscript <file>
 *   .bat / .cmd    -> cmd /d /c <file>
 * Throws (with .status) for unknown types / missing runtimes.
 */
function buildRunner(file) {
  const lower = file.toLowerCase();
  const fail = (message) => {
    const error = new Error(message);
    error.status = 400;
    return error;
  };
  if (lower.endsWith(".py")) {
    const cmd = detectTool("python", ["python", "py", "python3"]);
    if (!cmd) throw fail("no python on PATH (tried python/py/python3)");
    return { cmd, args: [file], display: `${cmd} "${file}"`, kind: "python" };
  }
  if (lower.endsWith(".r")) {
    const cmd = detectTool("rscript", ["Rscript"]);
    if (!cmd) throw fail("未找到 Rscript（请安装 R 并把 Rscript 加入 PATH）");
    return { cmd, args: [file], display: `Rscript "${file}"`, kind: "R" };
  }
  if (lower.endsWith(".bat") || lower.endsWith(".cmd")) {
    const cmd = process.env.ComSpec || "cmd.exe";
    return { cmd, args: ["/d", "/c", file], display: `cmd /d /c "${file}"`, kind: "bat" };
  }
  throw fail("不支持的文件类型（支持 .py / .R / .bat / .cmd）");
}

/** One running child process + its ring buffer (any of py / R / bat / cmd). */
class RunInstance {
  constructor(file, runner) {
    this.id = randomUUID();
    this.file = file;
    this.runner = runner;
    this.child = null;
    this.lines = [];
    this.partial = "";
    this.done = false;
    this.exitCode = null;
    this.stoppedByUser = false;
    this.log(runner.display);
  }
  log(line) {
    if (this.lines.length >= MAX_LINES) this.lines.shift();
    this.lines.push(String(line));
  }
  toolLabel() {
    const labels = { python: "Python", R: "R (Rscript)", bat: "cmd", cmd: "cmd" };
    return labels[this.runner.kind] ?? this.runner.kind;
  }
  start() {
    const child = spawn(this.runner.cmd, this.runner.args, {
      cwd: dirname(this.file),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
      },
      windowsHide: false,
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      this.partial = appendDecoded(this.lines, chunk.toString("utf8"), this.partial);
    });
    child.stderr?.on("data", (chunk) => {
      this.partial = appendDecoded(this.lines, chunk.toString("utf8"), this.partial);
    });
    child.on("error", (error) => {
      this.done = true;
      if (error && error.code === "ENOENT") {
        this.log(`[koyuki-starter] 找不到运行时 ${this.runner.cmd}（${this.toolLabel()}），请安装并加入 PATH 后重试`);
      } else {
        this.log(`[koyuki-starter] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.exitCode = -1;
    });
    child.on("close", (code) => {
      this.done = true;
      this.exitCode = code;
      if (this.partial) {
        this.log(this.partial);
        this.partial = "";
      }
      if (this.stoppedByUser) {
        this.log(`[koyuki-starter] 已停止 (exit ${code ?? "signal"})`);
      } else {
        this.log(`[koyuki-starter] 进程结束，退出码 ${code ?? "signal"}`);
      }
      this.child = null;
    });
  }
  stop() {
    if (!this.child) return;
    this.stoppedByUser = true;
    const pid = this.child.pid;
    if (process.platform === "win32" && pid) {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        return;
      } catch {
        // fall through to plain kill
      }
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

const runs = new Map();

// ------------------------------------------------------------------- route
function createHandler(fence) {
  return async (req, res) => {
    if (!fence(req)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
    } catch {
      pathname = "/";
    }
    const sub = pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : "/";
    const method = req.method ?? "GET";

    // GET /dsh-koyuki-starter/status
    if (sub === "/status" && method === "GET") {
      sendJson(res, 200, {
        tools: {
          python: detectTool("python", ["python", "py", "python3"]),
          rscript: detectTool("rscript", ["Rscript"]),
        },
        runs: runs.size,
      });
      return;
    }

    // POST /dsh-koyuki-starter/run  { file }
    if (sub === "/run" && method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "invalid json body" });
        return;
      }
      const file = typeof body.file === "string" ? body.file.trim() : "";
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        sendJson(res, 400, { error: "file not found", file });
        return;
      }
      let runner;
      try {
        runner = buildRunner(file);
      } catch (error) {
        sendJson(res, error.status || 400, { error: error.message, file });
        return;
      }
      // one active run at a time: stop any previous still-running instance
      for (const existing of runs.values()) {
        if (!existing.done) existing.stop();
      }
      const instance = new RunInstance(file, runner);
      runs.set(instance.id, instance);
      instance.start();
      // keep finished instances a while so late polls can read the tail
      setTimeout(() => {
        runs.delete(instance.id);
      }, 10 * 60 * 1000).unref?.();
      sendJson(res, 200, { runId: instance.id });
      return;
    }

    // GET /dsh-koyuki-starter/log?runId=&since=
    if (sub === "/log" && method === "GET") {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://dsh.internal");
      } catch {
        sendJson(res, 400, { error: "bad url" });
        return;
      }
      const runId = url.searchParams.get("runId") ?? "";
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const instance = runs.get(runId);
      if (!instance) {
        sendJson(res, 404, { error: "unknown runId", runId });
        return;
      }
      const lines = since > 0 ? instance.lines.slice(since) : instance.lines;
      sendJson(res, 200, { runId, since: since + instance.lines.length, lines, done: instance.done, exitCode: instance.exitCode });
      return;
    }

    // POST /dsh-koyuki-starter/kill  { runId }
    if (sub === "/kill" && method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "invalid json body" });
        return;
      }
      const instance = runs.get(String(body.runId ?? ""));
      if (!instance) {
        sendJson(res, 404, { error: "unknown runId" });
        return;
      }
      instance.stop();
      sendJson(res, 200, { stopped: true });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  };
}

function registerRoutes(ctx, fence) {
  return ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: createHandler(fence),
  });
}

// ------------------------------------------------------------------ entry ---
const inject = ["webServer", "webRuntime"];

function apply(ctx) {
  const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);
  ctx.effect(() => {
    const disposeRoute = registerRoutes(ctx, fence);
    return () => {
      if (typeof disposeRoute === "function") disposeRoute();
      for (const instance of runs.values()) instance.stop();
    };
  }, "dsh-koyuki-starter: /dsh-koyuki-starter routes");
}

export { apply, inject };
