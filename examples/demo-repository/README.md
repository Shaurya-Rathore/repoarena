# Deterministic demo repository

This tiny fixture documents the repository created by `pnpm demo`. Its
historical bug is deliberately simple: `subject.txt` contains `bug`, while the
task requires `fixed`. Public and hidden checks independently verify the repair.

The demo script creates an isolated Git history, discovers historical
candidates, installs the task, compares `fake-noop` with `fake-perfect`, and
generates terminal, JSON, HTML, and JUnit output. Test adapters are unavailable
outside the explicitly gated test environment and can never replace a real
agent accidentally.
