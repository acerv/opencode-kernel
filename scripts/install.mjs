import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath,
  rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const repository = fileURLToPath(new URL("../", import.meta.url));
const reserved = /(?:^|[-_.])(lore|patchwork|syzkaller|syz|opencode-kernel)(?:[-_.]|$)/i;
const toolNames = /(?:lore_(?:list_patches|read_patch)|patchwork_(?:list_patches|read_patch|fetch_series)|syzkaller_(?:list_bugs|read_report))/;
const commands = new Set(["lore", "patchwork", "syz", "syzkaller"]);
const manifestName = ".opencode-kernel-install.json";
const managed = "plugins/opencode-kernel";

async function exists(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
}

function inside(base, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid installer state path");
  }
  return path.join(base, relative);
}

async function plainDirectory(dir) {
  const stat = await exists(dir);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Refusing a non-directory or symlink configuration subdirectory: ${dir}`);
  }
}

async function configuredConflicts(configDir, root) {
  const conflicts = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = path.join(configDir, name);
    if (!await exists(file)) continue;
    const errors = [];
    const config = parse(await readFile(file, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Cannot inspect malformed configuration: ${file}`);
    }
    for (const key of ["plugin", "plugins"]) {
      if (config[key] === undefined) continue;
      if (!Array.isArray(config[key])) throw new Error(`Expected an array for ${key} in ${file}`);
      for (const entry of config[key]) {
        const target = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry?.package;
        if (typeof target !== "string") throw new Error(`Unrecognized plugin entry in ${file}`);
        if (target.startsWith("-")) continue;
        if (reserved.test(path.basename(target)) || target === root || target === `file://${root}`) conflicts.push(`${name}: ${key} entry ${target}`);
      }
    }
    for (const key of ["command", "commands"]) {
      for (const name of Object.keys(config[key] ?? {})) if (commands.has(name)) conflicts.push(`${file}: ${key}.${name}`);
    }
  }
  if (conflicts.length) throw new Error("Resolve these explicit configuration entries manually before installation:\n" +
    conflicts.join("\n") + "\nThe installer never edits your JSON/JSONC configuration.");
}

async function fileConflicts(configDir) {
  const conflicts = [];
  for (const directory of ["plugin", "plugins", "command", "commands"]) {
    const parent = path.join(configDir, directory);
    await plainDirectory(parent);
    if (!await exists(parent)) continue;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (relative === managed) continue;
      if (directory.startsWith("command")) {
        if (entry.name.endsWith(".md") && commands.has(entry.name.slice(0, -3))) conflicts.push(relative);
        continue;
      }
      const loadable = entry.isDirectory() || entry.isSymbolicLink() || /\.(js|ts)$/.test(entry.name);
      if (!loadable) continue;
      let conflict = reserved.test(entry.name);
      if (!conflict && entry.isFile()) {
        const file = path.join(parent, entry.name);
        if ((await lstat(file)).size > 1024 * 1024) throw new Error(`Inspect this large plugin manually: ${file}`);
        conflict = toolNames.test(await readFile(file, "utf8"));
      }
      if (conflict) conflicts.push(relative);
    }
  }
  return conflicts.sort();
}

async function readState(configDir) {
  const file = path.join(configDir, manifestName);
  if (!await exists(file)) return;
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installer state must be a regular file");
  const state = JSON.parse(await readFile(file, "utf8"));
  if (state.version !== 1 || state.phase !== "installed" || typeof state.repository !== "string" ||
      !Array.isArray(state.displaced) || !/^\.opencode-kernel-backup-[\w-]+$/.test(state.backup)) {
    throw new Error("Incomplete or invalid installer state. Inspect the journal and backups before recovery.");
  }
  await plainDirectory(path.join(configDir, state.backup));
  for (const item of state.displaced) {
    inside(configDir, item.path);
    if (!/^(?:plugins?|commands?)\//.test(item.path) || item.path === managed || !/^\d+$/.test(item.backup)) {
      throw new Error("Invalid displaced path in installer state");
    }
  }
  return state;
}

async function assertOwnedLink(configDir, state) {
  const file = path.join(configDir, managed);
  const info = await exists(file);
  if (!info?.isSymbolicLink() || await readlink(file) !== state.repository) {
    throw new Error(`Installed link changed or missing; refusing to overwrite user changes: ${file}`);
  }
}

export async function planInstall({ configDir, root = repository, replaceConflicts = false, uninstall = false }) {
  configDir = path.resolve(configDir);
  if (await exists(configDir)) configDir = await realpath(configDir);
  root = await realpath(root);
  const state = await readState(configDir);
  await plainDirectory(path.join(configDir, "plugins"));
  if (uninstall) {
    if (!state) return { action: "none", configDir, message: "Not installed." };
    await assertOwnedLink(configDir, state);
    for (const item of state.displaced) {
      await plainDirectory(path.dirname(inside(configDir, item.path)));
      if (await exists(inside(configDir, item.path))) throw new Error(`Restore destination changed: ${item.path}`);
      if (!await exists(path.join(configDir, state.backup, item.backup))) throw new Error(`Backup missing for ${item.path}`);
    }
    return { action: "uninstall", configDir, state, message: "Remove the managed link and restore displaced files." };
  }
  if (!await exists(path.join(root, "server.js")) || !await exists(path.join(root, "dist/index.js")) ||
      !await exists(path.join(root, "node_modules"))) {
    throw new Error("Run npm ci --ignore-scripts and npm run check before installation.");
  }
  await configuredConflicts(configDir, root);
  const conflicts = await fileConflicts(configDir);
  if (state) {
    await assertOwnedLink(configDir, state);
    if (state.repository !== root) throw new Error("Another checkout owns this installation. Uninstall that checkout first.");
    if (conflicts.length) throw new Error("New conflicting files found. Uninstall and resolve them before reinstalling:\n" + conflicts.join("\n"));
    return { action: "none", configDir, message: "Already installed; the existing link uses this checkout's current build." };
  }
  if (await exists(path.join(configDir, managed))) throw new Error("The managed plugin path already exists without an ownership manifest");
  if (conflicts.length && !replaceConflicts) throw new Error("Conflicting files found:\n" + conflicts.join("\n") +
    "\nReview them, then rerun with --replace-conflicts to approve backup and replacement.");
  return { action: "install", configDir, root, conflicts, message: `Link ${root} at ${path.join(configDir, managed)}` };
}

async function saveState(configDir, state) {
  const temporary = path.join(configDir, `${manifestName}.tmp`);
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path.join(configDir, manifestName));
}

// createLink is injectable so tests can exercise rollback without touching global configuration.
export async function applyPlan(plan, createLink = symlink) {
  if (plan.action === "none") return;
  const configDir = plan.configDir;
  await mkdir(configDir, { recursive: true });
  const lockPath = path.join(configDir, ".opencode-kernel-install.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let state;
  const moved = [];
  let linked = false;
  try {
    const current = await planInstall({ configDir, root: plan.root ?? plan.state.repository,
      replaceConflicts: true, uninstall: plan.action === "uninstall" });
    if (current.action !== plan.action || JSON.stringify(current.conflicts) !== JSON.stringify(plan.conflicts) ||
        JSON.stringify(current.state) !== JSON.stringify(plan.state)) {
      throw new Error("Installation changed after planning; rerun the installer");
    }
    if (plan.action === "install") {
      // Recheck after obtaining the lock; stale dry-run plans cannot overwrite new files.
      if (await exists(path.join(configDir, manifestName)) || await exists(path.join(configDir, managed))) {
        throw new Error("Installation changed after planning; rerun the installer");
      }
      const backup = await mkdtemp(path.join(configDir, ".opencode-kernel-backup-"));
      state = { version: 1, phase: "installing", repository: plan.root, backup: path.basename(backup),
        displaced: plan.conflicts.map((file, i) => ({ path: file, backup: String(i) })) };
      await saveState(configDir, state);
      for (const item of state.displaced) {
        await rename(inside(configDir, item.path), path.join(backup, item.backup));
        moved.push(item);
      }
      await mkdir(path.join(configDir, "plugins"), { recursive: true });
      await createLink(plan.root, path.join(configDir, managed), "dir");
      linked = true;
      await saveState(configDir, { ...state, phase: "installed" });
    } else {
      state = plan.state;
      await assertOwnedLink(configDir, state);
      await saveState(configDir, { ...state, phase: "uninstalling" });
      for (const item of state.displaced) {
        if (await exists(inside(configDir, item.path))) throw new Error(`Restore destination changed: ${item.path}`);
        await rename(path.join(configDir, state.backup, item.backup), inside(configDir, item.path));
        moved.push(item);
      }
      await assertOwnedLink(configDir, state);
      await unlink(path.join(configDir, managed));
      linked = true;
      await unlink(path.join(configDir, manifestName));
      // Keep the empty backup directory rather than risk deleting files added by a user.
    }
  } catch (error) {
    try {
      if (state && plan.action === "install") {
        if (linked) { await assertOwnedLink(configDir, state); await unlink(path.join(configDir, managed)); }
        for (const item of moved.reverse()) {
          if (await exists(inside(configDir, item.path))) throw new Error(`Cannot roll back over new file: ${item.path}`);
          await rename(path.join(configDir, state.backup, item.backup), inside(configDir, item.path));
        }
        await rm(path.join(configDir, manifestName), { force: true });
      } else if (state) {
        if (linked) await symlink(state.repository, path.join(configDir, managed), "dir");
        for (const item of moved.reverse()) await rename(inside(configDir, item.path), path.join(configDir, state.backup, item.backup));
        await saveState(configDir, { ...state, phase: "installed" });
      }
    } catch (rollback) {
      throw new AggregateError([error, rollback], "Installer rollback incomplete. Preserve the journal and backups for recovery.");
    }
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function main(args) {
  let configDir = process.env.OPENCODE_CONFIG_DIR ??
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode");
  let apply = false;
  let replaceConflicts = false;
  let uninstall = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--replace-conflicts") replaceConflicts = true;
    else if (arg === "--uninstall") uninstall = true;
    else if (arg === "--config-dir" && args[i + 1]) configDir = args[++i];
    else if (arg === "--help") {
      console.log("Usage: node scripts/install.mjs [--apply|--dry-run] [--uninstall] [--replace-conflicts] [--config-dir PATH]");
      return;
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  const plan = await planInstall({ configDir, replaceConflicts, uninstall });
  console.log(plan.message);
  if (plan.conflicts?.length) console.log("Back up and replace:\n" + plan.conflicts.join("\n"));
  if (apply) {
    if (plan.action === "install") {
      const { stdout } = await promisify(execFile)("opencode", ["--version"], { timeout: 5000 });
      if (!/^opencode v?2\.1\.2\s*$/.test(stdout.trim())) {
        throw new Error("This installer targets OpenCode 2.1.2; no files changed.");
      }
    }
    await applyPlan(plan);
  } else console.log("Dry run; no files changed. Add --apply to execute.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
