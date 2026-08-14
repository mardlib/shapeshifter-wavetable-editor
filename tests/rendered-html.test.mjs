import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders WavePort without the disposable starter preview", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>WavePort — Shapeshifter Wavetable Studio<\/title>/i);
  assert.match(html, /Wavetable Bank Editor/);
  assert.match(html, /USE AT YOUR OWN RISK/);
  assert.match(html, /not affiliated with, authorized by, or endorsed by Intellijel Designs Inc\./);
  assert.match(html, /Connect Shapeshifter/);
  assert.match(html, /Bank editor/);
  assert.doesNotMatch(html, /react-loading-skeleton|Your site is taking shape/);
});
