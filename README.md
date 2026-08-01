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

## External Release Gates

Complete and record these operations in order. The Upptime workflow must first
publish a real generated site before any custom-domain work begins.

<!-- status-rollout:workflow-token -->

- [ ] In `blockvantage/pulse-status`, verify the workflow token has effective
      `contents: write` permission. Use the repository-scoped `GITHUB_TOKEN`. No
      broad PAT is permitted.

<!-- status-rollout:static-site-ci -->

- [ ] Dispatch `Static Site CI`, then observe the run through completion:
      `gh workflow run "Static Site CI" --repo blockvantage/pulse-status`, followed
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

- [ ] Verify `https://blockvantage.github.io/pulse-status/` returns HTTP 200 and
      renders the generated Upptime site. Do not continue on a redirect or error.

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
