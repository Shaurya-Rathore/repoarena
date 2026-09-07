# RepoArena 1.0 performance baseline

`pnpm release:performance` exercises the built cloud-product server on loopback
with 200 requests in ten batches of 20, split between the landing page and
liveness endpoint. It reports throughput, p50, p95, maximum latency, and errors.
This is a deterministic regression baseline, not a production capacity promise.
PostgreSQL integration suites separately exercise job claims, scheduler
idempotency, result submission, and hosted final-slot capacity using independent
connections. Actual RC measurements are recorded in the final audit.
