import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const siteWorkflow = read(".github/workflows/site.yml");
const setupWorkflow = read(".github/workflows/setup.yml");
const uptimeWorkflow = read(".github/workflows/uptime.yml");
const config = read(".upptimerc.yml");
const policy = read("scripts/check-policy.rb");
const runtime = read("assets/status-freshness.js");

test("site writers use the reviewed status-page checkout and locked install", () => {
  for (const workflow of [siteWorkflow, setupWorkflow]) {
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
