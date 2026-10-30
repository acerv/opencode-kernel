import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPlan, planInstall } from "../scripts/install.mjs";

async function fixture(run: (configDir: string, root: string) => Promise<void>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ock-install-"));
  try {
    const root = path.join(temporary, "repo");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "dist/index.js"), "export default {};");
    await writeFile(path.join(root, "server.js"), "export { default } from './dist/index.js';");
    await run(path.join(temporary, "config"), root);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("installer dry-run creates no configuration directory", async () => fixture(async (configDir, root) => {
  const plan = await planInstall({ configDir, root });
  assert.equal(plan.action, "install");
  await assert.rejects(lstat(configDir), { code: "ENOENT" });
}));

test("installation repeats safely and removal preserves unrelated configuration", async () => fixture(async (configDir, root) => {
  await mkdir(configDir);
  const original = '{\n// keep this comment\n"model": "provider/model",\n}\n';
  await writeFile(path.join(configDir, "opencode.jsonc"), original);
  await applyPlan(await planInstall({ configDir, root }));
  assert.equal(await readlink(path.join(configDir, "plugins/opencode-kernel")), root);
  assert.equal((await planInstall({ configDir, root })).action, "none");
  const updated = original.replace("provider/model", "provider/other-model");
  await writeFile(path.join(configDir, "opencode.jsonc"), updated);
  await applyPlan(await planInstall({ configDir, root, uninstall: true }));
  assert.equal(await readFile(path.join(configDir, "opencode.jsonc"), "utf8"), updated);
  assert.equal((await planInstall({ configDir, root, uninstall: true })).action, "none");
}));

test("legacy plugins and command files require approval and restore exactly", async () => fixture(async (configDir, root) => {
  await mkdir(path.join(configDir, "plugin"), { recursive: true });
  await mkdir(path.join(configDir, "commands"));
  await writeFile(path.join(configDir, "plugin/lore.ts"), "old lore");
  await writeFile(path.join(configDir, "plugin/custom.js"), "// patchwork_list_patches");
  await writeFile(path.join(configDir, "commands/syz.md"), "old command");
  await writeFile(path.join(configDir, "plugin/unrelated.ts"), "unrelated");
  await assert.rejects(planInstall({ configDir, root }), /--replace-conflicts/);
  await applyPlan(await planInstall({ configDir, root, replaceConflicts: true }));
  await assert.rejects(lstat(path.join(configDir, "plugin/lore.ts")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(configDir, "plugin/unrelated.ts"), "utf8"), "unrelated");
  const state = JSON.parse(await readFile(path.join(configDir, ".opencode-kernel-install.json"), "utf8"));
  assert.equal((await lstat(path.join(configDir, state.backup))).mode & 0o777, 0o700);
  await applyPlan(await planInstall({ configDir, root, uninstall: true }));
  assert.equal(await readFile(path.join(configDir, "plugin/lore.ts"), "utf8"), "old lore");
  assert.equal(await readFile(path.join(configDir, "commands/syz.md"), "utf8"), "old command");
}));

test("explicit configuration conflicts and malformed JSONC stop without edits", async () => fixture(async (configDir, root) => {
  await mkdir(configDir);
  const file = path.join(configDir, "opencode.jsonc");
  for (const body of ['{"plugin":["some-lore-plugin"]}', '{"commands":{"syz":{"template":"hello"}}}', '{broken']) {
    await writeFile(file, body);
    await assert.rejects(planInstall({ configDir, root, replaceConflicts: true }));
    assert.equal(await readFile(file, "utf8"), body);
    assert.deepEqual(await readdir(configDir), ["opencode.jsonc"]);
  }
}));

test("failed installation rolls back displaced files", async () => fixture(async (configDir, root) => {
  await mkdir(path.join(configDir, "plugin"), { recursive: true });
  await writeFile(path.join(configDir, "plugin/lore.ts"), "original");
  const plan = await planInstall({ configDir, root, replaceConflicts: true });
  await assert.rejects(applyPlan(plan, async () => { throw new Error("injected symlink failure"); }), /injected/);
  assert.equal(await readFile(path.join(configDir, "plugin/lore.ts"), "utf8"), "original");
  await assert.rejects(lstat(path.join(configDir, ".opencode-kernel-install.json")), { code: "ENOENT" });
  assert.equal((await planInstall({ configDir, root, replaceConflicts: true })).action, "install");
}));

test("uninstall refuses to overwrite new files at restore destinations", async () => fixture(async (configDir, root) => {
  await mkdir(path.join(configDir, "plugin"), { recursive: true });
  await writeFile(path.join(configDir, "plugin/patchwork.ts"), "old");
  await applyPlan(await planInstall({ configDir, root, replaceConflicts: true }));
  await writeFile(path.join(configDir, "plugin/patchwork.ts"), "new user content");
  await assert.rejects(planInstall({ configDir, root, uninstall: true }), /destination changed/);
  assert.equal(await readFile(path.join(configDir, "plugin/patchwork.ts"), "utf8"), "new user content");
  assert.equal(await readlink(path.join(configDir, "plugins/opencode-kernel")), root);
}));

test("installer refuses modified managed links and symlinked subdirectories", async () => fixture(async (configDir, root) => {
  await mkdir(configDir);
  await symlink(root, path.join(configDir, "plugins"), "dir");
  await assert.rejects(planInstall({ configDir, root }), /symlink configuration/);
  await rm(path.join(configDir, "plugins"));
  await applyPlan(await planInstall({ configDir, root }));
  await rm(path.join(configDir, "plugins/opencode-kernel"));
  await writeFile(path.join(configDir, "plugins/opencode-kernel"), "user content");
  await assert.rejects(planInstall({ configDir, root, uninstall: true }), /user changes/);
}));
