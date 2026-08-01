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

Every check requires HTTP 200 and a stable successful body marker using
Upptime's supported `__dangerous__body_down_if_text_missing` option. Health must
contain `"status":"healthy"`, readiness must contain `"ready":true`, and the
homepage must contain `<title>Pulse`. The login check requires its app-specific
`brand-kicker` marker without changing the page's metadata contract. The
homepage does not accept a redirect as healthy.

## External Release Gates

The release owner must complete and record these operations outside this repo:

1. Create the public `blockvantage/pulse-status` repository from the Upptime
   template and copy this directory's `.upptimerc.yml` and `README.md` into it.
2. Enable GitHub Pages with GitHub Actions as its source.
3. Add a DNS-only CNAME for `status.opsprint.ai` targeting
   `blockvantage.github.io`.
4. Configure `status.opsprint.ai` as the Pages custom domain, wait for GitHub's
   TLS certificate, and enable HTTPS.
5. Verify all four checks are present and healthy, then confirm
   `https://status.opsprint.ai` returns HTTP 200 rather than a Cloudflare 525.

Do not mark the public-status gate complete until the repository, DNS, TLS, and
live checks have all been observed in their real systems.

Upptime documentation: <https://upptime.js.org/>
