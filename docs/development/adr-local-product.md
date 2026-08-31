# Local product boundary

The local product is a localhost-only server over canonical RepoArena stores.
The browser consumes a versioned, runtime-validated public API and never reads
repository files directly. Benchmark truth remains in `PersistedRun`; readiness
and optimizer runs have separate versioned local records. Mutation requests
require same-origin JSON and an in-memory CSRF token. Paths are resolved beneath
trusted repository roots before access.

The frontend is shipped as dependency-free static application assets from the
typed server package. This keeps the CLI installation self-contained while the
page/component and API models remain reusable by a future cloud frontend.
