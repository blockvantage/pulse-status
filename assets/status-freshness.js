(function initializeStatusFreshness(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window === "undefined" ? null : window, function createStatusFreshness() {
  "use strict";

  const STALE_AFTER_MS = 20 * 60 * 1000;
  const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 5 * 1000;
  const WORKFLOW_RUNS_URL =
    "https://api.github.com/repos/blockvantage/pulse-status/actions/workflows/uptime.yml/runs?event=schedule&status=success&per_page=1";
  const WARNING = "Status checks are delayed. Current service state may be stale.";

  function classifyWorkflowRuns(payload, nowMs) {
    const run = payload && Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs[0]
      : null;
    if (
      !run ||
      run.event !== "schedule" ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      typeof run.created_at !== "string" ||
      typeof run.run_started_at !== "string" ||
      typeof run.updated_at !== "string" ||
      !Number.isFinite(nowMs)
    ) {
      return { state: "invalid", createdAtMs: null };
    }

    const createdAtMs = Date.parse(run.created_at);
    const startedAtMs = Date.parse(run.run_started_at);
    const updatedAtMs = Date.parse(run.updated_at);
    if (
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(startedAtMs) ||
      !Number.isFinite(updatedAtMs) ||
      startedAtMs < createdAtMs ||
      updatedAtMs < startedAtMs ||
      updatedAtMs > nowMs + MAX_FUTURE_SKEW_MS
    ) {
      return { state: "invalid", createdAtMs: null };
    }

    return {
      state: nowMs - createdAtMs <= STALE_AFTER_MS ? "fresh" : "stale",
      createdAtMs,
    };
  }

  function renderFreshness(element, result) {
    if (!element) return;
    element.dataset.state = result.state;
    element.hidden = result.state === "fresh";
    if (result.state !== "fresh") element.textContent = WARNING;
  }

  async function refreshMonitorFreshness(options) {
    const settings = options || {};
    const documentRef = settings.documentRef || document;
    const fetchImpl = settings.fetchImpl || fetch;
    const nowMs = Number.isFinite(settings.nowMs) ? settings.nowMs : Date.now();
    const element = documentRef.getElementById("monitor-freshness");
    const controller = new AbortController();
    const timeout = setTimeout(function abortWorkflowRunsFetch() {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    let result = { state: "invalid", createdAtMs: null };

    try {
      const response = await fetchImpl(WORKFLOW_RUNS_URL, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.ok) result = classifyWorkflowRuns(await response.json(), nowMs);
    } catch (_) {
      result = { state: "invalid", createdAtMs: null };
    } finally {
      clearTimeout(timeout);
    }

    renderFreshness(element, result);
    return result;
  }

  function install(windowRef) {
    const run = function runFreshnessCheck() {
      void refreshMonitorFreshness({
        documentRef: windowRef.document,
        fetchImpl: windowRef.fetch.bind(windowRef),
      });
    };

    if (windowRef.document.readyState === "loading") {
      windowRef.document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
  }

  return {
    FETCH_TIMEOUT_MS,
    MAX_FUTURE_SKEW_MS,
    STALE_AFTER_MS,
    WORKFLOW_RUNS_URL,
    classifyWorkflowRuns,
    install,
    refreshMonitorFreshness,
    renderFreshness,
  };
});
