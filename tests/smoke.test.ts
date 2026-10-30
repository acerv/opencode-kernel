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
      plugins: [fileURLToPath(new URL("../", import.meta.url))],
    }));
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
    assert.match(configuration.stdout, /"plugins"/);
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
    for (let i = 0; i < 100; i++) {
      assert.equal(server.exitCode, null, logs);
      try {
        const options = { headers: { Authorization: `Basic ${Buffer.from("opencode:kernel-smoke-only").toString("base64")}` } };
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
  } finally {
    if (server && server.exitCode === null) {
      const closed = once(server, "close");
      server.kill("SIGTERM");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
