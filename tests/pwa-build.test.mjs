import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("GitHub Pages build is installable and complete offline", async () => {
  const manifest = JSON.parse(await readFile("dist-pages/manifest.webmanifest", "utf8"));
  const serviceWorker = await readFile("dist-pages/sw.js", "utf8");

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.match(serviceWorker, /\.\/index\.html/);
  assert.match(serviceWorker, /\.\/manifest\.webmanifest/);
  assert.match(serviceWorker, /\.\/bridges\/spiOverJtag_ep4ce2217\.rbf/);
  assert.match(serviceWorker, /\.\/assets\/index-[^"']+\.js/);
  assert.match(serviceWorker, /\.\/assets\/index-[^"']+\.css/);
});
