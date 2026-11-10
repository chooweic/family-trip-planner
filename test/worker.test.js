// Route tests for the Worker (src/worker/index.js).
// The Worker is a plain object with a fetch(request, env) handler, so it runs
// directly in Node with a stand-in ASSETS binding. No wrangler or network needed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker/index.js";

const BASE = "https://trip.example.test";

// Records every request the Worker hands to the static-asset binding.
function fakeEnv() {
  const seen = [];
  return {
    seen,
    ASSETS: {
      fetch: async (request) => {
        seen.push(request);
        return new Response("<!doctype html>page", { headers: { "content-type": "text/html" } });
      },
    },
  };
}

const call = (path, init, env = fakeEnv()) => worker.fetch(new Request(BASE + path, init), env);

describe("GET /api/health", () => {
  test("returns 200 with ok and the current time", async () => {
    const before = Date.now();
    const res = await call("/api/health");
    const after = Date.now();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["ok", "time"]);
    assert.equal(body.ok, true);
    // ISO 8601 in UTC, and taken at request time (not cached at module load).
    assert.match(body.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const t = Date.parse(body.time);
    assert.ok(t >= before - 1 && t <= after + 1, `time ${body.time} not within the request`);
  });

  test("ignores the query string", async () => {
    const res = await call("/api/health?probe=1");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test("never reaches the static assets", async () => {
    const env = fakeEnv();
    await call("/api/health", undefined, env);
    assert.equal(env.seen.length, 0);
  });
});

describe("unknown /api/* routes", () => {
  for (const path of ["/api/", "/api/nope", "/api/health/", "/api/health/extra", "/api/trips/123"]) {
    test(`${path} is a JSON 404, not the page`, async () => {
      const env = fakeEnv();
      const res = await call(path, undefined, env);
      assert.equal(res.status, 404);
      assert.match(res.headers.get("content-type"), /^application\/json/);
      assert.deepEqual(await res.json(), { error: "not found" });
      assert.equal(env.seen.length, 0, "an API miss must not fall through to the SPA page");
    });
  }

  test("a POST to an unknown route is also a JSON 404", async () => {
    const res = await call("/api/nope", { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  });
});

describe("everything else is the static page", () => {
  for (const path of ["/", "/index.html", "/trips/abc", "/apis", "/api"]) {
    test(`${path} is passed to ASSETS unchanged`, async () => {
      const env = fakeEnv();
      const request = new Request(BASE + path);
      const res = await worker.fetch(request, env);

      assert.equal(env.seen.length, 1);
      assert.equal(env.seen[0], request, "the original Request object is forwarded");
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "<!doctype html>page");
    });
  }

  test("the ASSETS response is returned as is", async () => {
    const sentinel = new Response("missing", { status: 404 });
    const env = { ASSETS: { fetch: async () => sentinel } };
    const res = await worker.fetch(new Request(BASE + "/favicon.ico"), env);
    assert.equal(res, sentinel);
  });
});
