# RepoArena 1.0.0

RepoArena is CI for AI coding agents: discover real repository tasks, benchmark
agents under isolated public/private verification, and compare correctness,
cost, and time locally or in the cloud.

1.0 includes the CLI/local UI, PostgreSQL cloud control plane, GitHub App and
Action, public sharing and leaderboard, Stripe subscriptions with BYOK cost
separation, and optional budgeted hosted compute. Install after publication with
`npm install --global repoarena`.

Live provider smoke tests require explicit credentials and are excluded from
the deterministic release gate. Docker sandbox contracts are verified, but the
current release environment does not provide a Docker daemon.
