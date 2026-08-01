import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const siteWorkflow = read(".github/workflows/site.yml");
const setupWorkflow = read(".github/workflows/setup.yml");
const uptimeWorkflow = read(".github/workflows/uptime.yml");
const config = read(".upptimerc.yml");
const policy = read("scripts/check-policy.rb");
const runtime = read("assets/status-freshness.js");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function workflowRunBody(workflow, stepName) {
  const stepStart = workflow.indexOf(`- name: ${stepName}`);
  assert.ok(stepStart >= 0, `${stepName} step is missing`);
  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.ok(runStart >= 0, `${stepName} has no multiline run body`);
  const bodyStart = runStart + runMarker.length;
  const nextStep = workflow.indexOf("\n      - ", bodyStart);
  return workflow
    .slice(bodyStart, nextStep === -1 ? undefined : nextStep)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function createFreshnessPreservationFixture(context) {
  const sandbox = mkdtempSync(join(tmpdir(), "pulse-status-preserve-freshness-"));
  context.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const site = join(sandbox, "site");
  const output = join(site, "__sapper__", "export", "monitor-freshness.json");
  const fixture = join(sandbox, "remote-monitor-freshness.json");
  const bin = join(sandbox, "bin");
  mkdirSync(join(site, "__sapper__", "export"), { recursive: true });
  mkdirSync(bin);
  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
set -euo pipefail
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "\${FAKE_CURL_STATUS:-0}" != "0" ]; then exit "$FAKE_CURL_STATUS"; fi
cp "$FRESHNESS_FIXTURE" "$output"
`);
  chmodSync(curl, 0o755);

  return {
    output,
    async run(remotePayload) {
      writeFileSync(output, '{"checkedAt":null}\n');
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FRESHNESS_FIXTURE: fixture,
      };
      if (remotePayload === undefined) env.FAKE_CURL_STATUS = "22";
      else writeFileSync(fixture, remotePayload);
      run("bash", [
        fileURLToPath(new URL("scripts/preserve-monitor-freshness.sh", root)),
        "https://raw.githubusercontent.com/blockvantage/pulse-status/gh-pages/monitor-freshness.json",
        output,
      ], { cwd: site, env });
      return readFileSync(output, "utf8");
    },
  };
}

test("site writer keeps both repository checkouts credential-free", () => {
  for (const workflow of [siteWorkflow]) {
    const checkoutStarts = [...workflow.matchAll(/^\s*uses:\s*actions\/checkout@[^\n]+$/gm)]
      .map((match) => match.index);
    assert.equal(checkoutStarts.length, 2);
    for (const [index, start] of checkoutStarts.entries()) {
      const nextStep = workflow.indexOf("\n      - ", start);
      const checkout = workflow.slice(start, nextStep === -1 ? undefined : nextStep);
      assert.match(checkout, /^\s*persist-credentials:\s*false\s*$/m, `checkout ${index + 1}`);
    }
    assert.match(workflow, /repository:\s*upptime\/status-page/);
    assert.match(workflow, /ref:\s*54c2ff5a3d998d525ee4c7e68dc7ce7414d89c33/);
    assert.match(workflow, /path:\s*site/);
    assert.match(workflow, /working-directory:\s*site[\s\S]*run:\s*npm ci/);
    assert.match(workflow, /working-directory:\s*site[\s\S]*npm run export/);
    assert.match(workflow, /publish_dir:\s*["']?site\/__sapper__\/export\//);
    assert.doesNotMatch(workflow, /command:\s*["']site["']/);
    assert.doesNotMatch(workflow, /npm install|npm i\s/);
    assert.match(workflow, /if:\s*github\.ref == 'refs\/heads\/main'/);
  }
  assert.doesNotMatch(config, /^customStatusWebsitePackage:/m);
});

test("site builds preserve freshness after export and before credentialed deploy", () => {
  for (const workflow of [siteWorkflow, setupWorkflow]) {
    const generate = workflow.indexOf("- name: Generate site");
    const preserve = workflow.indexOf("- name: Preserve valid monitor freshness");
    const deploy = workflow.indexOf("- uses: peaceiris/actions-gh-pages@");
    assert.ok(generate >= 0 && generate < preserve && preserve < deploy);

    const preservationStep = workflow.slice(preserve, deploy);
    assert.match(preservationStep, /https:\/\/raw\.githubusercontent\.com/);
    assert.match(preservationStep, /\.\.\/scripts\/preserve-monitor-freshness\.sh/);
    assert.doesNotMatch(
      preservationStep,
      /GH_PAT|GITHUB_TOKEN|github\.token|authorization:/i,
    );
  }
});

test("shared site builder preserves a canonical public gh-pages freshness artifact", async (context) => {
  const fixture = createFreshnessPreservationFixture(context);
  const output = await fixture.run('{"checkedAt":"2026-08-01T15:31:41Z"}\n');
  assert.deepEqual(JSON.parse(output), { checkedAt: "2026-08-01T15:31:41Z" });
});

test("shared site builder retains the fail-closed seed for missing or invalid freshness", async (context) => {
  const fixture = createFreshnessPreservationFixture(context);
  const invalidArtifacts = [
    undefined,
    "not json\n",
    "null\n",
    '{}\n',
    '{"checkedAt":null}\n',
    '{"checkedAt":"not-a-date"}\n',
    '{"checkedAt":"0"}\n',
    '{"checkedAt":"2026-02-30T00:00:00Z"}\n',
    '{"checkedAt":"2026-08-01"}\n',
    '{"checkedAt":"Sat, 01 Aug 2026 15:31:41 GMT"}\n',
    '{"checkedAt":"2026-08-01T15:31:41.000Z"}\n',
    '{"checkedAt":"2026-08-01T12:31:41-03:00"}\n',
    '{"checkedAt":"2026-08-01T25:31:41Z"}\n',
    '{"checkedAt":"2999-01-01T00:00:00Z"}\n',
  ];
  for (const artifact of invalidArtifacts) {
    assert.deepEqual(JSON.parse(await fixture.run(artifact)), { checkedAt: null });
  }
});

test("setup scrubs its trusted write credential before running the status generator", () => {
  const checkoutStarts = [...setupWorkflow.matchAll(/^\s*uses:\s*actions\/checkout@[^\n]+$/gm)]
    .map((match) => match.index);
  assert.equal(checkoutStarts.length, 2);

  const trustedCheckout = setupWorkflow.slice(
    checkoutStarts[0],
    setupWorkflow.indexOf("\n      - ", checkoutStarts[0]),
  );
  const generatorCheckout = setupWorkflow.slice(
    checkoutStarts[1],
    setupWorkflow.indexOf("\n      - ", checkoutStarts[1]),
  );
  assert.match(trustedCheckout, /^\s*persist-credentials:\s*true\s*$/m);
  assert.match(generatorCheckout, /^\s*persist-credentials:\s*false\s*$/m);

  const responseTime = setupWorkflow.indexOf("- name: Update response time");
  const summary = setupWorkflow.indexOf("- name: Update summary in README");
  const graphs = setupWorkflow.indexOf("- name: Generate graphs");
  const scrub = setupWorkflow.indexOf("- name: Scrub trusted checkout credential");
  const generator = setupWorkflow.indexOf("- name: Check out pinned status generator");
  const install = setupWorkflow.indexOf("- name: Install locked status generator");
  const exportSite = setupWorkflow.indexOf("- name: Generate site");
  const deploy = setupWorkflow.indexOf("- uses: peaceiris/actions-gh-pages@");
  assert.ok(responseTime < summary && summary < graphs && graphs < scrub);
  assert.ok(scrub < generator && generator < install && install < exportSite);

  const scrubStep = setupWorkflow.slice(scrub, generator);
  assert.match(scrubStep, /http\.https:\/\/github\.com\/\.extraheader/);
  assert.ok(scrubStep.includes("includeif\\.[^[:space:]]*\\.path"));
  assert.match(scrubStep, /git-credentials-\*/);
  assert.match(scrubStep, /RUNNER_TEMP/);

  const generatorBoundary = setupWorkflow.slice(generator, deploy);
  assert.doesNotMatch(generatorBoundary, /GH_PAT|GITHUB_TOKEN|github\.token/);
});

test("setup credential scrub removes checkout-v6 auth and preserves unrelated includes", (context) => {
  const sandbox = mkdtempSync(join(tmpdir(), "pulse-status-credential-scrub-"));
  context.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const repository = join(sandbox, "repository");
  const runnerTemp = join(sandbox, "runner-temp");
  mkdirSync(repository);
  mkdirSync(runnerTemp);
  run("git", ["init", "-q", repository]);

  const credentialFile = join(runnerTemp, "git-credentials-contract.config");
  run("git", [
    "config", "-f", credentialFile,
    "http.https://github.com/.extraheader", "AUTHORIZATION: basic test-only",
  ]);
  const credentialName = credentialFile.slice(credentialFile.lastIndexOf("/") + 1);
  const includes = [
    [`includeIf.gitdir:${repository}/.git.path`, credentialFile],
    [`includeIf.gitdir:${repository}/.git/worktrees/*.path`, credentialFile],
    ["includeIf.gitdir:/github/workspace/.git.path", `/github/runner_temp/${credentialName}`],
    ["includeIf.gitdir:/github/workspace/.git/worktrees/*.path", `/github/runner_temp/${credentialName}`],
  ];
  for (const [key, value] of includes) {
    run("git", ["config", "--local", key, value], { cwd: repository });
  }
  const sameKeyUnrelatedValue = "/tmp/same-key-unrelated.config";
  run("git", [
    "config", "--local", "--add", includes[0][0], sameKeyUnrelatedValue,
  ], { cwd: repository });
  const unrelatedKey = "includeIf.gitdir:/tmp/unrelated/.path";
  const unrelatedValue = "/tmp/unrelated.config";
  run("git", ["config", "--local", unrelatedKey, unrelatedValue], { cwd: repository });

  run("bash", ["-euo", "pipefail", "-c", workflowRunBody(
    setupWorkflow,
    "Scrub trusted checkout credential",
  )], {
    cwd: repository,
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
  });

  assert.equal(existsSync(credentialFile), false);
  const remainingIncludes = run(
    "git",
    ["config", "--local", "--get-regexp", "^includeif\\..*\\.path$"],
    { cwd: repository },
  );
  assert.deepEqual(remainingIncludes.split("\n").sort(), [
    `${includes[0][0].replace(/^includeIf/, "includeif")} ${sameKeyUnrelatedValue}`,
    `${unrelatedKey.toLowerCase()} ${unrelatedValue}`,
  ].sort());
});

test("only successful scheduled uptime runs publish the generated freshness artifact", () => {
  const publisherStart = uptimeWorkflow.indexOf("- name: Publish monitor freshness");
  assert.ok(publisherStart >= 0);
  const publisher = uptimeWorkflow.slice(publisherStart);

  assert.match(uptimeWorkflow, /^\s*actions:\s*read\s*$/m);
  assert.match(publisher, /if:\s*github\.event_name == 'schedule'/);
  assert.match(publisher, /monitor-freshness\.json/);
  assert.match(publisher, /refs\/remotes\/origin\/\$\{GH_PAGES_BRANCH\}/);
  assert.match(publisher, /commit --amend/);
  assert.match(publisher, /push[\s\\]+--force-with-lease/);
  assert.match(
    publisher,
    /\$GITHUB_API_URL\/repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID/,
  );
  assert.match(publisher, /\.created_at/);
  assert.doesNotMatch(publisher, /date\s+-u/);
  assert.doesNotMatch(runtime, /api\.github\.com|raw\.githubusercontent\.com/);
  assert.equal(JSON.parse(read("assets/monitor-freshness.json")).checkedAt, null);
});

test("policy rejects alternate workflow extensions that GitHub would execute", () => {
  assert.match(policy, /\*\.yaml/);
  assert.match(policy, /unsupported.*\.yaml|\.yaml.*unsupported/i);
});
