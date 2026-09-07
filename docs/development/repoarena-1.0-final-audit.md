# RepoArena 1.0 final release audit

Release candidate: `1.0.0` on `release/repoarena-1.0`.

| Release domain | Implementation | Test / evidence | Verification | Status |
| --- | --- | --- | --- | --- |
| Branch and audit preservation | release branch from integrated `6a65d4b`; all subsystem audits | ancestry and clean-tree checks | `git merge-base --is-ancestor 6a65d4b HEAD` | VERIFIED |
| Version and provenance | all workspace manifests; `REPOARENA_VERSION`; CLI structured version | source and packed CLI version checks | `repoarena --version`; `repoarena version --json` | VERIFIED |
| Frozen reproducible build | lockfile, Node 24/pnpm 9 metadata, clean detached worktree | no prior outputs or hidden env | `pnpm release:clean-checkout` | VERIFIED |
| CLI distribution | bundled standalone CJS executable and narrow npm file list | isolated npm install, init, doctor, fake benchmark, JSON/HTML/JUnit, local UI health | `pnpm release:dry-run && pnpm release:packed-cli` | VERIFIED |
| GitHub Action distribution | bundled Node 24 Action and metadata | external temporary repository process execution and CI semantics | `pnpm --filter @repoarena/github-action test:e2e` | VERIFIED |
| Runner/protocol compatibility | canonical runner capability/version checks and hosted exact-lease credentials | self-hosted/GitHub/hosted suites | `pnpm test:integration` | VERIFIED |
| PostgreSQL migrations | unchanged migrations 0001–0008; advisory lock; compatibility classifier | empty, v1 upgrade, rollback/failure and current/behind/ahead cases | `pnpm --filter @repoarena/cloud-db test:integration` | VERIFIED |
| Backup and restore | guarded pg_dump/custom restore drill | org, benchmark/run, subscription, GitHub installation, hosted usage, publication and eight migrations preserved | `pnpm release:backup-restore` | VERIFIED |
| Object storage durability | S3 and deterministic provider contracts; server-generated keys and checksums | missing/checksum/auth/foreign-object behavior in object/cloud/hosted suites | `pnpm --filter @repoarena/object-storage test:unit` | VERIFIED |
| Production configuration | authoritative env example and fail-fast feature-gated HTTPS/SSL validator | valid and missing/invalid category checks | `pnpm config:validate:production` | VERIFIED |
| Deployment and operations | boring process topology, TLS/proxy/start/stop/migrate/rollback guidance | built API/product health and operator command smoke | `pnpm test:cloud-product-built`; operations docs | VERIFIED |
| HTTP and application security | CSP, frame/referrer/content headers, same-origin/CSRF/CORS, limits and RBAC | cloud product/API/GitHub/billing security suites | `pnpm verify`; `pnpm test:integration` | VERIFIED |
| Secrets and private data | redaction/public projections plus Secretlint and artifact scan | full credential/evaluator sentinel matrix and release artifacts | `pnpm release:secret-scan`; `pnpm release:security` | VERIFIED |
| Dependencies and licenses | patched AWS SDK and YAML; deterministic production license inventory | no known production advisories; no restricted/unknown licenses | `pnpm audit --prod --audit-level low`; `pnpm release:licenses` | VERIFIED |
| Supply chain and CI | frozen lock, pinned third-party actions, explicit read-only workflow permissions | CI/release workflow review; dry-run never publishes | workflow files; `pnpm release:verify` | VERIFIED |
| Performance and bounds | paginated APIs, bounded logs/diffs/artifacts, indexed job/public queries | 200-request HTTP baseline and PostgreSQL concurrency suites | `pnpm release:performance`; `pnpm test:integration` | VERIFIED |
| Retention and recovery | idempotent session/token/artifact/webhook/orphan policies and runbooks | cloud/hosted unit and integration suites | `pnpm verify`; disaster recovery drill | VERIFIED |
| Cross-product release E2E | canonical execution through cloud, GitHub, publication/leaderboard/badge, billing and hosted fixtures | real PostgreSQL deterministic integrations followed by representative backup/restore | cloud-product E2E; billing/hosted suites; backup drill | VERIFIED |
| Documentation and examples | README, install/deployment/product docs, examples, changelog, security and release notes | literal packed quick-start and internal link/file checks | `pnpm release:packed-cli`; closeout search | VERIFIED |
| Release artifacts and safeguards | CLI/Action tarballs, SHA256SUMS, JSON manifest, clean/tag publish preflight | version/checksum/package-content validation | `pnpm release:dry-run`; `pnpm release:publish:check` at tagged publication | VERIFIED |

## Performance record

On the 2026-09-07 local Node.js 24 release environment, the final bounded
200-request, concurrency-20 built HTTP baseline completed with zero errors at
1,339 requests/s, p50 5.90 ms, p95 44.72 ms, and maximum 50.30 ms. These values are environmental
regression evidence, not an availability or production-capacity guarantee.

## Known limitations and external checks

- Docker daemon execution was unavailable; the Docker backend remains contract
  tested and deterministic release verification uses the local sandbox.
- Real coding-agent, GitHub App, Stripe test-mode, S3, and hosted-compute smoke
  tests were not executed because credentials were not supplied. Their opt-in,
  bounded harnesses and deterministic provider contracts are implemented.
- The open-source deployment makes no contractual RPO/RTO promise; operators
  establish targets through documented backup frequency and restore drills.

External live checks: `IMPLEMENTED_AND_CONTRACT_VERIFIED_LIVE_CREDENTIALS_UNAVAILABLE`.

## Exact release gate

```sh
set -a; source .env.local; set +a
pg_isready
pnpm install --frozen-lockfile
pnpm --filter @repoarena/cloud-db test:integration
pnpm test:integration
pnpm --filter @repoarena/cloud-product test:e2e
pnpm --filter @repoarena/github-action test:e2e
pnpm test:cloud-product-built
pnpm release:backup-restore
pnpm release:dry-run
pnpm release:packed-cli
pnpm release:clean-checkout
pnpm release:secret-scan
pnpm release:security
pnpm audit --prod --audit-level low
pnpm release:licenses
pnpm release:performance
pnpm format:check
pnpm lint
pnpm typecheck
pnpm skills:validate
pnpm verify
pnpm release:verify
```

## Release blockers

NONE
