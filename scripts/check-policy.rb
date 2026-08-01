#!/usr/bin/env ruby

require "set"
require "yaml"
require "json"

ROOT = File.expand_path("..", __dir__)
WORKFLOW_DIR = File.join(ROOT, ".github", "workflows")

EXPECTED_WORKFLOWS = %w[
  graphs.yml
  policy.yml
  response-time.yml
  setup.yml
  site.yml
  summary.yml
  uptime.yml
].freeze

PINNED_ACTIONS = Set.new(%w[
  actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803
  actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
  peaceiris/actions-gh-pages@84c30a85c19949d7eee79c4ff27748b70285e453
  upptime/uptime-monitor@6e7c186f842ae4040cf75956a00548426a1e42aa
]).freeze

EXPECTED_PERMISSIONS = {
  "graphs.yml" => { "contents" => "write" },
  "policy.yml" => { "contents" => "read" },
  "response-time.yml" => { "contents" => "write" },
  "setup.yml" => { "contents" => "write", "issues" => "read" },
  "site.yml" => { "contents" => "write" },
  "summary.yml" => { "contents" => "write", "issues" => "read" },
  "uptime.yml" => { "actions" => "read", "contents" => "write", "issues" => "write" }
}.freeze

EXPECTED_SCHEDULES = {
  "graphs.yml" => ["17 0 * * *"],
  "policy.yml" => [],
  "response-time.yml" => ["47 23 * * *"],
  "setup.yml" => [],
  "site.yml" => ["13 1 * * *"],
  "summary.yml" => ["37 0 * * *"],
  "uptime.yml" => ["*/5 * * * *"]
}.freeze

EXPECTED_TIMEOUTS = {
  "graphs.yml" => 15,
  "policy.yml" => 10,
  "response-time.yml" => 15,
  "setup.yml" => 45,
  "site.yml" => 30,
  "summary.yml" => 15,
  "uptime.yml" => 10
}.freeze

EXPECTED_CONCURRENCY = EXPECTED_WORKFLOWS.to_h do |file|
  group = if file == "policy.yml"
            "${{ github.repository }}-${{ github.ref_name }}-policy"
          else
            "${{ github.repository }}-upptime-writer"
          end
  [file, group]
end.freeze

failures = []

workflow_paths = Dir.glob(File.join(WORKFLOW_DIR, "*.yml")).sort
unsupported_workflow_paths = Dir.glob(File.join(WORKFLOW_DIR, "*.yaml")).sort
unless unsupported_workflow_paths.empty?
  failures << "unsupported .yaml workflows: #{unsupported_workflow_paths.map { |path| File.basename(path) }.inspect}"
end
workflow_names = workflow_paths.map { |path| File.basename(path) }
failures << "workflow set is #{workflow_names.inspect}" unless workflow_names == EXPECTED_WORKFLOWS

used_actions = Set.new
workflow_paths.each do |path|
  file = File.basename(path)
  text = File.read(path)
  yaml = YAML.safe_load(text, aliases: true)
  uses = text.scan(/^\s*-?\s*uses:\s*([^\s#]+)/).flatten
  used_actions.merge(uses)

  uses.each do |action|
    failures << "#{file}: unpinned or unapproved action #{action}" unless PINNED_ACTIONS.include?(action)
  end

  expected_permissions = EXPECTED_PERMISSIONS[file]
  failures << "#{file}: permissions are #{yaml["permissions"].inspect}" unless yaml["permissions"] == expected_permissions

  triggers = yaml["on"] || yaml[true] || {}
  schedules = Array(triggers["schedule"]).map { |entry| entry["cron"] }
  expected_schedules = EXPECTED_SCHEDULES[file]
  failures << "#{file}: schedules are #{schedules.inspect}" unless schedules == expected_schedules

  concurrency = yaml.dig("concurrency", "group")
  failures << "#{file}: concurrency is #{concurrency.inspect}" unless concurrency == EXPECTED_CONCURRENCY[file]

  timeout = yaml.dig("jobs", file == "policy.yml" ? "policy" : "release", "timeout-minutes")
  failures << "#{file}: timeout is #{timeout.inspect}" unless timeout == EXPECTED_TIMEOUTS[file]
end

failures << "used action set is #{used_actions.to_a.sort.inspect}" unless used_actions == PINNED_ACTIONS
failures << ".templaterc.json can replace reviewed workflows" if File.exist?(File.join(ROOT, ".templaterc.json"))

all_workflow_text = workflow_paths.map { |path| File.read(path) }.join("\n")
failures << "self-update behavior remains" if all_workflow_text.match?(/update[_-]template|command:\s*["']?update-template/i)
failures << "mutable action reference remains" if all_workflow_text.match?(/uses:\s*[^\s]+@(master|main|v?\d+(?:\.\d+){0,2})\b/)
failures << "workflow overwrite warning remains" if all_workflow_text.include?("will be overwritten")
failures << "GH_PAT fallback remains" if all_workflow_text.include?("secrets.GH_PAT")

config = YAML.safe_load(File.read(File.join(ROOT, ".upptimerc.yml")), aliases: true)
failures << "description mutation is not disabled" unless config["skipDescriptionUpdate"] == true
failures << "topics mutation is not disabled" unless config["skipTopicsUpdate"] == true
failures << "homepage mutation is not disabled" unless config["skipHomepageUpdate"] == true
failures << "mutable custom status website package override remains" if config.key?("customStatusWebsitePackage")

status_website = config["status-website"] || {}
custom_body = status_website["customBodyHtml"].to_s
scripts = Array(status_website["scripts"])
failures << "fail-closed freshness banner is missing" unless custom_body.include?('id="monitor-freshness"')
failures << "freshness banner is not an alert" unless custom_body.match?(/role=["']alert["']/)
unless scripts.any? { |script| script == { "src" => "/status-freshness.js?v=1", "async" => true } }
  failures << "status freshness runtime is not loaded from the generated site"
end

freshness_text = File.read(File.join(ROOT, "assets", "status-freshness.js"))
failures << "freshness runtime calls the GitHub API" if freshness_text.match?(/api\.github\.com|raw\.githubusercontent\.com/)
failures << "freshness runtime is not same-origin" unless freshness_text.include?('FRESHNESS_URL = "/monitor-freshness.json"')

seed = JSON.parse(File.read(File.join(ROOT, "assets", "monitor-freshness.json")))
failures << "freshness seed must fail closed" unless seed == { "checkedAt" => nil }

policy_text = File.read(File.join(WORKFLOW_DIR, "policy.yml"))
unless policy_text.include?("node --test scripts/*.test.mjs")
  failures << "policy workflow does not run status contract tests"
end

%w[site.yml setup.yml].each do |file|
  text = File.read(File.join(WORKFLOW_DIR, file))
  workflow = YAML.safe_load(text, aliases: true)
  checkout_steps = workflow.dig("jobs", "release", "steps").select do |step|
    step["uses"].to_s.start_with?("actions/checkout@")
  end
  failures << "#{file}: expected exactly two checkout steps" unless checkout_steps.length == 2
  expected_persistence = file == "setup.yml" ? [true, false] : [false, false]
  actual_persistence = checkout_steps.map { |step| step.dig("with", "persist-credentials") }
  unless actual_persistence == expected_persistence
    failures << "#{file}: checkout credential persistence is #{actual_persistence.inspect}"
  end
  triggers = workflow["on"] || workflow[true] || {}
  branches = triggers.dig("push", "branches")
  failures << "#{file}: writer push branches are #{branches.inspect}" unless branches == ["main"]
  job_if = workflow.dig("jobs", "release", "if").to_s
  failures << "#{file}: writer job is not main-only" unless job_if.include?("github.ref == 'refs/heads/main'")
  failures << "#{file}: pinned generator repository missing" unless text.include?("repository: upptime/status-page")
  unless text.include?("ref: 54c2ff5a3d998d525ee4c7e68dc7ce7414d89c33")
    failures << "#{file}: status generator commit is not pinned"
  end
  failures << "#{file}: locked npm install missing" unless text.match?(/working-directory:\s*site[\s\S]*run:\s*npm ci/)
  failures << "#{file}: mutable uptime-monitor site command remains" if text.match?(/command:\s*["']site["']/)
  failures << "#{file}: wrong publish directory" unless text.include?('publish_dir: "site/__sapper__/export/"')
end

setup_text = File.read(File.join(WORKFLOW_DIR, "setup.yml"))
setup_step_names = [
  "- name: Update response time",
  "- name: Update summary in README",
  "- name: Generate graphs",
  "- name: Scrub trusted checkout credential",
  "- name: Check out pinned status generator",
  "- name: Install locked status generator",
  "- name: Generate site",
]
setup_step_offsets = setup_step_names.map { |name| setup_text.index(name) }
unless setup_step_offsets.none?(&:nil?) && setup_step_offsets == setup_step_offsets.sort
  failures << "setup.yml: trusted writes, credential scrub, and generator boundary are out of order"
end
scrub_start = setup_text.index("- name: Scrub trusted checkout credential")
generator_start = setup_text.index("- name: Check out pinned status generator")
scrub_step = scrub_start && generator_start ? setup_text[scrub_start...generator_start] : ""
{
  "legacy extraheader removal" => "http.https://github.com/.extraheader",
  "checkout-v6 includeIf removal" => "includeif\\.[^[:space:]]*\\.path",
  "checkout-v6 credential-file removal" => "git-credentials-*",
  "exact includeIf value removal" => "--fixed-value --unset-all",
  "runner temp scoping" => "RUNNER_TEMP",
}.each do |contract, needle|
  failures << "setup.yml: credential scrub lacks #{contract}" unless scrub_step.include?(needle)
end

uptime_text = File.read(File.join(WORKFLOW_DIR, "uptime.yml"))
publisher_start = uptime_text.index("- name: Publish monitor freshness")
publisher = publisher_start ? uptime_text[publisher_start..] : ""
failures << "scheduled freshness publisher missing" if publisher.empty?
failures << "freshness publisher is not schedule-only" unless publisher.match?(/if:\s*github\.event_name == 'schedule'/)
failures << "freshness publisher does not amend gh-pages" unless publisher.include?("git -C \"$worktree\" commit --amend --no-edit")
failures << "freshness publisher lacks bounded force lease" unless publisher.include?("--force-with-lease=")
run_api_url = "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
failures << "freshness publisher does not authenticate the workflow-run lookup" unless publisher.include?(run_api_url)
failures << "freshness publisher does not use immutable run creation time" unless publisher.include?(".created_at")
failures << "freshness publisher derives freshness from wall-clock time" if publisher.match?(/date\s+-u/)

sample_pattern = %r{google|wikipedia|hacker-news|secret-site}
sample_paths = Dir.glob(File.join(ROOT, "{api,graphs,history}/**/*"), File::FNM_DOTMATCH)
  .select { |path| File.file?(path) && path.match?(sample_pattern) }
failures << "sample artifact paths remain: #{sample_paths.map { |path| path.delete_prefix("#{ROOT}/") }.inspect}" unless sample_paths.empty?

text_paths = Dir.glob(File.join(ROOT, "**", "*"), File::FNM_DOTMATCH)
  .select do |path|
    File.file?(path) && !path.include?("/.git/") && File.expand_path(path) != File.expand_path(__FILE__)
  end
sample_mentions = text_paths.each_with_object([]) do |path, mentions|
  content = File.binread(path)
  next unless content.valid_encoding? && content.match?(sample_pattern)

  mentions << path.delete_prefix("#{ROOT}/")
end
failures << "sample text remains: #{sample_mentions.inspect}" unless sample_mentions.empty?

readme = File.read(File.join(ROOT, "README.md"))
rollout_markers = %w[
  workflow-token
  static-site-ci
  generated-branch
  pages-source
  default-site
  org-ownership
  dns-cname
  custom-domain
  tls-certificate
  https-enforcement
  live-custom-domain
  gate-complete
]
marker_tokens = rollout_markers.map { |marker| "<!-- status-rollout:#{marker} -->" }
marker_counts = marker_tokens.to_h do |marker|
  [marker, readme.scan(Regexp.new(Regexp.escape(marker))).length]
end
markers_unique = marker_counts.values.all? { |count| count == 1 }
failures << "status rollout markers must each occur exactly once" unless markers_unique

marker_positions = markers_unique ? marker_tokens.map { |marker| readme.index(marker) } : []
markers_ordered = markers_unique && marker_positions == marker_positions.sort
unless !markers_unique || markers_ordered
  failures << "status rollout markers are out of order"
end

gate_requirements = {
  "workflow-token" => [/contents:\s*write/i, /GITHUB_TOKEN/, /No\s+broad\s+PAT/i],
  "static-site-ci" => [/Static Site CI/, /gh workflow run/, /gh run watch/],
  "generated-branch" => [/genuine\s+`gh-pages`\s+branch/i, /403/, /missing branch is a no-go/i],
  "pages-source" => [/Deploy from a branch/i, /select\s+`gh-pages`\s+and\s+the\s+`\/`\s+root/i],
  "default-site" => [/git archive\s+origin\/gh-pages/i, %r{http://127\.0\.0\.1:4173/}, /HTTP 200/i, /monitor-freshness\.json/],
  "org-ownership" => [/verify ownership of\s+`opsprint\.ai`/i, /before claiming any custom hostname/i],
  "dns-cname" => [/DNS-only CNAME/i, /blockvantage\.github\.io/, /Do not proxy.*Cloudflare/i],
  "custom-domain" => [/Add\s+`status\.opsprint\.ai`.*Pages custom domain/i],
  "tls-certificate" => [/Wait for GitHub's DNS validation and TLS certificate/i, /before\s+changing transport settings/i],
  "https-enforcement" => [/Enable HTTPS enforcement last/i, /certificate is\s+available/i],
  "live-custom-domain" => [/all four checks.*healthy/i, %r{https://status\.opsprint\.ai}, /HTTP 200/, /Cloudflare 525/],
  "gate-complete" => [/Do not mark.*gate complete/i, /repository sync/, /workflow publication/, /Pages/, /DNS/, /TLS/, /live HTTP checks/]
}

if markers_ordered
  rollout_markers.each_with_index do |marker, index|
    section_start = marker_positions[index]
    section_end = marker_positions[index + 1] || readme.length
    section = readme[section_start...section_end].gsub(/\s+/, " ")
    missing = gate_requirements.fetch(marker).reject { |requirement| section.match?(requirement) }
    failures << "#{marker} rollout gate is missing required semantics" unless missing.empty?
  end
end

if failures.any?
  warn failures.map { |failure| "FAIL: #{failure}" }.join("\n")
  exit 1
end

puts "status repository policy: PASS"
