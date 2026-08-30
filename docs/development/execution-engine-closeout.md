# Execution-engine closeout checklist

This is the working checklist for the final connected-engine verification.

- [x] Connected local attempt lifecycle, public/private evaluation ordering.
- [x] Safe patch and artifact manifests, redaction, atomic run persistence.
- [x] Repetitions, bounded concurrency, aggregation, pricing snapshots, reports, CLI E2E.
- [x] Explicit provider/infrastructure retry classes, budgets, injectable backoff, and logical-attempt accounting; interrupted-run recovery inspection.
- [x] Persisted run recovery inspection distinguishes corrupt/running/terminal state and requires clean restart for interrupted runs.
- [x] Connected adversarial matrix covers perfect, wrong, no-op, partial/private failure, and test deletion through the real benchmark pipeline.
- [ ] Full fake-agent/security E2E matrix through the built CLI.
- [x] Cross-reporter historical-cost reload test across terminal/JSON/HTML/JUnit and catalog replacement.
- [ ] Docker daemon integration (environment-gated; daemon unavailable here).
- [x] Aggregate duration variance, standard deviation, percentiles and 95% confidence interval are emitted from benchmark attempt evidence.
