import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listPatchwork, patchworkReadSchema, patchworkTarget, readPatchwork, resolveProject } from "../src/patchwork.js";
import { patchCommand } from "../src/platform.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/patchwork.json", import.meta.url), "utf8"));
function fixtureFetch(seen: string[] = []): typeof fetch {
  return (async (raw) => {
    const url = new URL(String(raw));
    seen.push(url.href);
    if (url.pathname.endsWith("comments/")) return Response.json([fixture.comment]);
    if (url.pathname.endsWith("/series/9/")) return Response.json(fixture.series);
    if (url.pathname.endsWith("/covers/3/")) return Response.json(fixture.cover);
    if (url.searchParams.has("msgid")) return Response.json([fixture.patches[0]]);
    const patch = fixture.patches.find((p: any) => url.pathname.endsWith(`/patches/${p.id}/`));
    return patch ? Response.json(patch) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

test("Patchwork aliases and target forms", () => {
  for (const name of ["net", "bpf", "netdev", "linux-netdev"]) assert.equal(resolveProject(name), "netdevbpf");
  assert.equal(resolveProject("nvme"), "linux-nvme");
  assert.equal(resolveProject("arm"), "linux-arm-kernel");
  assert.equal(patchworkTarget("https://patchwork.example.org/project/x/patch/a%40b/").value, "a@b");
  assert.equal(patchworkTarget("https://patchwork.kernel.org/project/x/list/?series=9").collection, "series");
  assert.throws(() => patchworkTarget("nonsense"));
  assert.throws(() => patchworkReadSchema.parse({}));
});

test("Patchwork listing preserves filters and date/count behavior", async () => {
  const seen: URL[] = [];
  const fetcher = (async (raw) => {
    const url = new URL(String(raw)); seen.push(url);
    const page = Number(url.searchParams.get("page"));
    return Response.json(Array.from({ length: page === 1 ? 250 : 1 }, (_, i) => ({
      id: (page - 1) * 250 + i + 1, name: `Patch ${i}`, state: "new",
    })));
  }) as typeof fetch;
  const result = await listPatchwork({ subsystem: "netdev", limit: 251, query: "tcp", state: "new" }, { fetch: fetcher });
  assert.match(result, /\(251\)/);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].searchParams.get("project"), "netdevbpf");
  assert.equal(seen[0].searchParams.get("q"), "tcp");
  assert.equal(seen[0].searchParams.get("state"), "new");
  assert.equal(seen[0].searchParams.has("since"), false);
  seen.length = 0;
  await listPatchwork({ project: "ltp" }, { fetch: fetcher });
  assert.equal(seen[0].searchParams.has("since"), true);
});

test("empty recent lists fall back without masking network errors", async () => {
  let calls = 0;
  const output = await listPatchwork({}, { fetch: async () => {
    calls++;
    return Response.json(calls === 1 ? [] : [fixture.patches[0]]);
  } });
  assert.match(output, /Showing up to 20/);
  await assert.rejects(listPatchwork({}, { fetch: async () => new Response(null, { status: 503 }) }), /HTTP 503/);
  await assert.rejects(listPatchwork({}, { fetch: async () => Response.json({ unexpected: true }) }));
});

test("a patch resolves its full series, cover, diffs, and reviews", async () => {
  const output = await readPatchwork({ target: "10" }, { fetch: fixtureFetch() });
  for (const value of ["Cover motivation", "First motivation", "Second motivation", "Reviewed-by:", "+first"]) {
    assert(output.includes(value), value);
  }
  assert.match(output, /version: 2/);
});

test("series, covers, Message-IDs, and legacy url resolve", async () => {
  for (const target of ["9", "<a@b>",
    "https://patchwork.kernel.org/series/9/", "https://patchwork.kernel.org/cover/3/"]) {
    assert.match(await readPatchwork({ url: target }, { fetch: fixtureFetch() }), /Second motivation/);
  }
});

test("standalone patches and paginated comments", async () => {
  const seen: string[] = [];
  const output = await readPatchwork({ target: "22" }, { fetch: (async (raw) => {
    const url = new URL(String(raw)); seen.push(url.href);
    if (!url.pathname.endsWith("comments/")) return Response.json({
      id: 22, name: "Standalone", content: "Fix", comments: "https://patchwork.kernel.org/comments/",
    });
    if (url.searchParams.get("page") === "2") return Response.json({ results: [{ content: "Second review" }], next: null });
    return Response.json({ results: [fixture.comment], next: "https://patchwork.kernel.org/comments/?page=2" });
  }) as typeof fetch });
  assert.match(output, /Standalone/);
  assert.match(output, /Second review/);
  assert.equal(seen.length, 3);
});

test("comment HTTP errors are disclosed but permission rejection propagates", async () => {
  const base = fixtureFetch();
  const output = await readPatchwork({ target: "10" }, { fetch: (async (url, options) =>
    String(url).includes("comments/") ? new Response(null, { status: 503 }) : base(url, options)) as typeof fetch });
  assert.match(output, /Comments unavailable/);
  await assert.rejects(readPatchwork({ target: "10" }, {
    fetch: base,
    authorize: async (_action, urls) => { if (urls[0].includes("comments/")) throw new Error("denied"); },
  }), /denied/);
});

test("Patchwork command distinguishes numeric lists from patch IDs", () => {
  assert.deepEqual(patchCommand("patchwork", "list 20 tcp"), {
    tool: "patchwork_list_patches", input: { subsystem: "all", limit: 20, query: "tcp" },
  });
  assert.equal(patchCommand("patchwork", "123")?.tool, "patchwork_read_patch");
  assert.deepEqual(patchCommand("patchwork", "list ltp ALL")?.input, { subsystem: "ltp", all: true });
});
