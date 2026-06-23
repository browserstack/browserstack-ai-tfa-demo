import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, unavailableCapabilities } from "../lib/routing.mjs";
import { makeEvidenceCache, resolveBaseline } from "../lib/evidence-cache.mjs";

const CONFIG = {
  evidenceRouting: {
    test_logs: { owner: "tfa", skip: true },
    product_code: { capability: "github" },
    deploy: { capability: "github" },
    k8s: { capability: "k8s" },
    metrics: { capability: "metrics" },
    other: { capability: "other" },
  },
};

test("buildManifest marks discovered capabilities available with via", () => {
  const manifest = buildManifest(CONFIG, [
    { capability: "github", via: "github-mcp" },
  ]);
  assert.equal(manifest.github.available, true);
  assert.equal(manifest.github.via, "github-mcp");
  assert.equal(manifest.k8s.available, false);
});

test("buildManifest excludes the TFA-owned test_logs capability", () => {
  const manifest = buildManifest(CONFIG, []);
  assert.ok(!("undefined" in manifest));
  assert.ok(!Object.keys(manifest).includes("test_logs"));
});

test("buildManifest dedupes capabilities shared by multiple evidence types", () => {
  // product_code + deploy both map to github → one manifest entry
  const manifest = buildManifest(CONFIG, [{ capability: "github" }]);
  assert.equal(Object.keys(manifest).filter((k) => k === "github").length, 1);
});

test("unavailableCapabilities lists what the client can't get", () => {
  const manifest = buildManifest(CONFIG, [{ capability: "github" }]);
  const unavailable = unavailableCapabilities(manifest).sort();
  assert.deepEqual(unavailable, ["k8s", "metrics", "other"]);
});

test("evidence cache computes once and reuses across calls", async () => {
  const cache = makeEvidenceCache();
  let calls = 0;
  const fn = async () => {
    calls++;
    return { prs: ["#1"] };
  };
  const a = await cache.compute("repo", "abc..def", "deploy", fn);
  const b = await cache.compute("repo", "abc..def", "deploy", fn);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(cache.size(), 1);
});

test("evidence cache key distinguishes commit ranges", async () => {
  const cache = makeEvidenceCache();
  let calls = 0;
  const fn = async () => ++calls;
  await cache.compute("repo", "r1", "deploy", fn);
  await cache.compute("repo", "r2", "deploy", fn);
  assert.equal(calls, 2);
});

test("resolveBaseline uses last-green when present, else flags fallback", () => {
  assert.deepEqual(resolveBaseline("v1.2.3", "main"), {
    ref: "v1.2.3",
    isFallback: false,
  });
  assert.deepEqual(resolveBaseline(null, "main"), {
    ref: "main",
    isFallback: true,
  });
});
