# Packaged Codex live smoke

Date: 2026-09-11  
Branch: `test/codex-live-smoke`  
Release base: `release/oss-launch` at `8c41313`  
RepoArena version: `1.0.0`

## Packaged artifact

The smoke installed `release-artifacts/repoarena-1.0.0.tgz` into an isolated
temporary npm project. The post-fix artifact SHA-256 was:

`898a87b03291605a0bc6cfd4222e1d426ff536f1b48f268cfbc2704d35255db5`

No monorepo CLI entrypoint or fake adapter executed the live attempt. Database,
Stripe, GitHub, S3, hosted-compute, cloud-auth, `OPENAI_API_KEY`, and test-adapter
environment variables were removed from the child environment. Codex used only
its existing local ChatGPT authentication.

## Detection and compatibility

- Packaged RepoArena detection: Codex available.
- Codex version: `codex-cli 0.154.0`.
- Adapter-reported authentication: `unknown` (the general detection contract
  does not inspect credential stores).
- Safe auth readiness probe: `codex login status` exited successfully and
  reported an existing ChatGPT login. No credential value or file was read.
- Supported adapter configuration: noninteractive execution, optional model
  selection, provider-dependent models and usage.
- Real JSONL events observed: `thread.started`, `turn.started`,
  `item.started`, `item.completed`, and `turn.completed`.
- Stdout was JSONL without ANSI control sequences; stderr was bounded and
  persisted through the existing redaction boundary; process exit was `0` and
  no timeout occurred.

## Exact benchmark invocation

The opt-in entrypoint was:

```sh
REPOARENA_REAL_AGENT_TESTS=1 \
REPOARENA_TEST_AGENT=codex \
REPOARENA_AGENT_SMOKE_ACKNOWLEDGE_COST=yes \
pnpm agent:smoke
```

It installed the packaged CLI and invoked the equivalent of:

```sh
repoarena run \
  --agent codex \
  --tasks codex-live-smoke \
  --runs-per-task 1 \
  --parallel 1 \
  --sandbox local \
  --report terminal,json,html,junit \
  --output .repoarena/reports
```

The task used one tiny arithmetic defect, one 120-second agent ceiling, one
15-second public check, one hidden check, no model override, no optimizer, and
no retry to seek a green result.

## Compatibility finding and correction

The first real statistical attempt was a valid unsolved adapter run. Codex
identified the exact fix but reported that its workspace was read-only. Current
Codex 0.154 requires an explicit writable sandbox for noninteractive execution.
RepoArena therefore added only the required current flags:

```text
codex exec --json --color never --sandbox workspace-write --ephemeral <prompt>
```

The correction also normalizes the final reliable `turn.completed.usage` JSONL
object. Sanitized regression fixtures cover exact argument construction,
complete usage, progress/malformed input, and incomplete usage. Per policy,
exactly one additional bounded live confirmation was performed after these
deterministic tests.

## Final result

`LIVE_ADAPTER_VERIFIED_SOLVED`

- Canonical final run report ID: `bdaaf2791f341425200c94a5`.
- Canonical final attempt ID: `cb8730e78ccff4a89f06dc24`.
- Statistical attempts in the final confirmation: `1`.
- Agent/model identity: `codex` / no explicit model override.
- Real source patch: `sum.js` changed integer subtraction to addition.
- Agent exit: `0`; timeout: false.
- Public verification: 1 passed, 0 failed.
- Private verification: 1 passed, 0 failed, after Codex termination.
- Integrity findings: 0; regression findings: 0.
- Canonical attempt and benchmark result persisted.
- Terminal, JSON, HTML, and JUnit reports generated.
- Packaged loopback UI rendered Codex identity, outcome, patch-backed result,
  verification summary, duration, usage/cost state, and safe result metadata.

## Usage and cost

Production parsing recorded structurally valid provider-reported usage:

- input tokens: `62016`;
- cached input tokens: `56192`;
- output tokens: `507`;
- reasoning tokens: `0`;
- usage state: `AVAILABLE`.

The versioned release pricing catalog had no matching explicit price snapshot,
so cost correctly remained `UNAVAILABLE` with `micros: null`. No token count or
price was invented, and no external pricing request occurred.

## Private and credential safety

A unique hidden-evaluator sentinel and a separate reference-fix sentinel were
absent from terminal output, persisted public run/attempt data, JSON, HTML,
JUnit, and local UI API responses. The real source patch was captured while the
reference fix remained private. A structural scan found no bearer-token,
API-key, access-token, or ANSI/control-sequence pattern in persisted/public
surfaces. No real credential value was read or copied into the scan.

## Deterministic regression commands

```sh
pnpm --filter @repoarena/adapter-codex build
pnpm --filter @repoarena/adapter-codex test:unit
pnpm --filter @repoarena/adapter-codex typecheck
pnpm --filter @repoarena/runner-core test:unit
pnpm --filter repoarena test:unit
pnpm release:packed-cli
pnpm release:security
pnpm typecheck
pnpm verify
pnpm release:verify
```

## OSS release status

The compatibility defect is corrected and covered by sanitized deterministic
tests plus one post-fix packaged live confirmation.

`OSS RELEASE BLOCKERS: NONE`
