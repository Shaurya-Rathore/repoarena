---
name: repoarena-architecture
description: Design or change RepoArena cross-package boundaries, provenance, and cloud/local domain architecture.
---

Read root `AGENTS.md`, the implementation ledger, and affected bible sections.
Keep local execution separate from cloud control-plane trust boundaries. Validate
cross-package values and hash only canonical JSON content, never display data.
Record durable decisions in an ADR and the commit plan.

Local product ownership is: CLI starts the loopback server; the server reads
validated config, task public projections, and canonical state records; the
browser consumes only the typed API. Readiness and optimizer history have
separate versioned records and atomic storage. Mutation requests require JSON,
same-origin validation, and a per-process CSRF token.
