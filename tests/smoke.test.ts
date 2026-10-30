import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyPlan, planInstall } from "../scripts/install.mjs";

const exec = promisify(execFile);

test("OpenCode 2 loads the built plugin in isolation", {
  skip: process.env.OPENCODE_SMOKE !== "1",
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-kernel-smoke-"));
  let server: ChildProcess | undefined;
  try {
    const config = path.join(root, "config", "opencode");
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "opencode.json"), JSON.stringify({
      plugins: [fileURLToPath(new URL("./probe/", import.meta.url))],
    }));
    await writeFile(path.join(root, "crash.log"), "BUG: KASAN: use-after-free in sample\nCall Trace:\n sample+0x1/0x2 drivers/sample.c:1\n");
    await applyPlan(await planInstall({ configDir: config, root: fileURLToPath(new URL("../", import.meta.url)) }));
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      OPENCODE_TEST_HOME: root,
      OPENCODE_SERVER_PASSWORD: "kernel-smoke-only",
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    };
    const configuration = await exec("opencode", ["api", "--standalone", "config.get"], {
      cwd: root, env, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    });
    assert(configuration.stdout.includes(config));
    if (process.env.OPENCODE_SMOKE_DEBUG) console.error(configuration.stdout);
    const socket = createServer().listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    const record = (chunk: Buffer) => { logs += chunk.toString().replace(/server password [^\r\n]+/g, "server password [redacted]"); };
    server.stdout?.on("data", record);
    server.stderr?.on("data", record);
    let plugins: any;
    let commands: any;
    const options = { headers: { Authorization: `Basic ${Buffer.from("opencode:kernel-smoke-only").toString("base64")}` } };
    for (let i = 0; i < 100; i++) {
      assert.equal(server.exitCode, null, logs);
      try {
        plugins = await fetch(`http://127.0.0.1:${port}/api/plugin`, options).then((r) => r.json());
        commands = await fetch(`http://127.0.0.1:${port}/api/command`, options).then((r) => r.json());
        if (commands.data?.some((c: any) => c.name === "lore") &&
          plugins.data?.some((p: any) => p.id === "opencode-kernel")) break;
      } catch { /* Wait for this test's private server to start. */ }
      await delay(100);
    }
    if (process.env.OPENCODE_SMOKE_DEBUG) console.error(logs, plugins?.data?.filter((p: any) => p.source.type !== "builtin"), commands);
    assert.equal(plugins?.data?.find((p: any) => p.id === "opencode-kernel")?.state.status, "active", JSON.stringify(plugins) + logs);
    for (const name of ["lore", "patchwork", "syz", "syzkaller"]) {
      assert(commands?.data?.some((c: any) => c.name === name), JSON.stringify(commands));
    }
    async function post(endpoint: string, body: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: "POST", headers: { ...options.headers, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      const data = response.status === 204 ? undefined : await response.json();
      assert(response.ok, JSON.stringify(data));
      return data;
    }
    const registered = await post("/api/rpc/kernel-test/inspect", { input: {} });
    for (const name of ["lore_list_patches", "lore_read_patch", "patchwork_list_patches",
      "patchwork_read_patch", "patchwork_fetch_series", "syzkaller_list_bugs", "syzkaller_read_report"]) {
      assert(registered.output.includes(name), JSON.stringify(registered));
    }
    const session = await post("/api/session", { title: "Kernel smoke", permissions: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ] });
    const run = (name: string, args: unknown) => post("/api/rpc/kernel-test/run", {
      input: { name, args, sessionID: session.data.id },
    });
    const report = await run("syzkaller_read_report", { target: "crash.log", checkLocalSource: false });
    assert.match(JSON.stringify(report), /Use-After-Free/);
    for (const [name, args] of [
      ["lore_list_patches", {}], ["lore_read_patch", { target: "x@example.org" }],
      ["patchwork_list_patches", {}], ["patchwork_read_patch", { target: "1" }],
      ["patchwork_fetch_series", { url: "1" }], ["syzkaller_list_bugs", {}],
      ["syzkaller_read_report", { target: "0123456789abcdef0123" }],
    ] as const) {
      const denied = await run(name, args);
      assert.match(JSON.stringify(denied), /denied|not allowed|permission/i);
      assert(denied.output.error, JSON.stringify(denied));
    }
    const asking = await post("/api/session", { title: "Kernel permission smoke", permissions: [
      { action: "read", resource: "*", effect: "ask" },
    ] });
    let completed = false;
    const pending = post("/api/rpc/kernel-test/run", { input: {
      name: "syzkaller_read_report", args: { target: "crash.log", checkLocalSource: false }, sessionID: asking.data.id,
    } }).then((result) => { completed = true; return result; });
    // Attach a handler immediately so a failed server cannot create an unhandled rejection.
    void pending.catch(() => {});
    let permission: any;
    for (let i = 0; i < 50; i++) {
      const result = await fetch(`http://127.0.0.1:${port}/api/session/${asking.data.id}/permission`, options).then((r) => r.json());
      permission = result.data?.[0];
      if (permission) break;
      await delay(50);
    }
    assert(permission, "Expected a native read permission request");
    assert.equal(completed, false, "A pending approval must not silently allow the read");
    await post(`/api/session/${asking.data.id}/permission/${permission.id}/reply`, { decision: "reject", message: "Smoke rejection" });
    const rejection = await pending;
    assert(rejection.output.error, JSON.stringify(rejection));
  } finally {
    if (server && server.exitCode === null) {
      const closed = once(server, "close");
      server.kill("SIGTERM");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
