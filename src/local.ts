/*
 * SPDX-License-Identifier: MIT
 *
 * Read approved local files and correlate source snippets with Git history.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Frame } from "./crash.js";
import { MAX_BYTES, type IO } from "./io.js";

const exec = promisify(execFile);
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

export async function localPath(
  raw: string,
  cwd: string,
  io: IO,
): Promise<string> {
  io.signal?.throwIfAborted();
  const expanded = raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  const root = await realpath(cwd);
  const target = path.resolve(root, expanded);
  const authorize = async (file: string) => {
    if (!within(root, file))
      await io.authorize?.("external_directory", [
        path.join(path.dirname(file), "*"),
      ]);
    await io.authorize?.("read", [file]);
    io.signal?.throwIfAborted();
  };
  await authorize(target);
  const resolved = await realpath(target);
  if (resolved !== target) await authorize(resolved);
  return resolved;
}

export async function readLocal(file: string, io: IO = {}): Promise<string> {
  io.signal?.throwIfAborted();
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    if (stat.size > MAX_BYTES)
      throw new Error(`File exceeds ${MAX_BYTES} bytes: ${file}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      io.signal?.throwIfAborted();
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BYTES)
        throw new Error(`File exceeds ${MAX_BYTES} bytes: ${file}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function sourceSnippet(
  frame: Frame,
  cwd: string,
  io: IO,
): Promise<string> {
  if (!frame.file || !frame.line)
    return "No source file and line in this frame.";
  const file = frame.file;
  if (
    path.isAbsolute(file) ||
    file.split(/[\\/]/).some((part) => ["..", ".git"].includes(part)) ||
    !/^[\w./-]+\.(?:c|h|S|s|rs|cc|cpp)$/.test(file)
  ) {
    return `Source path rejected: ${file}`;
  }
  const root = await realpath(cwd);
  // This preliminary approval protects path metadata too. Resolve symlinks before reading.
  await io.authorize?.("read", [path.resolve(root, file)]);
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(root, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return `Local source unavailable: ${file}`;
    throw error;
  }
  if (!within(root, resolved))
    return `Source symlink escapes the working directory: ${file}`;
  await io.authorize?.("read", [resolved]);
  const source = (await readLocal(resolved, io)).split("\n");
  if (frame.line > source.length)
    return `Source line ${frame.line} is beyond ${file}; kernel versions may differ.`;
  const start = Math.max(1, frame.line - 10);
  const end = Math.min(source.length, frame.line + 10);
  const snippet = source
    .slice(start - 1, end)
    .map(
      (line, i) =>
        `${start + i === frame.line ? "-->" : "   "} ${start + i} | ${line}`,
    )
    .join("\n");
  // Native OpenCode 2 calls its shell permission "shell", not "bash".
  await io.authorize?.("shell", [`git log -n 1 --oneline -- ${file}`]);
  let history: string;
  try {
    const { stdout } = await exec(
      "git",
      [
        "--no-pager",
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
        "log",
        "--no-show-signature",
        "-n",
        "1",
        "--oneline",
        "--",
        file,
      ],
      {
        signal: io.signal,
        timeout: 5000,
        maxBuffer: 16 * 1024,
      },
    );
    history = stdout.trim() || "No commit recorded for this file.";
  } catch (error) {
    io.signal?.throwIfAborted();
    history = `Git history unavailable: ${(error as NodeJS.ErrnoException).code ?? "execution failed"}`;
  }
  return `Working-tree source: ${file}:${frame.line}\nLast commit: ${history}\n\n\`\`\`c\n${snippet}\n\`\`\``;
}
