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
  "default-site" => [%r{https://blockvantage\.github\.io/pulse-status/}, /HTTP 200/, /Do not continue on a redirect or error/i],
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
