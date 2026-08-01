(function initializeStatusFreshness(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window === "undefined" ? null : window, function createStatusFreshness() {
  "use strict";

  const STALE_AFTER_MS = 20 * 60 * 1000;
  const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 5 * 1000;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const RECHECK_INTERVAL_MS = 60 * 1000;
  const CACHE_KEY = "pulse-status:monitor-freshness:v1";
  const INSTALL_KEY = "__pulseStatusFreshnessCleanup";
  const FRESHNESS_URL = "/monitor-freshness.json";
  const WARNING = "Status checks are delayed. Current service state may be stale.";

  function invalidResult() {
    return { state: "invalid", checkedAtMs: null };
  }

  function classifyCheckedAt(checkedAtMs, nowMs) {
    if (
      !Number.isFinite(checkedAtMs) ||
      !Number.isFinite(nowMs) ||
      checkedAtMs > nowMs + MAX_FUTURE_SKEW_MS
    ) {
      return invalidResult();
    }

    return {
      state: nowMs - checkedAtMs <= STALE_AFTER_MS ? "fresh" : "stale",
      checkedAtMs,
    };
  }

  function classifyFreshnessArtifact(payload, nowMs) {
    if (!payload || typeof payload.checkedAt !== "string") return invalidResult();
    return classifyCheckedAt(Date.parse(payload.checkedAt), nowMs);
  }

  function renderFreshness(element, result) {
    if (!element) return;
    element.dataset.state = result.state;
    element.hidden = result.state === "fresh";
    if (result.state !== "fresh") element.textContent = WARNING;
  }

  function normalizeCacheRecord(record, nowMs) {
    if (
      !record ||
      record.version !== 1 ||
      !Number.isFinite(record.attemptedAtMs) ||
      record.attemptedAtMs < 0 ||
      record.attemptedAtMs > nowMs + MAX_FUTURE_SKEW_MS ||
      (record.checkedAtMs !== null && !Number.isFinite(record.checkedAtMs))
    ) {
      return null;
    }
    return record;
  }

  function readCache(storageRef, cacheState, nowMs) {
    let record = null;
    try {
      const stored = storageRef && storageRef.getItem(CACHE_KEY);
      if (stored) record = normalizeCacheRecord(JSON.parse(stored), nowMs);
    } catch (_) {
      record = null;
    }

    if (!record) record = normalizeCacheRecord(cacheState.record, nowMs);
    if (record) cacheState.record = record;
    return record;
  }

  function writeCache(storageRef, cacheState, record) {
    cacheState.record = record;
    try {
      if (storageRef) storageRef.setItem(CACHE_KEY, JSON.stringify(record));
    } catch (_) {
      // The in-page cache still bounds requests when browser storage is blocked.
    }
  }

  function classifyCacheRecord(record, nowMs) {
    return record && record.checkedAtMs !== null
      ? classifyCheckedAt(record.checkedAtMs, nowMs)
      : invalidResult();
  }

  async function refreshMonitorFreshness(options) {
    const settings = options || {};
    const documentRef = settings.documentRef || document;
    const fetchImpl = settings.fetchImpl || fetch;
    const setTimeoutImpl = settings.setTimeoutImpl || setTimeout;
    const clearTimeoutImpl = settings.clearTimeoutImpl || clearTimeout;
    const nowMs = Number.isFinite(settings.nowMs) ? settings.nowMs : Date.now();
    const cacheState = settings.cacheState || {};
    let storageRef = settings.storageRef;
    if (!("storageRef" in settings)) {
      try {
        storageRef = typeof localStorage === "undefined" ? null : localStorage;
      } catch (_) {
        storageRef = null;
      }
    }
    const element = documentRef.getElementById("monitor-freshness");
    const cached = readCache(storageRef, cacheState, nowMs);
    if (cached && nowMs - cached.attemptedAtMs < CACHE_TTL_MS) {
      const cachedResult = classifyCacheRecord(cached, nowMs);
      renderFreshness(element, cachedResult);
      return cachedResult;
    }

    const claimed = {
      version: 1,
      attemptedAtMs: nowMs,
      checkedAtMs: cached ? cached.checkedAtMs : null,
    };
    writeCache(storageRef, cacheState, claimed);

    const controller = new AbortController();
    const timeout = setTimeoutImpl(function abortFreshnessFetch() {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    let result = classifyCacheRecord(claimed, nowMs);

    try {
      const requestUrl = `${FRESHNESS_URL}?v=${Math.floor(nowMs / CACHE_TTL_MS)}`;
      const response = await fetchImpl(requestUrl, {
        cache: "default",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("freshness artifact request failed");
      const fetched = classifyFreshnessArtifact(await response.json(), nowMs);
      if (fetched.state === "invalid") throw new Error("freshness artifact was invalid");
      result = fetched;
      writeCache(storageRef, cacheState, {
        version: 1,
        attemptedAtMs: nowMs,
        checkedAtMs: fetched.checkedAtMs,
      });
    } catch (_) {
      result = classifyCacheRecord(claimed, nowMs);
    } finally {
      clearTimeoutImpl(timeout);
    }

    renderFreshness(element, result);
    return result;
  }

  function install(windowRef, options) {
    if (windowRef[INSTALL_KEY]) return windowRef[INSTALL_KEY];

    const settings = options || {};
    const cacheState = {};
    let intervalId = null;
    let started = false;
    let disposed = false;
    let storageRef = null;
    try {
      storageRef = windowRef.localStorage;
    } catch (_) {
      storageRef = null;
    }

    const run = function runFreshnessCheck() {
      void refreshMonitorFreshness({
        documentRef: windowRef.document,
        fetchImpl: windowRef.fetch.bind(windowRef),
        storageRef,
        cacheState,
        nowMs: settings.now ? settings.now() : Date.now(),
      });
    };

    const start = function startFreshnessChecks() {
      if (started || disposed) return;
      started = true;
      run();
      intervalId = windowRef.setInterval(run, RECHECK_INTERVAL_MS);
    };

    const cleanup = function cleanupFreshnessChecks() {
      if (disposed) return;
      disposed = true;
      if (!started) {
        windowRef.document.removeEventListener("DOMContentLoaded", start);
      }
      if (intervalId !== null) windowRef.clearInterval(intervalId);
      if (windowRef[INSTALL_KEY] === cleanup) delete windowRef[INSTALL_KEY];
    };

    windowRef[INSTALL_KEY] = cleanup;

    if (windowRef.document.readyState === "loading") {
      windowRef.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    return cleanup;
  }

  return {
    CACHE_TTL_MS,
    FRESHNESS_URL,
    FETCH_TIMEOUT_MS,
    MAX_FUTURE_SKEW_MS,
    RECHECK_INTERVAL_MS,
    STALE_AFTER_MS,
    classifyFreshnessArtifact,
    install,
    refreshMonitorFreshness,
    renderFreshness,
  };
});
