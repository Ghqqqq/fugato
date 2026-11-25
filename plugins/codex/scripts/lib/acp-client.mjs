import { spawnOwned, stopOwnedProcessGroup } from "./process.mjs";

const MAX_FRAME_CHARS = 32 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const EXIT_DRAIN_MS = 250;
const rpcError = (message, code = "ACP_TRANSPORT_CLOSED", extra = {}) => Object.assign(new Error(message), { code, ...extra });

// ACP v1 uses UTF-8 newline-delimited JSON-RPC in both directions. In
// particular, handling a server request must not block reading its next frame.
// https://agentclientprotocol.com/protocol/v1/transports
export class AcpClient {
  constructor(command, cwd, { env = process.env, onNotification = null, onRequest = null, timeoutMs = 30000, exitGraceMs = 2000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.exitGraceMs = exitGraceMs;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.frameParts = [];
    this.frameLength = 0;
    this.failure = null;
    this.hasExited = false;
    this.closed = false;
    this.closePromise = null;
    // spawnOwned keeps argv literal and handles Windows .cmd/.bat shims.
    this.child = spawnOwned(command, ["acp"], { cwd, env, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.exit = new Promise(resolve => {
      let drainTimer;
      const observeExit = () => {
        this.hasExited = this.pid !== null;
        resolve();
      };
      const failExited = (code, signal) => this.fail(rpcError(`Antigravity ACP exited before completing the request (${signal || `exit ${code}`}).`));
      this.child.once("error", error => this.fail(rpcError(`Cannot start Antigravity ACP: ${error.message}`, "ACP_SPAWN_FAILED")));
      this.child.once("exit", (code, signal) => {
        observeExit();
        // A descendant may hold the pipes open after the leader's final frame.
        drainTimer = setTimeout(() => {
          failExited(code, signal);
          this.child.stdout.destroy();
          this.child.stderr.destroy();
        }, EXIT_DRAIN_MS);
      });
      this.child.once("close", (code, signal) => {
        observeExit();
        clearTimeout(drainTimer);
        failExited(code, signal);
      });
    });
    this.child.stdin.on("error", error => this.fail(rpcError(`Antigravity ACP input closed: ${error.message}`)));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.read(chunk));
    this.child.stdout.on("end", () => {
      this.fail(this.frameParts.some(part => part.trim()) ? rpcError("Antigravity ACP ended with an incomplete JSON-RPC frame.", "ACP_INVALID_FRAME")
        : rpcError("Antigravity ACP closed stdout before completing its pending requests."));
    });
    this.child.stdout.on("error", error => this.fail(rpcError(`Antigravity ACP output failed: ${error.message}`)));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS); });
  }

  get pid() { return this.child.pid ?? null; }

  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(this.failure);
    }
    this.pending.clear();
    for (const request of this.serverRequests.values()) request.controller.abort();
  }

  read(chunk) {
    if (this.failure || this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      this.frameLength += end - offset;
      if (this.frameLength > MAX_FRAME_CHARS) { this.fail(rpcError("Antigravity ACP frame exceeds the size limit.", "ACP_INVALID_FRAME")); return; }
      this.frameParts.push(chunk.slice(offset, end));
      if (newline < 0) return;
      const line = this.frameParts.join("");
      this.frameParts = [];
      this.frameLength = 0;
      offset = newline + 1;
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(rpcError("Antigravity ACP wrote invalid JSON to stdout.", "ACP_INVALID_FRAME")); return; }
      if (!message || Array.isArray(message) || typeof message !== "object" || message.jsonrpc !== "2.0") {
        this.fail(rpcError("Antigravity ACP sent an invalid JSON-RPC message.", "ACP_INVALID_FRAME")); return;
      }
      if (message.id === null && !Object.hasOwn(message, "method")) continue;
      if (message.id !== undefined && !(typeof message.id === "string" || (typeof message.id === "number" && Number.isFinite(message.id)))) {
        this.fail(rpcError("Antigravity ACP sent an invalid JSON-RPC request identifier.", "ACP_INVALID_FRAME")); return;
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) void this.handleRequest(message);
        else if (message.method === "$/cancel_request") this.serverRequests.get(message.params?.requestId)?.controller.abort();
        else {
          try { this.onNotification?.(message); }
          catch (error) { this.fail(error); return; }
        }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.error) pending.reject(rpcError(String(message.error.message || "Antigravity ACP request failed."), "ACP_RPC_ERROR", { rpcCode: message.error.code, rpcData: message.error.data }));
        else if (Object.hasOwn(message, "result")) {
          try { pending.onResponse?.(message.result); pending.resolve(message.result); }
          catch (error) { pending.reject(error); }
        }
        else pending.reject(rpcError("Antigravity ACP response contains neither result nor error.", "ACP_INVALID_FRAME"));
      } else {
        this.fail(rpcError("Antigravity ACP sent an unrecognized JSON-RPC message.", "ACP_INVALID_FRAME")); return;
      }
    }
  }

  send(message) {
    if (this.failure) throw this.failure;
    if (this.closed || !this.child.stdin.writable) throw rpcError("Antigravity ACP connection is closed.");
    const frame = `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
    if (this.child.stdin.writableLength + Buffer.byteLength(frame) > MAX_FRAME_CHARS) throw rpcError("Antigravity ACP input exceeded the buffer limit.", "ACP_BACKPRESSURE");
    this.child.stdin.write(frame);
  }

  request(method, params, { timeoutMs = this.timeoutMs, signal = null, onResponse = null } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(rpcError("Antigravity ACP request interrupted.", "ACP_ABORTED")); return; }
      const id = this.nextId++;
      let timer = null;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const abort = () => {
        this.pending.delete(id); cleanup();
        reject(rpcError("Antigravity ACP request interrupted.", "ACP_ABORTED"));
      };
      // Apply response state in wire order, before another notification in
      // this same stdout chunk. Promise continuations run after the read loop.
      this.pending.set(id, { resolve, reject, cleanup, onResponse });
      if (timeoutMs > 0) timer = setTimeout(() => {
        this.pending.delete(id); cleanup();
        reject(rpcError(`Antigravity ACP ${method} timed out.`, "ACP_REQUEST_TIMEOUT"));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  notify(method, params) { this.send({ method, params }); }

  cancelPermissionRequests(sessionId) {
    for (const [id, request] of this.serverRequests) {
      if (request.method !== "session/request_permission" || request.params?.sessionId !== sessionId || request.replied) continue;
      // Reply synchronously before session/cancel. An agent may acknowledge
      // cancellation immediately; a delayed async parent callback must not
      // leave this permission unresolved when the connection then closes.
      this.send({ id, result: { outcome: { outcome: "cancelled" } } });
      request.replied = true;
      request.controller.abort();
    }
  }

  async handleRequest(message) {
    if (this.serverRequests.has(message.id)) {
      this.fail(rpcError("Antigravity ACP reused a pending server request identifier.", "ACP_INVALID_FRAME"));
      return;
    }
    const controller = new AbortController();
    const request = { controller, method: message.method, params: message.params, replied: false };
    this.serverRequests.set(message.id, request);
    try {
      if (!this.onRequest) throw Object.assign(new Error("Method not found"), { rpcCode: -32601 });
      const result = await this.onRequest(message, controller.signal);
      if (!request.replied && !this.closed && !this.failure) { this.send({ id: message.id, result }); request.replied = true; }
    } catch (error) {
      if (!request.replied && !this.closed && !this.failure) {
        try { this.send({ id: message.id, error: { code: error.rpcCode ?? -32603, message: error.rpcCode === -32601 ? "Method not found" : "Antigravity client could not handle this request." } }); }
        catch (sendError) { this.fail(sendError); }
      }
    } finally { if (this.serverRequests.get(message.id) === request) this.serverRequests.delete(message.id); }
  }

  async waitForExit(timeoutMs) {
    let timer;
    try { await Promise.race([this.exit, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.resolve().then(async () => {
      let error = null;
      try {
        this.fail(rpcError("Antigravity ACP connection closed."));
        this.child.stdin.end();
        await this.waitForExit(this.exitGraceMs);
      } catch (cause) { error = cause; }
      try {
        // The owned group can still contain descendants after a graceful exit.
        await stopOwnedProcessGroup(this.child, 100);
      } catch (cause) { error ??= cause; }
      if (!this.hasExited) await this.waitForExit(1000);
      if (!this.hasExited) {
        // Even a failed cleanup must release the worker's event loop.
        this.child.unref();
        for (const stream of this.child.stdio) stream?.destroy();
        error ??= rpcError("Antigravity ACP process did not exit after cleanup.", "ACP_CLEANUP_FAILED");
      }
      return { exited: this.hasExited, error };
    }).catch(error => ({ exited: this.hasExited, error }));
    return this.closePromise;
  }
}
