import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, unavailableCapabilities } from "../lib/routing.mjs";

const CONFIG = {
  evidenceRouting: {
    test_logs: { owner: "tfa", skip: true },
    product_code: { capability: "github" },
    deploy: { capability: "github" },
    infra: { capability: "infra" },
    k8s: { capability: "infra" },
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
  assert.equal(manifest.infra.available, false);
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
  assert.deepEqual(unavailable, ["infra", "metrics", "other"]);
});

