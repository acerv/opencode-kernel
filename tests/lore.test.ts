/*
 * SPDX-License-Identifier: MIT
 *
 * Test Lore queries, mail decoding, thread formatting, and command routing.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  decodeHeader,
  formatThread,
  listLore,
  loreListSchema,
  loreReadSchema,
  loreTarget,
  parseAtom,
  parseMbox,
  readLore,
  resolveList,
} from "../src/lore.js";
import { patchCommand } from "../src/platform.js";

const fixture = await readFile(
  new URL("./fixtures/lore-thread.mbox", import.meta.url),
  "utf8",
);
const entry = (id: number) =>
  `<entry><title>[PATCH] Item ${id}</title><author><name>Author</name></author>` +
  `<updated>2026-10-29</updated><link href="https://lore.kernel.org/all/${id}@example.org/"/>` +
  "<content>Some &amp; content</content></entry>";

test("Lore aliases and input schemas preserve defaults", () => {
  assert.equal(resolveList("arm"), "linux-arm-kernel");
  assert.equal(resolveList("rust"), "rust-for-linux");
  assert.deepEqual(loreListSchema.parse({}), {});
  assert.throws(() => resolveList("../etc"));
  assert.throws(() => loreReadSchema.parse({ target: "x", maxDiffLines: 1 }));
  assert.equal(loreTarget("<x@example.org>").id, "x@example.org");
  assert.throws(() => loreTarget("https://example.org/all/x@example.org/"));
});

test("Atom parser handles entities and rejects access challenges", () => {
  const rows = parseAtom(`<feed>${entry(1)}</feed>`);
  assert.equal(rows[0].snippet, "Some & content");
  assert.throws(
    () => parseAtom("<html>Verify you are human</html>"),
    /invalid Atom/,
  );
});

test("Lore defaults apply dates and explicit counts paginate", async () => {
  const urls: string[] = [];
  const io = {
    fetch: (async (url) => {
      urls.push(String(url));
      const offset = Number(new URL(String(url)).searchParams.get("o"));
      return new Response(
        `<feed>${Array.from({ length: offset ? 2 : 200 }, (_, i) => entry(offset + i)).join("")}</feed>`,
      );
    }) as typeof fetch,
  };
  const result = await listLore({ list: "bpf", limit: 201 }, io);
  assert.match(result, /\(201\)/);
  assert.equal(urls.length, 2);
  assert.doesNotMatch(decodeURIComponent(urls[0]), /d:\d{8}/);
  urls.length = 0;
  await listLore({ list: "bpf" }, io);
  assert.match(decodeURIComponent(urls[0]), /d:\d{8}/);
});

test("Lore empty recent results fall back and repeated pages stop", async () => {
  let calls = 0;
  const result = await listLore(
    {},
    {
      fetch: (async () => {
        calls++;
        return new Response(
          calls === 1 ? "<feed></feed>" : `<feed>${entry(1)}</feed>`,
        );
      }) as typeof fetch,
    },
  );
  assert.match(result, /Showing up to 20/);
  assert.equal(calls, 2);
  calls = 0;
  await listLore(
    { all: true },
    {
      fetch: (async () => {
        calls++;
        return new Response(
          `<feed>${Array.from({ length: 200 }, (_, i) => entry(i)).join("")}</feed>`,
        );
      }) as typeof fetch,
    },
  );
  assert.equal(calls, 2);
});

test("Lore all overrides a simultaneous numeric count", async () => {
  const output = await listLore(
    { all: true, limit: 1 },
    {
      fetch: async () => new Response(`<feed>${entry(1)}${entry(2)}</feed>`),
    },
  );
  assert.match(output, /\(2\)/);
});

test("mail parser handles multipart boundaries and encoded headers", () => {
  const mail = parseMbox(fixture);
  assert.equal(mail.length, 4);
  assert.match(mail[1].author, /André/);
  assert.match(mail[1].body, /café/);
  assert.equal(decodeHeader("=?utf-8?B?Y2Fmw6k=?="), "café");
  assert.throws(() => parseMbox("<html>challenge</html>"), /Malformed/);
  assert.equal(
    parseMbox(
      "Message-ID: <x@y>\nSubject: test\nContent-Transfer-Encoding: base64\n\nSGVsbG8=",
    )[0].body,
    "Hello",
  );
});

test("thread formatting includes cover, nested reviews, and bounded diffs", () => {
  const mail = parseMbox(fixture);
  const output = formatThread(mail, "https://lore.kernel.org/", true, 2);
  assert.match(output, /Cover letter motivation/);
  assert.match(output, /Reviewed-by:/);
  assert.match(output, /Thanks for the review/);
  assert.match(output, /Diff truncated/);
  assert.doesNotMatch(
    formatThread(mail, "url", false),
    /Reviewed-by:|Thanks for the review/,
  );
});

test("Lore retrieves compressed mbox and falls back only on absent endpoints", async () => {
  let calls = 0;
  const output = await readLore(
    { target: "patch@example.org" },
    {
      fetch: (async () => {
        calls++;
        return new Response(gzipSync(fixture));
      }) as typeof fetch,
    },
  );
  assert.match(output, /Fix sample/);
  assert.equal(calls, 1);
  calls = 0;
  await readLore(
    { target: "patch@example.org" },
    {
      fetch: (async (url) => {
        calls++;
        return String(url).endsWith(".gz")
          ? new Response("", { status: 404 })
          : new Response(fixture);
      }) as typeof fetch,
    },
  );
  assert.equal(calls, 2);
  await assert.rejects(
    readLore(
      { target: "patch@example.org" },
      {
        authorize: async () => {
          throw new Error("denied");
        },
        fetch: async () => {
          throw new Error("must not fetch");
        },
      },
    ),
    /denied/,
  );
});

test("Lore command routes aliases, defaults, explicit counts, and targets", () => {
  assert.equal(patchCommand("lore", "help"), undefined);
  assert.deepEqual(patchCommand("lore", "list"), {
    tool: "lore_list_patches",
    input: { list: "all" },
  });
  assert.deepEqual(patchCommand("lore", "list bpf 20 tcp"), {
    tool: "lore_list_patches",
    input: { list: "bpf", limit: 20, query: "tcp" },
  });
  assert.deepEqual(patchCommand("lore", "bpf all tcp")?.input, {
    list: "bpf",
    all: true,
    query: "tcp",
  });
  assert.equal(patchCommand("lore", "fetch <x@y>")?.tool, "lore_read_patch");
  assert.equal(
    patchCommand("lore", "https://lore.kernel.org/all/x@y/")?.tool,
    "lore_read_patch",
  );
  assert.throws(() => patchCommand("lore", "read"), /required/);
});

test("Lore command treats a leading number as a count", () => {
  assert.deepEqual(patchCommand("lore", "list 20")?.input, {
    list: "all",
    limit: 20,
  });
});

test("explicit list commands accept queries containing @", () => {
  assert.deepEqual(patchCommand("lore", "list netdev a@b.org"), {
    tool: "lore_list_patches",
    input: { list: "netdev", query: "a@b.org" },
  });
});

test("quoted-printable decoding keeps literal UTF-8 text", () => {
  const [mail] = parseMbox(
    "From x\nSubject: s\nMessage-ID: <a@b>\n" +
      "Content-Transfer-Encoding: quoted-printable\n\ncaf=C3=A9 na\u00efve\n",
  );
  assert.equal(mail.body, "caf\u00e9 na\u00efve");
});

test("mail parser handles MIME parts without headers", () => {
  const [mail] = parseMbox(
    "From x\nSubject: s\nMessage-ID: <a@b>\n" +
      'Content-Type: multipart/mixed; boundary="b"\n\n--b\n\n' +
      "first\n\nsecond\n--b--\n",
  );
  assert.equal(mail.body, "first\n\nsecond");
});

test("Atom parser tolerates malformed link encoding", () => {
  const [item] = parseAtom(
    '<feed><entry><title>t</title><link href="https://lore.kernel.org/all/a%E0%A4%A@b/"/></entry></feed>',
  );
  assert.equal(item.msgId, "a%E0%A4%A@b");
});

test("Lore cap note appears only at the 1000 result cap", async () => {
  const io = {
    fetch: (async (url) => {
      const offset = Number(new URL(String(url)).searchParams.get("o"));
      return new Response(
        `<feed>${Array.from({ length: 200 }, (_, i) => entry(offset + i)).join("")}</feed>`,
      );
    }) as typeof fetch,
  };
  assert.doesNotMatch(await listLore({ limit: 900 }, io), /capped/);
  assert.match(await listLore({ limit: 1000 }, io), /capped/);
});
