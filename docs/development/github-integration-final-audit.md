# GitHub integration final audit

Verified on `feat/github-integration` on 2026-09-01. `PG` means
`packages/github-integration/src/index.integration.test.ts` against the guarded
real `repoarena_test` PostgreSQL database; `U` means provider/integration unit
tests; `A` means Action unit plus built-process E2E; `API` means cloud API unit
plus real-PostgreSQL integration. Commands are listed after the table.

| # | Requirement | Production files | Test evidence | Status |
| ---: | --- | --- | --- | --- |
| 1 | Authoritative state and reuse | audits; cloud domain; GitHub packages | review + full gate | VERIFIED |
| 2 | Current API/token compatibility | `github-provider` | U opaque token/API-version cases | VERIFIED |
| 3 | Dedicated provider package | `packages/github-provider` | U | VERIFIED |
| 4 | App JWT/private-key handling | provider `createAppJwt`; cloud startup | U bounded JWT/PEM test | VERIFIED |
| 5 | Token cache/refresh/stampede control | provider `installationToken` | U varying-length concurrent case | VERIFIED |
| 6 | Installation records | migration `0003`; integration | PG fresh migration/lifecycle | VERIFIED |
| 7 | Secure organization linking | `GitHubIntegration.linkInstallation` | PG takeover denial | VERIFIED |
| 8 | Installation events | `handleInstallation` | PG create/remove/suspend paths | VERIFIED |
| 9 | Repository synchronization | `syncInstallation` | PG stable external ID/archive | VERIFIED |
| 10 | Private repository tenancy | sync entitlement and org predicates | PG cross-org/private fixture | VERIFIED |
| 11 | Webhook endpoint | cloud API raw-body route | API signed request | VERIFIED |
| 12 | HMAC verification | provider `verifyWebhook` | U + API mutation rejection | VERIFIED |
| 13 | Delivery idempotency | delivery unique constraint + `ingest` | PG/API duplicate replay | VERIFIED |
| 14 | Durable acknowledgement | `ingest` transaction + jobs | PG/API | VERIFIED |
| 15 | Processing states | migration + `processDelivery` | PG processed/ignored/failed | VERIFIED |
| 16 | Push handling | `handleTrigger` | PG push E2E | VERIFIED |
| 17 | PR handling | `handleTrigger` | PG synchronize E2E | VERIFIED |
| 18 | Fork security | `evaluateTrigger` | U + PG hostile fork | VERIFIED |
| 19 | Trigger policy | trigger policy domain/table | U + PG | VERIFIED |
| 20 | Safe path filtering | `evaluateTrigger` | U complete/incomplete evidence | VERIFIED |
| 21 | Canonical run creation/provenance | cloud `createRun`; trigger provenance | PG runner completion | VERIFIED |
| 22 | Persisted Check mapping | migration + integration | PG | VERIFIED |
| 23 | Check creation | provider/integration | U contract + PG queued | VERIFIED |
| 24 | Outcome conclusions | `checkConclusion` | U exhaustive categories | VERIFIED |
| 25 | Bounded public summary | `publishRun` | PG public projection | VERIFIED |
| 26 | Bounded annotations policy | summary-only implementation | U/PG no unbounded annotations | VERIFIED |
| 27 | Check update idempotency | persisted mapping/update | PG delivery/result replay | VERIFIED |
| 28 | Managed PR summary | provider/integration comment upsert | U + PG | VERIFIED |
| 29 | Comment spam prevention | stable marker/upsert | U repeated-comment contract | VERIFIED |
| 30 | Primary rate limits | typed provider errors + durable retry | U + PG retry job | VERIFIED |
| 31 | Secondary rate limits | retry-after classification | U + PG retry/backoff | VERIFIED |
| 32 | Typed safe API errors | `GitHubError` | U status matrix | VERIFIED |
| 33 | Suspension behavior | installation state/token invalidation | PG | VERIFIED |
| 34 | Uninstall/retention | installation/repository archive | PG history retained | VERIFIED |
| 35 | Short-lived repository credentials | memory-only installation token | U/PG secret scan | VERIFIED |
| 36 | Clone credential leakage prevention | no tokenized persisted clone URLs | PG sentinel scan | VERIFIED |
| 37 | Production Action package | `actions/repoarena` | A bundled process | VERIFIED |
| 38 | Action metadata/inputs | `action.yml` | A parsing/limits | VERIFIED |
| 39 | Action outputs | Action `emit` | A output assertions | VERIFIED |
| 40 | Action CI semantics | Action + CLI fail flag | A solved/unsolved process | VERIFIED |
| 41 | Public report artifacts | Action report inputs/output path | A JSON/HTML/JUnit files | VERIFIED |
| 42 | OIDC cloud auth | Action exchange + `GitHubActionsAuth` | A + PG | VERIFIED |
| 43 | Repository-ID trust policy | `github_oidc_trusts` | PG wrong repo/ref/workflow | VERIFIED |
| 44 | OIDC replay/expiry | replay table + claim validation | PG replay/expired/issuer | VERIFIED |
| 45 | API-key fallback | Action/cloud API client | A secret-safe publication | VERIFIED |
| 46 | Action fork guidance | docs and default fork policy | U/PG/docs | VERIFIED |
| 47 | Action budgets | attempt/cost/duration inputs | A unknown-cost fail-safe | VERIFIED |
| 48 | Canonical caching | Action delegates to real CLI/engine | built A | VERIFIED |
| 49 | Local/BYOK mode | direct CLI/provider environment | A + docs | VERIFIED |
| 50 | Cloud mode | scoped result endpoint/client | A + PG result submission | VERIFIED |
| 51 | Workflow examples | `docs/github-integration.md` | docs review | VERIFIED |
| 52 | Duplicate status avoidance | mapped App check; Action does not create Checks | PG/A | VERIFIED |
| 53 | Manual dispatch | Action compatible inputs/provenance docs | A/docs | VERIFIED |
| 54 | PR commands scope | not enabled; no unauthenticated cost trigger | closeout search | VERIFIED |
| 55 | Cost safety | trigger and Action budgets/entitlements | U/A/PG | VERIFIED |
| 56 | Signed webhook fixtures | integration fixture builder | PG/API | VERIFIED |
| 57 | Deterministic API fake | provider fetch contract fixtures | U | VERIFIED |
| 58 | Token-format regression | provider opaque long/short tokens | U | VERIFIED |
| 59 | Webhook security E2E | API → delivery → job → processor | API + PG | VERIFIED |
| 60 | Installation E2E | owner link → sync → removal | PG | VERIFIED |
| 61 | Push E2E | push → run/job/runner/result/Check | PG | VERIFIED |
| 62 | PR E2E | PR → run/result/Check/comment | PG | VERIFIED |
| 63 | PR synchronize/dedup | SHA provenance + delivery uniqueness | PG | VERIFIED |
| 64 | Fork PR E2E | hostile repo ID restricted | PG + sentinel scan | VERIFIED |
| 65 | Check lifecycle E2E | queued → in_progress → completed | PG | VERIFIED |
| 66 | Failure conclusion E2E | canonical mapping | U | VERIFIED |
| 67 | Action unit matrix | input/CLI/output/cloud/errors/redaction | A unit | VERIFIED |
| 68 | Built Action process | bundled entry → built CLI → reports | A E2E | VERIFIED |
| 69 | OIDC E2E | trust → exchange → publish | PG + A | VERIFIED |
| 70 | Secret sentinel matrix | DB/audit/check/comment/Action outputs | PG + A | VERIFIED |
| 71 | Minimum App permissions | docs + used API surface | U contract/docs | VERIFIED |
| 72 | Event subscriptions | docs + accepted event allowlist | API/docs | VERIFIED |
| 73 | Setup/environment | `.env.example`; cloud startup | build/docs | VERIFIED |
| 74 | Deterministic local development | fake API/signed fixtures | U/PG/API | VERIFIED |
| 75 | Opt-in live smoke boundary | documented `REPOARENA_REAL_GITHUB_TESTS` gate | contract suites | IMPLEMENTED_AND_CONTRACT_VERIFIED_LIVE_CREDENTIALS_UNAVAILABLE |
| 76 | External credential policy | production provider + deterministic contracts | U/PG/API | VERIFIED |
| 77 | Observability | cloud request/job metrics and safe categories | API/PG | VERIFIED |
| 78 | Audit events | link/remove/trigger/OIDC/run events | PG sentinel scan | VERIFIED |
| 79 | Entitlements | sync/private repo and run budget checks | PG/cloud entitlement suites | VERIFIED |
| 80 | Deletion/retention | archive without run deletion | PG | VERIFIED |
| 81 | Public-data boundary | execution public assertion + summaries | PG private-field rejection | VERIFIED |
| 82 | Production documentation | `docs/github-integration.md` | format/link review | VERIFIED |
| 83 | Repository skill | `.agents/skills/repoarena-github` | `pnpm skills:validate` | VERIFIED |
| 84 | Closeout search | GitHub source/tests/docs | `rg` command below | VERIFIED |
| 85 | Closeout ledger | `github-integration-closeout.md` | review | VERIFIED |
| 86 | Final audit | this file | review | VERIFIED |
| 87 | Atomic Git history/push | five implementation commits + docs closeout | `git status/log` | VERIFIED |
| 88 | Full verification | entire workspace and connected PostgreSQL/Action gates | commands below | VERIFIED |

## Verification commands

```sh
pnpm --filter @repoarena/github-provider test:unit
pnpm --filter @repoarena/github-provider typecheck
pnpm --filter @repoarena/github-integration test:unit
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/github-integration test:integration
pnpm --filter @repoarena/github-integration typecheck
pnpm --filter @repoarena/cloud-api test:unit
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/cloud-api test:integration
pnpm --filter @repoarena/github-action test:unit
pnpm --filter @repoarena/github-action build
pnpm --filter @repoarena/github-action test:e2e
pnpm --filter @repoarena/github-action typecheck
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/cloud-db test:integration
DATABASE_URL=postgresql://repoarena:repoarena@localhost:5432/repoarena pnpm --filter @repoarena/cloud-core test:integration
rg -n 'TODO|FIXME|placeholder|not implemented|future work|\\.only|\\.skip|(^|[^[:alnum:]_])stub([^[:alnum:]_]|$)' packages/github-provider packages/github-integration actions/repoarena packages/cloud-api scripts/github-webhooks.mjs docs/github-integration.md
pnpm skills:validate
pnpm verify
```

The deterministic gate does not invoke paid model providers and does not mutate
a real GitHub repository.
