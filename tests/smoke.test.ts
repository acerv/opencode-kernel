import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("OpenCode 2 loads the built plugin in isolation", {
  skip: process.env.OPENCODE_SMOKE !== "1",
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-kernel-smoke-"));
  try {
    const config = path.join(root, "config", "opencode");
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "opencode.json"), JSON.stringify({
      plugins: [new URL("../dist/index.js", import.meta.url).href],
    }));
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    };
    const { stdout } = await exec("opencode", ["api", "--standalone", "plugin.list"], {
      cwd: root, env, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.match(stdout, /opencode-kernel/);
    assert.doesNotMatch(stdout, /"status"\s*:\s*"(?:error|failed)"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
