# Pulse Public Status

This directory is the source configuration for the public Upptime site at
`https://status.opsprint.ai`. It monitors four distinct Pulse surfaces every
five minutes:

- `https://pulse.opsprint.ai/`
- `https://pulse.opsprint.ai/api/health`
- `https://pulse.opsprint.ai/api/health/ready`
- `https://pulse.opsprint.ai/login`

The shallow health endpoint proves the web process is alive. Readiness also
checks PostgreSQL, private object storage, provider-key capacity, production
memory configuration, top-up management, and critical cron freshness.

The `upptime/.upptimerc.yml` and `upptime/README.md` files in the
`blockvantage/pulse` app repository are canonical. Copy both files byte-for-byte
to `blockvantage/pulse-status` `main` after every change. From the app repository,
run the read-only `npm run status:check-sync` command to verify that the public
repository matches without printing either file's contents.

Every check requires HTTP 200 and a stable successful body marker using
Upptime's supported `__dangerous__body_down_if_text_missing` option. Health must
contain `"status":"healthy"`, readiness must contain `"ready":true`, and the
homepage must contain `<title>Pulse`. The login check requires its app-specific
`brand-kicker` marker without changing the page's metadata contract. The
homepage does not accept a redirect as healthy.

After each successful scheduled Uptime check, the serialized writer job amends
the current `gh-pages` commit with a same-origin `monitor-freshness.json`. Manual
dispatches never update it, and amending avoids unbounded branch history. The
page shows a warning by default, shares a five-minute browser cache, and
re-evaluates the recorded check time every minute. It never calls the GitHub API
or fabricates and overrides an individual service result.

Static-site builds check out `upptime/status-page` at reviewed commit
`54c2ff5a3d998d525ee4c7e68dc7ce7414d89c33` and run `npm ci` against that
commit's lockfile. No status-page package spec or mutable `npm install` executes
under the publishing token.

## External Release Gates

Complete and record these operations in order. The Upptime workflow must first
publish a real generated site before any custom-domain work begins.

<!-- status-rollout:workflow-token -->

- [ ] In `blockvantage/pulse-status`, verify the workflow token has effective
      `contents: write` permission. Use the repository-scoped `GITHUB_TOKEN`. No
      broad PAT is permitted.

<!-- status-rollout:static-site-ci -->

- [ ] Dispatch `Static Site CI` from `main`, then observe the run through completion:
      `gh workflow run "Static Site CI" --ref main --repo blockvantage/pulse-status`, followed
      by `gh run list --repo blockvantage/pulse-status --workflow "Static Site CI"`
      and `gh run watch <run-id> --repo blockvantage/pulse-status --exit-status`.

<!-- status-rollout:generated-branch -->

- [ ] Verify the successful workflow created a genuine `gh-pages` branch with
      `gh api repos/blockvantage/pulse-status/branches/gh-pages --jq .name`. A 403
      from the workflow or a missing branch is a no-go; stop before Pages or DNS
      changes.

<!-- status-rollout:pages-source -->

- [ ] In repository Settings > Pages, switch Source from GitHub Actions to
      **Deploy from a branch**, select `gh-pages` and the `/` root, then save.

<!-- status-rollout:default-site -->

- [ ] Before configuring a CNAME, verify
      `https://blockvantage.github.io/pulse-status/` returns HTTP 200. Also
      verify the authoritative generated branch locally: run
      `git fetch origin gh-pages`, materialize it with
      `git archive origin/gh-pages | tar -x -C <preview-dir>`, and serve that
      directory using `python3 -m http.server 4173 --directory <preview-dir>`.
      Confirm `http://127.0.0.1:4173/` returns HTTP 200 and renders Pulse Status,
      and that `status-freshness.js` plus `monitor-freshness.json` are present.
      Do not require the GitHub project-subpath URL after a CNAME is configured;
      GitHub may redirect it to the custom hostname.

<!-- status-rollout:org-ownership -->

- [ ] In the `blockvantage` organization Pages settings, verify ownership of
      `opsprint.ai` before claiming any custom hostname for the repository.

<!-- status-rollout:dns-cname -->

- [ ] Create a DNS-only CNAME for `status.opsprint.ai` targeting
      `blockvantage.github.io`. Do not proxy the record through Cloudflare.

<!-- status-rollout:custom-domain -->

- [ ] Add `status.opsprint.ai` as the repository's Pages custom domain.

<!-- status-rollout:tls-certificate -->

- [ ] Wait for GitHub's DNS validation and TLS certificate to complete before
      changing transport settings.

<!-- status-rollout:https-enforcement -->

- [ ] Enable HTTPS enforcement last, only after GitHub reports that the
      certificate is available.

<!-- status-rollout:live-custom-domain -->

- [ ] Verify all four checks are present and healthy, then confirm
      `https://status.opsprint.ai` returns HTTP 200 rather than a Cloudflare 525.

<!-- status-rollout:gate-complete -->

- [ ] Do not mark the public-status gate complete until repository sync,
      workflow publication, Pages, DNS, TLS, and both live HTTP checks have been
      observed in their real systems.

Upptime documentation: <https://upptime.js.org/>
