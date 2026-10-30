import assert from "node:assert/strict";
import test from "node:test";
import { bounded, json, MAX_OUTPUT, request, text } from "../src/io.js";

test("HTTP requests require permission for each redirect target", async () => {
  const authorized: string[] = [];
  const output = await text("https://example.org/start", {
    authorize: async (action, paths) => { assert.equal(action, "webfetch"); authorized.push(...paths); },
    fetch: (async (url) => String(url).endsWith("start") ?
      new Response(null, { status: 302, headers: { location: "https://other.example.org/end" } }) :
      new Response("done")) as typeof fetch,
  });
  assert.equal(output, "done");
  assert.deepEqual(authorized, ["https://example.org/start", "https://other.example.org/end"]);
});

test("HTTP and output limits are explicit", async () => {
  await assert.rejects(request("http://example.org/"), /Only HTTPS/);
  await assert.rejects(request("https://example.org/", {
    maxBytes: 3, fetch: async () => new Response("oversized"),
  }), /exceeds/);
  await assert.rejects(request("https://example.org/", {
    fetch: async () => new Response(null, { status: 503 }),
  }), /HTTP 503/);
  await assert.rejects(json("https://example.org/", {
    fetch: async () => new Response("not json"),
  }), /Invalid JSON/);
  assert.match(bounded("x".repeat(MAX_OUTPUT + 1)), /Output truncated/);
});

test("cancellation and timeout stop fetches", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request("https://example.org/", {
    signal: controller.signal, fetch: async () => { throw new Error("must not fetch"); },
  }), { name: "AbortError" });
  const timer = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(request("https://example.org/", {
      timeoutMs: 5,
      fetch: (async (_url, options) => new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      })) as typeof fetch,
    }), { name: "TimeoutError" });
  } finally { clearTimeout(timer); }
});
