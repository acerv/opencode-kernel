/*
 * SPDX-License-Identifier: MIT
 *
 * Run opt-in retrieval tests against live Lore, Patchwork, and syzbot services.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { listLore, readLore } from "../src/lore.js";
import { listPatchwork, readPatchwork } from "../src/patchwork.js";
import { listSyz, readSyz } from "../src/syzkaller.js";

const options = { skip: process.env.OPENCODE_LIVE !== "1", timeout: 60000 };

test("live Lore list and thread", options, async (t) => {
  const io = { signal: t.signal };
  const list = await listLore({ list: "netdev", limit: 1 }, io);
  assert.match(list, /# Lore Patches: netdev \(1\)/);
  const target = list.match(/Message-ID: (.+)/)?.[1];
  assert(target);
  assert.match(
    await readLore({ target }, io),
    /Patches: \d+; review comments:/,
  );
});

test("live Patchwork list and series", options, async (t) => {
  const io = { signal: t.signal };
  const list = await listPatchwork({ subsystem: "ltp", limit: 1 }, io);
  assert.match(list, /# Patchwork Patches: ltp \(1\)/);
  const target = list.match(/ID: (\d+)/)?.[1];
  assert(target);
  assert.match(await readPatchwork({ target }, io), /### Description/);
});

test("live Syzbot list and report", options, async (t) => {
  const io = { signal: t.signal };
  const list = await listSyz({ timeframe: "all", limit: 1 }, io);
  assert.match(list, /1 shown;/);
  const target = list.match(
    /\]\((https:\/\/syzkaller\.appspot\.com\/bug\?[^)]+)\)/,
  )?.[1];
  assert(target);
  assert.match(
    await readSyz(
      { target, checkLocalSource: false, fetchReproducer: false },
      "/tmp",
      io,
    ),
    /Category:/,
  );
});
