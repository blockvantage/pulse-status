#!/usr/bin/env ruby

require "set"
require "yaml"

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
  "uptime.yml" => { "contents" => "write", "issues" => "write" }
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
end

failures << "used action set is #{used_actions.to_a.sort.inspect}" unless used_actions == PINNED_ACTIONS
failures << ".templaterc.json can replace reviewed workflows" if File.exist?(File.join(ROOT, ".templaterc.json"))

all_workflow_text = workflow_paths.map { |path| File.read(path) }.join("\n")
failures << "self-update behavior remains" if all_workflow_text.match?(/update[_-]template|command:\s*["']?update-template/i)
failures << "mutable action reference remains" if all_workflow_text.match?(/uses:\s*[^\s]+@(master|main|v?\d+(?:\.\d+){0,2})\b/)
failures << "workflow overwrite warning remains" if all_workflow_text.include?("will be overwritten")
failures << "GH_PAT fallback remains" if all_workflow_text.include?("secrets.GH_PAT")

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
normalized_readme = readme.gsub(/\s+/, " ")
required_domain_steps = [
  "Confirm the default GitHub Pages URL",
  "Verify `opsprint.ai` domain ownership",
  "DNS-only CNAME",
  "Wait for GitHub's DNS validation and TLS certificate",
  "Enable HTTPS enforcement last"
]
step_positions = required_domain_steps.map { |step| normalized_readme.index(step) }
failures << "custom-domain instructions are missing or out of order" unless step_positions.all? && step_positions == step_positions.sort
failures << "README does not declare the gh-pages source model" unless readme.include?("`gh-pages` branch at `/`")

if failures.any?
  warn failures.map { |failure| "FAIL: #{failure}" }.join("\n")
  exit 1
end

puts "status repository policy: PASS"
