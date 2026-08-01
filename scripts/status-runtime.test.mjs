import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

let freshness = {};
try {
  freshness = require("../assets/status-freshness.js");
} catch {}

const NOW = Date.parse("2026-08-01T10:00:00.000Z");

function scheduledRun(createdAt = "2026-08-01T09:40:00.000Z") {
  return {
    workflow_runs: [{
      event: "schedule",
      status: "completed",
      conclusion: "success",
      created_at: createdAt,
      run_started_at: createdAt,
      updated_at: createdAt,
    }],
  };
}

test("classifies a recent successful scheduled run as fresh within a fixed bounded window", () => {
  assert.equal(typeof freshness.classifyWorkflowRuns, "function");
  assert.equal(freshness.STALE_AFTER_MS, 20 * 60 * 1000);
  assert.deepEqual(
    freshness.classifyWorkflowRuns(scheduledRun(), NOW),
    { state: "fresh", createdAtMs: Date.parse("2026-08-01T09:40:00.000Z") },
  );
});

test("classifies an old successful scheduled run as stale", () => {
  assert.equal(typeof freshness.classifyWorkflowRuns, "function");
  assert.deepEqual(
    freshness.classifyWorkflowRuns(scheduledRun("2026-08-01T09:39:59.999Z"), NOW),
    { state: "stale", createdAtMs: Date.parse("2026-08-01T09:39:59.999Z") },
  );
});

test("keeps an old scheduled event stale after a recent manual rerun", () => {
  assert.equal(typeof freshness.classifyWorkflowRuns, "function");
  const payload = scheduledRun("2026-08-01T09:00:00.000Z");
  payload.workflow_runs[0].run_started_at = "2026-08-01T09:59:30.000Z";
  payload.workflow_runs[0].updated_at = "2026-08-01T10:00:00.000Z";

  assert.deepEqual(
    freshness.classifyWorkflowRuns(payload, NOW),
    { state: "stale", createdAtMs: Date.parse("2026-08-01T09:00:00.000Z") },
  );
});

test("fails closed for malformed and implausibly future-dated workflow runs", () => {
  assert.equal(typeof freshness.classifyWorkflowRuns, "function");
  assert.equal(freshness.MAX_FUTURE_SKEW_MS, 5 * 60 * 1000);
  assert.deepEqual(freshness.classifyWorkflowRuns({}, NOW), { state: "invalid", createdAtMs: null });

  const nonStringTimestamp = scheduledRun();
  nonStringTimestamp.workflow_runs[0].created_at = 0;
  assert.deepEqual(
    freshness.classifyWorkflowRuns(nonStringTimestamp, NOW),
    { state: "invalid", createdAtMs: null },
  );

  const missingStart = scheduledRun();
  delete missingStart.workflow_runs[0].run_started_at;
  assert.deepEqual(
    freshness.classifyWorkflowRuns(missingStart, NOW),
    { state: "invalid", createdAtMs: null },
  );

  const updatedBeforeStart = scheduledRun();
  updatedBeforeStart.workflow_runs[0].updated_at = "2026-08-01T09:39:00.000Z";
  assert.deepEqual(
    freshness.classifyWorkflowRuns(updatedBeforeStart, NOW),
    { state: "invalid", createdAtMs: null },
  );

  const futureRun = scheduledRun("2026-08-01T10:05:00.001Z");
  assert.deepEqual(
    freshness.classifyWorkflowRuns(futureRun, NOW),
    { state: "invalid", createdAtMs: null },
  );
});

test("rejects a manual run even if it is recent and successful", () => {
  assert.equal(typeof freshness.classifyWorkflowRuns, "function");
  const payload = scheduledRun();
  payload.workflow_runs[0].event = "workflow_dispatch";

  assert.deepEqual(
    freshness.classifyWorkflowRuns(payload, NOW),
    { state: "invalid", createdAtMs: null },
  );
});

test("keeps the warning visible for stale data and hides it only for fresh data", () => {
  assert.equal(typeof freshness.renderFreshness, "function");
  const element = { dataset: {}, hidden: false, textContent: "Initial warning" };

  freshness.renderFreshness(element, { state: "stale", createdAtMs: NOW - 1 });
  assert.equal(element.hidden, false);
  assert.equal(element.dataset.state, "stale");
  assert.equal(element.textContent, "Status checks are delayed. Current service state may be stale.");

  freshness.renderFreshness(element, { state: "fresh", createdAtMs: NOW });
  assert.equal(element.hidden, true);
  assert.equal(element.dataset.state, "fresh");
});

test("keeps the warning visible when the workflow-runs request fails", async () => {
  assert.equal(typeof freshness.refreshMonitorFreshness, "function");
  const element = { dataset: {}, hidden: false, textContent: "Initial warning" };
  const documentRef = { getElementById: () => element };

  const result = await freshness.refreshMonitorFreshness({
    documentRef,
    fetchImpl: async () => { throw new Error("private upstream detail"); },
    nowMs: NOW,
  });

  assert.deepEqual(result, { state: "invalid", createdAtMs: null });
  assert.equal(element.hidden, false);
  assert.equal(element.dataset.state, "invalid");
  assert.equal(element.textContent, "Status checks are delayed. Current service state may be stale.");
  assert.doesNotMatch(element.textContent, /private upstream detail/);
});

test("queries only successful scheduled Uptime runs and hides the warning when fresh", async () => {
  assert.equal(typeof freshness.refreshMonitorFreshness, "function");
  const element = { dataset: {}, hidden: false, textContent: "Initial warning" };
  const documentRef = { getElementById: () => element };
  const requests = [];

  const result = await freshness.refreshMonitorFreshness({
    documentRef,
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, json: async () => scheduledRun() };
    },
    nowMs: NOW,
  });

  assert.deepEqual(result, {
    state: "fresh",
    createdAtMs: Date.parse("2026-08-01T09:40:00.000Z"),
  });
  assert.equal(element.hidden, true);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0][0],
    "https://api.github.com/repos/blockvantage/pulse-status/actions/workflows/uptime.yml/runs?event=schedule&status=success&per_page=1",
  );
  assert.equal(requests[0][1].cache, "no-store");
  assert.ok(requests[0][1].signal instanceof AbortSignal);
});
