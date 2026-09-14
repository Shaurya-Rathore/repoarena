# RepoArena 1.0 final human checklist

Every unchecked item is a human launch action, not an engineering verification
failure. Follow the [launch runbook](oss-launch-runbook.md) in order.

- [ ] Branch: fast-forward `release/oss-launch` into `main`; record the approved commit.
- [ ] Package: verify checksums, authenticate to npm, and publish `repoarena@1.0.0`.
- [ ] GitHub: choose public visibility and apply description, topics, preview, and vulnerability reporting.
- [ ] Tag: create/push immutable `v1.0.0` and compatible-major `v1` at the approved commit.
- [ ] Release: create the GitHub Release with notes, tarballs, manifest, and checksums.
- [ ] Action: confirm both Action tags resolve and run one trusted `workflow_dispatch` smoke.
- [ ] Fresh install: install `repoarena@1.0.0` from npm in a clean directory and run the local deterministic smoke.
- [ ] README/assets: inspect the public README, license, links, issue forms, and social preview.
- [ ] Announcement: post only after package, repository, release, Action, and fresh install are verified.
