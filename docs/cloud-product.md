# RepoArena Cloud product

Start PostgreSQL and the Cloud API, apply migrations, then build and start the product:

```sh
pnpm db:migrate
pnpm build
pnpm cloud:api
pnpm cloud:product
```

`CLOUD_PRODUCT_ORIGIN` defaults to `http://127.0.0.1:3000`; `CLOUD_API_ORIGIN`
defaults to `http://127.0.0.1:8787`. The product server is a same-origin gateway:
browser code never reads PostgreSQL or object storage directly. Production should
terminate TLS in front of both services and set the public origin consistently.

## Product workflow

Sign in with GitHub, create or select an organization, connect a GitHub App
installation, and choose a repository. Tasks are public-safe projections. Benchmark
versions are immutable; launching a run enqueues durable work and immediately opens
the live run view. Run details render stored correctness, retries, patches,
verification, integrity, regression, artifacts, usage, and immutable BYOK cost.

Readiness and optimization pages render tenant-scoped canonical reports produced by
the verified readiness and optimizer engines. Schedule, runner, API-key, membership,
GitHub-installation, audit, and usage pages call the versioned Cloud API. Runner and
API-key plaintext credentials are shown only on creation.

## Publishing and public pages

Publishing is explicit and requires repository-management permission. A private
repository additionally requires explicit confirmation and its public projection
uses the label `Private repository`, with no source URL. Public reads use the stored
immutable projection—not the private run row. Unpublishing immediately removes the
share and badge data.

The public site exposes `/leaderboard`, `/share/<publication>`, stable repository
profiles, and stable repository badges. Leaderboard entries disclose sample size,
methodology, task-set provenance, correctness, time, and BYOK cost. Mixed task sets
are marked incomparable rather than ranked. Badge Markdown is available on the share
page and automatically follows the latest publication for that repository.

## Security and privacy

Authenticated pages use `private, no-store` and `noindex`; public routes use explicit
bounded cache policies. CSP denies framing and limits scripts to a per-response nonce.
The gateway forwards session/CSRF context without exposing credentials to HTML,
validates public identifiers, escapes dynamic HTML/SVG content, rate-limits public
API traffic, and never serializes hidden evaluators, reference fixes, private
artifacts, object keys, runner tokens, API keys, or provider secrets.

## Verification

```sh
pnpm --filter @repoarena/cloud-product test:unit
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/cloud-product test:e2e
pnpm test:cloud-product-built
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/public-publishing test:integration
pnpm skills:validate
pnpm verify
```
