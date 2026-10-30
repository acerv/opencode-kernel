/*
 * SPDX-License-Identifier: MIT
 *
 * Test native registration, command prompts, permissions, and plugin cleanup.
 */

import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type { Plugin } from "@opencode/plugin";

test("exports an OpenCode 2 plugin definition", () => {
  assert.equal(plugin.id, "opencode-kernel");
  assert.equal(typeof plugin.setup, "function");
});

test("registers native tools and commands and releases registrations", async () => {
  const tools: any[] = [];
  const commands: any[] = [];
  const prompts: any[] = [];
  let disposed = 0;
  const context = {
    tool: {
      transform: async (fn: any) => {
        fn({ add: (t: any) => tools.push(t) });
        return {
          dispose: async () => {
            disposed++;
          },
        };
      },
    },
    command: {
      transform: async (fn: any) => {
        fn({ add: (c: any) => commands.push(c) });
        return {
          dispose: async () => {
            disposed++;
          },
        };
      },
    },
    session: {
      prompt: async (p: any) => {
        prompts.push(p);
      },
    },
    permission: {
      assert: async () => {
        throw new Error("permission denied");
      },
    },
    location: { directory: "/tmp" },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(context);
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "lore_list_patches",
    "lore_read_patch",
    "patchwork_fetch_series",
    "patchwork_list_patches",
    "patchwork_read_patch",
    "syzkaller_list_bugs",
    "syzkaller_read_report",
  ]);
  assert.deepEqual(commands.map((c) => c.name).sort(), [
    "lore",
    "patchwork",
    "syz",
    "syzkaller",
  ]);
  await commands
    .find((c) => c.name === "lore")
    .execute({
      sessionID: "test",
      prompt: { text: "list bpf 20" },
      delivery: "queue",
    });
  assert.match(prompts[0].text, /lore_list_patches/);
  assert.match(prompts[0].text, /"limit":20/);
  await assert.rejects(
    tools
      .find((t) => t.name === "lore_list_patches")
      .execute(
        {},
        {
          sessionID: "test",
          agent: "build",
          messageID: "m",
          id: "call",
          signal: new AbortController().signal,
        },
      ),
    /permission denied/,
  );
  await cleanup?.();
  assert.equal(disposed, 2);
});
