import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";

test("exports an OpenCode 2 plugin definition", () => {
  assert.equal(plugin.id, "opencode-kernel");
  assert.equal(typeof plugin.setup, "function");
});
