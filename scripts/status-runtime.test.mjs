import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

let freshness = {};
try {
  freshness = require("../assets/status-freshness.js");
} catch {}

const NOW = Date.parse("2026-08-01T10:00:00.000Z");

function artifact(checkedAt = "2026-08-01T09:40:00.000Z") {
  return { checkedAt };
}

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
  };
}

function createElement() {
  return { dataset: {}, hidden: false, textContent: "Initial warning" };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("uses immutable checkedAt so an old scheduled rerun remains stale", () => {
  assert.equal(typeof freshness.classifyFreshnessArtifact, "function");
  assert.equal(freshness.STALE_AFTER_MS, 20 * 60 * 1000);
  assert.deepEqual(
    freshness.classifyFreshnessArtifact(artifact(), NOW),
    { state: "fresh", checkedAtMs: Date.parse("2026-08-01T09:40:00.000Z") },
  );
  assert.deepEqual(
    freshness.classifyFreshnessArtifact(artifact("2026-08-01T09:39:59.999Z"), NOW),
    { state: "stale", checkedAtMs: Date.parse("2026-08-01T09:39:59.999Z") },
  );
});

test("fails closed for missing, malformed, and future-dated artifacts", () => {
  assert.equal(freshness.MAX_FUTURE_SKEW_MS, 5 * 60 * 1000);
  for (const payload of [{}, { checkedAt: 0 }, artifact("not-a-date"), artifact("2026-08-01T10:05:00.001Z")]) {
    assert.deepEqual(
      freshness.classifyFreshnessArtifact(payload, NOW),
      { state: "invalid", checkedAtMs: null },
    );
  }
});

test("keeps the warning visible unless the artifact is fresh", () => {
  const element = createElement();

  freshness.renderFreshness(element, { state: "stale", checkedAtMs: NOW - 1 });
  assert.equal(element.hidden, false);
  assert.equal(element.dataset.state, "stale");
  assert.equal(element.textContent, "Status checks are delayed. Current service state may be stale.");

  freshness.renderFreshness(element, { state: "fresh", checkedAtMs: NOW });
  assert.equal(element.hidden, true);
  assert.equal(element.dataset.state, "fresh");
});

test("fetches the same-origin generated artifact without calling the GitHub API", async () => {
  assert.equal(freshness.FRESHNESS_URL, "/monitor-freshness.json");
  const element = createElement();
  const requests = [];
  const result = await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => element },
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, json: async () => artifact() };
    },
    storageRef: createStorage(),
    cacheState: {},
    nowMs: NOW,
  });

  assert.deepEqual(result, {
    state: "fresh",
    checkedAtMs: Date.parse("2026-08-01T09:40:00.000Z"),
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0][0],
    `/monitor-freshness.json?v=${Math.floor(NOW / freshness.CACHE_TTL_MS)}`,
  );
  assert.equal(requests[0][1].cache, "default");
  assert.ok(requests[0][1].signal instanceof AbortSignal);
  assert.doesNotMatch(requests[0][0], /api\.github\.com|raw\.githubusercontent\.com/);
});

test("shares a five-minute cache across page views and bounds artifact requests", async () => {
  assert.equal(freshness.CACHE_TTL_MS, 5 * 60 * 1000);
  const storageRef = createStorage();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => artifact("2026-08-01T09:50:00.000Z") };
  };

  await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => createElement() },
    fetchImpl,
    storageRef,
    cacheState: {},
    nowMs: NOW,
  });
  const cached = await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => createElement() },
    fetchImpl,
    storageRef,
    cacheState: {},
    nowMs: NOW + freshness.CACHE_TTL_MS - 1,
  });

  assert.equal(fetchCalls, 1);
  assert.equal(cached.state, "fresh");
});

test("reclassifies cached freshness into stale without another request", async () => {
  const storageRef = createStorage();
  const element = createElement();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => artifact("2026-08-01T09:40:01.000Z") };
  };

  await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => element },
    fetchImpl,
    storageRef,
    cacheState: {},
    nowMs: NOW,
  });
  const stale = await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => element },
    fetchImpl,
    storageRef,
    cacheState: {},
    nowMs: NOW + 60_001,
  });

  assert.equal(fetchCalls, 1);
  assert.equal(stale.state, "stale");
  assert.equal(element.hidden, false);
});

test("keeps recent cached freshness on refresh failure, then fails closed by age", async () => {
  const storageRef = createStorage();
  const element = createElement();
  let fetchCalls = 0;

  await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => element },
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => artifact("2026-08-01T09:46:00.000Z") };
    },
    storageRef,
    cacheState: {},
    nowMs: NOW,
  });
  const duringFailure = await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => element },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Pages unavailable");
    },
    storageRef,
    cacheState: {},
    nowMs: NOW + freshness.CACHE_TTL_MS,
  });
  const afterAgeLimit = await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => element },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must remain throttled");
    },
    storageRef,
    cacheState: {},
    nowMs: NOW + freshness.CACHE_TTL_MS + 2 * 60 * 1000,
  });

  assert.equal(fetchCalls, 2);
  assert.equal(duringFailure.state, "fresh");
  assert.equal(afterAgeLimit.state, "stale");
  assert.equal(element.hidden, false);
});

test("negative-caches HTTP, JSON, and fetch failures", async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new Error("bad JSON"); } }),
    async () => { throw new Error("network failure"); },
  ]) {
    const storageRef = createStorage();
    const element = createElement();
    let calls = 0;
    const countedFetch = async (...args) => {
      calls += 1;
      return fetchImpl(...args);
    };
    const options = {
      documentRef: { getElementById: () => element },
      fetchImpl: countedFetch,
      storageRef,
      cacheState: {},
    };

    const first = await freshness.refreshMonitorFreshness({ ...options, nowMs: NOW });
    const second = await freshness.refreshMonitorFreshness({
      ...options,
      cacheState: {},
      nowMs: NOW + 60 * 1000,
    });

    assert.equal(calls, 1);
    assert.deepEqual(first, { state: "invalid", checkedAtMs: null });
    assert.deepEqual(second, { state: "invalid", checkedAtMs: null });
    assert.equal(element.hidden, false);
  }
});

test("aborts a hanging artifact request at the configured timeout and fails closed", async () => {
  const element = createElement();
  const timeoutDelays = [];
  const clearedTimeouts = [];
  let requestSignal = null;

  const result = await freshness.refreshMonitorFreshness({
    documentRef: { getElementById: () => element },
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      if (requestSignal.aborted) throw new DOMException("aborted", "AbortError");
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
    setTimeoutImpl: (callback, delay) => {
      timeoutDelays.push(delay);
      queueMicrotask(callback);
      return 41;
    },
    clearTimeoutImpl: (id) => clearedTimeouts.push(id),
    storageRef: createStorage(),
    cacheState: {},
    nowMs: NOW,
  });

  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(timeoutDelays, [freshness.FETCH_TIMEOUT_MS]);
  assert.deepEqual(clearedTimeouts, [41]);
  assert.deepEqual(result, { state: "invalid", checkedAtMs: null });
  assert.equal(element.hidden, false);
  assert.equal(element.dataset.state, "invalid");
});

test("contains storage failures with an in-page cache", async () => {
  const storageRef = {
    getItem: () => { throw new Error("storage blocked"); },
    setItem: () => { throw new Error("storage blocked"); },
  };
  const cacheState = {};
  let fetchCalls = 0;
  const options = {
    documentRef: { getElementById: () => createElement() },
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => artifact("2026-08-01T09:50:00.000Z") };
    },
    storageRef,
    cacheState,
  };

  await freshness.refreshMonitorFreshness({ ...options, nowMs: NOW });
  await freshness.refreshMonitorFreshness({ ...options, nowMs: NOW + 60 * 1000 });
  assert.equal(fetchCalls, 1);
});

test("installs one minute recheck timer and cleans it up", async () => {
  assert.ok(freshness.RECHECK_INTERVAL_MS <= 60 * 1000);
  const element = createElement();
  const intervals = [];
  const cleared = [];
  let nowMs = NOW;
  let fetchCalls = 0;
  const windowRef = {
    document: { readyState: "complete", getElementById: () => element },
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => artifact("2026-08-01T09:50:00.000Z") };
    },
    localStorage: createStorage(),
    setInterval: (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    clearInterval: (id) => cleared.push(id),
  };

  const cleanup = freshness.install(windowRef, { now: () => nowMs });
  const duplicateCleanup = freshness.install(windowRef, { now: () => nowMs });
  await flushAsyncWork();
  assert.equal(cleanup, duplicateCleanup);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, freshness.RECHECK_INTERVAL_MS);
  assert.equal(fetchCalls, 1);

  nowMs += freshness.RECHECK_INTERVAL_MS;
  intervals[0].callback();
  await flushAsyncWork();
  assert.equal(fetchCalls, 1);

  cleanup();
  assert.deepEqual(cleared, [1]);
  const replacementCleanup = freshness.install(windowRef, { now: () => nowMs });
  assert.notEqual(replacementCleanup, cleanup);
  assert.equal(intervals.length, 2);
  replacementCleanup();
});
