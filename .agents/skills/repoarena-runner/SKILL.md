---
name: repoarena-runner
description: Implement or harden RepoArena attempt workspaces, execution backends, evaluation lifecycle, and artifacts.
---

Model attempts as explicit persisted states. Agents are untrusted: use a fresh
workspace, minimal environment, network-off default, bounded output, timeout,
process-tree cancellation, path-safe artifact collection, and cleanup. Apply
hidden evaluation only after the agent exits in a separate evaluator copy.
