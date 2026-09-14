# RepoArena 1.0 launch drafts

These drafts contain no traction, customer, or universal agent-performance
claims. Update repository links if the permanent owner changes before launch.

## GitHub Release / repository announcement

RepoArena 1.0 is CI for AI coding agents.

Different coding agents perform differently on different codebases. RepoArena
turns real historical bugs from your Git history into repeatable benchmarks for
Codex, Claude Code, Gemini CLI, and OpenCode. Each attempt runs in a clean
workspace; hidden behavioral verification and reference fixes stay outside the
agent phase.

RepoArena is local-first and BYOK: no account is required, and it uses your
agent CLI's existing authentication. Results are available as terminal, JSON,
HTML, and JUnit reports, plus a loopback-only local UI. The release also
includes repository readiness checks, a budgeted configuration optimizer, and
a fork-aware GitHub Action.

The packaged 1.0 CLI completed a bounded live integration smoke with Codex CLI
0.154.0, including a real workspace edit, private verification, reports, and
the local UI. Deterministic adapters remain available for a zero-cost tour.

Start: `npm install --global repoarena`

## Hacker News-style submission

**RepoArena – benchmark coding agents on real bugs from your own Git history**

I built RepoArena because “which coding agent is best?” is usually the wrong
question. Different agents perform differently on different repositories.

RepoArena mines historical fixes, reconstructs the buggy revision, gives each
agent a clean attempt, and evaluates the result with public and hidden checks.
It compares Codex, Claude Code, Gemini CLI, and OpenCode using correctness,
pass@k, time, and cost evidence from the same canonical run.

It is local-first, BYOK, and works without an account. It emits terminal, JSON,
HTML, and JUnit reports, includes a local UI and bounded optimizer, and can run
as a GitHub Action. The demo uses deterministic fake agents and makes no paid
calls.

Repository: <https://github.com/Shaurya-Rathore/repoarena>

## Short developer/social post

RepoArena 1.0: CI for AI coding agents.

Different coding agents perform differently on different codebases. RepoArena
benchmarks Codex, Claude Code, Gemini CLI, and OpenCode by replaying real
historical bugs from your repo, with hidden behavioral verification kept away
from the agent workspace.

Local-first, BYOK, no account required. Terminal/JSON/HTML/JUnit reports, local
UI, optimizer, and a GitHub Action.

`npm install --global repoarena`
