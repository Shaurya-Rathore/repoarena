# Coding-agent setup

RepoArena invokes installed coding-agent CLIs non-interactively and uses their
existing authentication. Run `repoarena agents detect` at any time; `ready`
means RepoArena found a compatible executable and version.

| Adapter | CLI prerequisite | Authentication expectation |
| --- | --- | --- |
| `codex` | Codex CLI on `PATH` | Complete the CLI's normal sign-in flow. |
| `claude-code` | Claude Code on `PATH` | Complete Claude Code authentication. |
| `gemini-cli` | Gemini CLI on `PATH` | Complete Gemini CLI authentication. |
| `opencode` | OpenCode on `PATH` | Configure its chosen provider normally. |

Use `repoarena agents inspect <adapter> --json` for detection details and
`repoarena run --agent <adapter> --model <model>` to request a supported model.
Agent-specific model and usage support is reported by the adapter; unknown
pricing remains unavailable rather than being treated as free.

If an agent is reported as `not found`, confirm its own version command works in
the same shell, then check `PATH`. If it is found but a run fails authentication,
sign in with that agent directly. RepoArena does not persist provider passwords
or long-lived provider credentials in its default local configuration.

Paid-agent smoke testing is an explicit opt-in:

```sh
REPOARENA_REAL_AGENT_TESTS=1 \
REPOARENA_REAL_AGENT=codex \
REPOARENA_REAL_AGENT_TASK=one-safe-task \
pnpm agent:smoke
```

The harness is bounded to one configured agent/task/run. It is excluded from
`pnpm verify` and must not be used with a repository or account you did not mean
to charge.
