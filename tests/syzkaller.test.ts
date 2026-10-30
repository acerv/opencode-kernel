/*
 * SPDX-License-Identifier: MIT
 *
 * Test syzbot filtering, crash parsing, reproducers, and safe local source access.
 */

import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classify, frames, parseCrash } from "../src/crash.js";
import { localPath, sourceSnippet } from "../src/local.js";
import {
  listSyz,
  parseBugs,
  readSyz,
  recentAge,
  syzCommand,
} from "../src/syzkaller.js";

const report = await readFile(
  new URL("./fixtures/crash.log", import.meta.url),
  "utf8",
);
const bug = (id: string, age: string, repro: string) =>
  `<tr><td class="title"><a href="/bug?extid=${id}">KASAN: use-after-free &amp; bug</a>` +
  '<span class="bug-label"><a href="/upstream/s/usb">usb</a></span></td>' +
  `<td class="stat">1</td><td class="stat">${repro}</td><td class="stat" sort-value="5">5</td><td class="stat">${age}</td></tr>`;

test("Syzbot listing applies age, reproducer, title, and fallback filters", async () => {
  assert(recentAge("1d23h"));
  assert(recentAge("47h"));
  assert.equal(recentAge("48h"), false);
  assert.equal(recentAge("2d"), false);
  assert.equal(recentAge("never"), false);
  const html = `<table>${bug("aaaa", "1h", "C")}${bug("bbbb", "3d", "syz")}</table>`;
  assert.equal(parseBugs(html)[0].labels[0], "usb");
  const io = { fetch: async () => new Response(html) };
  const recent = await listSyz({ subsystem: "usb", hasReproOnly: true }, io);
  assert.match(recent, /aaaa/);
  assert.doesNotMatch(recent, /bbbb/);
  assert.match(await listSyz({ timeframe: "all" }, io), /bbbb/);
  assert.match(
    await listSyz(
      {},
      {
        fetch: async () =>
          new Response(`<table>${bug("cccc", "3d", "C")}</table>`),
      },
    ),
    /Showing recent open bugs/,
  );
  assert.match(await listSyz({ query: "does-not-match" }, io), /0 shown/);
  assert.throws(() => parseBugs("<html>challenge</html>"));
});

test("crash parser separates fault, allocation, free, and metadata", () => {
  const parsed = parseCrash(report);
  assert.equal(parsed.category, "Use-After-Free (UAF)");
  assert.equal(parsed.fault?.func, "consume_buffer");
  assert.equal(parsed.crash.length, 4);
  assert.equal(parsed.alloc.length, 1);
  assert.equal(parsed.free.length, 1);
  assert.equal(parsed.allocTask, "120");
  assert.equal(parsed.freeTask, "121");
  assert(parsed.metadata.some((line) => line.includes("kmalloc-64")));
  assert(parsed.metadata.some((line) => line.includes("abcdef012345")));
  assert.equal(
    frames("[ 123.45] helper drivers/sample.c:2 [inline]")[0].inline,
    true,
  );
  assert.equal(
    parseCrash(
      "WARNING: sample\nRIP: 0010:warn_func+0x1/0x2 drivers/sample.c:3",
    ).fault?.func,
    "warn_func",
  );
  assert.equal(
    classify("BUG: KMSAN: uninit-value"),
    "Uninitialized Memory (KMSAN)",
  );
});

test("remote bugs fetch report and optional reproducers with metadata", async () => {
  const urls: string[] = [];
  const fetcher = (async (raw) => {
    const url = new URL(String(raw));
    urls.push(url.href);
    if (url.pathname === "/bug")
      return new Response(
        "<title>Sample</title>Status: <a>open</a>Reported-by: syzbot+abc@example.org " +
          '<a href="/text?tag=CrashReport&amp;x=1">report</a><a href="/text?tag=ReproC&amp;x=2">C</a>' +
          '<a href="https://lore.kernel.org/all/a@b/">discussion</a>',
      );
    return new Response(
      url.searchParams.get("tag") === "CrashReport"
        ? report
        : "int main(void) { return 0; }",
    );
  }) as typeof fetch;
  const output = await readSyz(
    { target: "0123456789abcdef0123", checkLocalSource: false },
    "/tmp",
    { fetch: fetcher },
  );
  assert.match(output, /consume_buffer/);
  assert.match(output, /int main/);
  assert.match(output, /syzbot\+abc@example.org/);
  assert.match(output, /Discussion:/);
  assert.equal(urls.length, 3);
  urls.length = 0;
  await readSyz(
    {
      target: "0123456789abcdef0123",
      checkLocalSource: false,
      fetchReproducer: false,
    },
    "/tmp",
    { fetch: fetcher },
  );
  assert.equal(urls.length, 2);
  await assert.rejects(
    readSyz({ target: "0123456789abcdef0123" }, "/tmp", {
      fetch: fetcher,
      authorize: async (_action, paths) => {
        if (paths[0].includes("CrashReport")) throw new Error("denied");
      },
    }),
    /denied/,
  );
});

test("raw reports do not access local files when correlation is off", async () => {
  const output = await readSyz(
    { target: report, checkLocalSource: false },
    "/tmp",
    {
      authorize: async () => {
        throw new Error("unexpected access");
      },
    },
  );
  assert.match(output, /Allocation \(task 120\)/);
  assert.match(output, /Free \(task 121\)/);
});

test("local crash directories correlate all roles without executing reproducers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ock-local-"));
  try {
    await mkdir(path.join(root, "drivers"));
    await mkdir(path.join(root, "crash"));
    await writeFile(
      path.join(root, "drivers/sample.c"),
      "first\nallocate\nconsume\nfree\n",
    );
    await writeFile(path.join(root, "crash/report"), report);
    await writeFile(
      path.join(root, "crash/repro.c"),
      "int main() { return 0; }",
    );
    const permissions: string[] = [];
    const output = await readSyz({ target: "crash" }, root, {
      authorize: async (action) => {
        permissions.push(action);
      },
    });
    assert.match(output, /--> 3 \| consume/);
    assert.match(output, /--> 2 \| allocate/);
    assert.match(output, /--> 4 \| free/);
    assert.match(output, /Git history unavailable/);
    assert.equal(permissions.filter((action) => action === "shell").length, 3);
    assert.match(output, /not executed/);
    const withoutRepro = await readSyz(
      { target: "crash", fetchReproducer: false, checkLocalSource: false },
      root,
    );
    assert.doesNotMatch(withoutRepro, /int main/);
    await assert.rejects(readSyz({ target: "missing.log" }, root), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source paths reject traversal, absolute paths, and symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ock-paths-"));
  try {
    await mkdir(path.join(root, "tree"));
    await writeFile(path.join(root, "outside.c"), "secret");
    await symlink(path.join(root, "outside.c"), path.join(root, "tree/link.c"));
    const frame = { func: "bad", line: 1, inline: false, raw: "bad" };
    for (const file of [
      "../outside.c",
      "/etc/passwd",
      ".git/config",
      "bad;command.c",
    ]) {
      assert.match(
        await sourceSnippet({ ...frame, file }, path.join(root, "tree"), {
          authorize: async () => {
            throw new Error("must reject before access");
          },
        }),
        /rejected/,
      );
    }
    assert.match(
      await sourceSnippet(
        { ...frame, file: "link.c" },
        path.join(root, "tree"),
        {},
      ),
      /symlink escapes/,
    );
    assert.match(
      await sourceSnippet(
        { ...frame, file: "missing.c" },
        path.join(root, "tree"),
        {},
      ),
      /unavailable/,
    );
    await assert.rejects(
      localPath("link.c", path.join(root, "tree"), {
        authorize: async (action) => {
          if (action === "external_directory")
            throw new Error("external denied");
        },
      }),
      /external denied/,
    );
    await assert.rejects(
      sourceSnippet({ ...frame, file: "link.c" }, path.join(root, "tree"), {
        authorize: async () => {
          throw new Error("read denied");
        },
      }),
      /read denied/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syz aliases share explicit read and list routing", () => {
  assert.deepEqual(syzCommand(""), {
    tool: "syzkaller_list_bugs",
    input: { timeframe: "recent" },
  });
  assert.deepEqual(syzCommand("usb 20"), {
    tool: "syzkaller_list_bugs",
    input: { subsystem: "usb", timeframe: "all", limit: 20 },
  });
  assert.equal(syzCommand("./crashes/sample")?.tool, "syzkaller_read_report");
  assert.deepEqual(syzCommand("read crash directory")?.input, {
    target: "crash directory",
  });
  assert.equal(
    syzCommand("0123456789abcdef0123")?.tool,
    "syzkaller_read_report",
  );
});

test("crash parser strips console timestamps and caller IDs", () => {
  const parsed = parseCrash(
    "[   12.345678][ T5012] BUG: KASAN: use-after-free in foo\n" +
      "[   12.345679][ T5012] Call Trace:\n" +
      "[   12.345680][ T5012]  foo+0x10/0x20 fs/foo.c:12\n" +
      "[   12.345681][    C0]  bar+0x1/0x2 fs/bar.c:3\n",
  );
  assert.deepEqual(
    parsed.crash.map((frame) => frame.func),
    ["foo", "bar"],
  );
  assert.equal(parsed.fault?.file, "fs/foo.c");
});

test("syz read requires a target", () => {
  assert.throws(() => syzCommand("read"), /required/);
});

test("relative paths in a symlinked working directory stay internal", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ok-cwd-"));
  try {
    await mkdir(path.join(base, "real"));
    await writeFile(path.join(base, "real", "crash.log"), "x");
    await symlink(path.join(base, "real"), path.join(base, "link"));
    const actions: string[] = [];
    await localPath("crash.log", path.join(base, "link"), {
      authorize: async (action) => {
        actions.push(action);
      },
    });
    assert.deepEqual(actions, ["read"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
