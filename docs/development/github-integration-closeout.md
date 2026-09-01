# GitHub integration closeout

Updated: 2026-09-01.

| Requirement group | Status |
| --- | --- |
| GitHub provider, App JWT, opaque installation-token lifecycle and typed errors | VERIFIED |
| Installation linking/lifecycle, repository synchronization, suspension and retention | VERIFIED |
| Raw-body webhook authentication, delivery idempotency, durable processing and retry | VERIFIED |
| Push/PR policy, path uncertainty, fork restrictions, budgets and canonical run provenance | VERIFIED |
| Check Run lifecycle/conclusions, bounded summaries and managed PR comments | VERIFIED |
| Bundled GitHub Action, real CLI execution, reports, outputs and CI semantics | VERIFIED |
| Repository-bound Actions OIDC, replay/expiry/ref/workflow checks and API-key fallback | VERIFIED |
| PostgreSQL connected flows, cross-tenant denial, result replay and public/private boundary | VERIFIED |
| Permissions, subscriptions, operations, documentation, skills and closeout search | VERIFIED |
| Opt-in real GitHub mutation smoke test | IMPLEMENTED_AND_CONTRACT_VERIFIED_LIVE_CREDENTIALS_UNAVAILABLE |

The detailed one-to-one evidence is in
`docs/development/github-integration-final-audit.md`. Normal verification makes
no paid model calls and performs no live GitHub mutations.
