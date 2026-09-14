# RepoArena 1.0 OSS launch runbook

This is a human-controlled launch packet. Commands marked **HUMAN EXECUTION
REQUIRED** mutate GitHub or npm and were prepared but not executed.

## Confirmed release identity

- Source branch: `release/oss-launch`.
- Version: `1.0.0`.
- npm package: unscoped `repoarena`.
- Executable: `repoarena`.
- Registry: `https://registry.npmjs.org/`.
- Access: public. The package is unscoped and has no `publishConfig`; the
  explicit publish command below fixes both registry and access rather than
  relying on a user's npm defaults.
- CLI artifact: `release-artifacts/repoarena-1.0.0.tgz`.
- Action artifact: `release-artifacts/repoarena-action-1.0.0.tgz`.
- GitHub remote at packet preparation: `Shaurya-Rathore/repoarena`.
- Default branch: `main`.

The npm package dry-run contains only `dist/index.cjs`, `package.json`,
`README.md`, and the automatically included Apache-2.0 `LICENSE`. The bundled
CLI contains the local UI, adapters, sandbox/runtime code, reporters, task
tools, readiness, and optimizer. Secret scanning and the release package E2E
cover the artifact; source maps, test files, private evaluator fixtures,
credentials, and repository development files are excluded.

At preparation time `repoarena` returned npm `E404`, meaning no public package
was visible under that exact name. Registry ownership is established only when
the authorized human successfully publishes.

## Ordered launch

### 1. Integrate the final branch

`main` is an ancestor of `release/oss-launch`, so the current integration path
is a history-preserving fast-forward. **HUMAN EXECUTION REQUIRED:**

```sh
git fetch origin --prune
git switch release/oss-launch
git pull --ff-only origin release/oss-launch
export REPOARENA_RELEASE_COMMIT="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
git switch main
git pull --ff-only origin main
git merge --ff-only "$REPOARENA_RELEASE_COMMIT"
git push origin main
```

If `git merge --ff-only` fails, stop and use a reviewed pull request from
`release/oss-launch` to `main`; do not force-push or rewrite verified history.

### 2. Perform the final sanity check

Before any external mutation, confirm the approved commit, version, artifacts,
and checksums:

```sh
git switch main
test "$(git rev-parse HEAD)" = "$REPOARENA_RELEASE_COMMIT"
test -z "$(git status --porcelain)"
node -p "require('./packages/cli/package.json').version"
tar -tzf release-artifacts/repoarena-1.0.0.tgz
shasum -a 256 -c release-artifacts/SHA256SUMS
pnpm docs:check
git switch release/oss-launch
test "$(git rev-parse HEAD)" = "$REPOARENA_RELEASE_COMMIT"
REPOARENA_RELEASE_TAG=v1.0.0 pnpm release:publish:check
git switch main
```

The version command must print `1.0.0`. Review `manifest.json` and ensure its
commit is the approved release commit. If artifacts were regenerated after the
merge, review and retain the newly generated checksums.

### 3. Authenticate to npm

**HUMAN EXECUTION REQUIRED:** authenticate the authorized npm account using its
normal browser/2FA policy. Never paste credentials into the repository.

```sh
npm login --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/
```

The publishing account must be allowed to claim or publish `repoarena`. npm may
prompt for a WebAuthn/TOTP second factor during publication.

### 4. Publish the package

**HUMAN EXECUTION REQUIRED:** this is the exact prepared publication command:

```sh
npm publish ./release-artifacts/repoarena-1.0.0.tgz --access public --registry https://registry.npmjs.org/
```

Do not rerun blindly after a network ambiguity. First inspect
`npm view repoarena@1.0.0 --registry https://registry.npmjs.org/` because npm
versions are immutable.

### 5. Create and push release tags

Use the approved `main` commit. The immutable tag identifies the release; the
moving major tag is the documented GitHub Action reference. **HUMAN EXECUTION
REQUIRED:**

```sh
git switch main
test "$(git rev-parse HEAD)" = "$REPOARENA_RELEASE_COMMIT"
git tag -a v1.0.0 "$REPOARENA_RELEASE_COMMIT" -m "RepoArena 1.0.0"
git tag -a v1 "$REPOARENA_RELEASE_COMMIT" -m "RepoArena v1"
git push origin v1.0.0
git push origin v1
```

Before moving `v1` for later compatible 1.x releases, rerun the Action consumer
gate. Never move `v1.0.0`.

### 6. Create the GitHub Release

**HUMAN EXECUTION REQUIRED:** after both tags exist remotely:

```sh
gh release create v1.0.0 \
  release-artifacts/repoarena-1.0.0.tgz \
  release-artifacts/repoarena-action-1.0.0.tgz \
  release-artifacts/SHA256SUMS \
  release-artifacts/manifest.json \
  --repo Shaurya-Rathore/repoarena \
  --verify-tag \
  --title "RepoArena 1.0.0" \
  --notes-file docs/release-notes-1.0.0.md
```

If the repository is transferred before launch, replace only `--repo` with the
permanent owner/name and make all package/docs links consistent first.

### 7. Configure GitHub launch settings

**HUMAN EXECUTION REQUIRED:** follow
[`github-launch-settings.md`](github-launch-settings.md). Decide and apply public
visibility, description, topics, social preview, and private vulnerability
reporting. Do not automate the visibility change from this runbook.

### 8. Verify the GitHub Action tags

The Action is rooted at repository `action.yml`. Consumers should normally use
the moving compatible-major reference:

```yaml
- uses: Shaurya-Rathore/repoarena@v1
```

For immutable/reproducible workflows use:

```yaml
- uses: Shaurya-Rathore/repoarena@v1.0.0
```

Both `v1.0.0` and `v1` must resolve to the approved release commit before
announcing the Action.

### 9. Fresh install from the public registry

**HUMAN EXECUTION REQUIRED:** run from a new temporary directory after npm
reports `repoarena@1.0.0` publicly. These commands use the registry package, not
the local tarball:

```sh
export REPOARENA_LAUNCH_SMOKE="$(mktemp -d)"
cd "$REPOARENA_LAUNCH_SMOKE"
npm init -y
npm install --save-exact repoarena@1.0.0 --registry https://registry.npmjs.org/
./node_modules/.bin/repoarena --version
./node_modules/.bin/repoarena --help
git init
git config user.email launch-smoke@example.invalid
git config user.name "RepoArena Launch Smoke"
printf 'fixed\n' > subject.txt
printf 'node_modules/\n.repoarena/state/\n' > .gitignore
git add .
git commit -m fixture
./node_modules/.bin/repoarena init --yes
./node_modules/.bin/repoarena doctor
./node_modules/.bin/repoarena agents detect
./node_modules/.bin/repoarena tasks discover
./node_modules/.bin/repoarena tasks new launch-demo --title "Launch demo" --prompt "Keep subject fixed" --verify 'node -e "process.exit(0)"'
NODE_ENV=test REPOARENA_TEST_ADAPTERS=1 ./node_modules/.bin/repoarena run --agent fake-perfect --report terminal,json,html,junit --output .repoarena/reports
NODE_ENV=test REPOARENA_TEST_ADAPTERS=1 ./node_modules/.bin/repoarena ui
```

The final command intentionally remains in the foreground. Confirm the printed
URL is loopback-only, inspect the run, then stop it with Ctrl-C. This smoke is
deterministic and makes no paid provider call.

### 10. Run one safe GitHub Action smoke

**HUMAN EXECUTION REQUIRED:** add or dispatch a temporary workflow on a trusted
same-repository branch using the example below. It needs no RepoArena Cloud.
Use the coding-agent secret expected by the selected CLI, enforce one attempt,
and do not run it for fork-controlled code.

```yaml
name: RepoArena release smoke
on: workflow_dispatch
permissions:
  contents: read
jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1634ceea73d27597364c9af683
      - uses: Shaurya-Rathore/repoarena@v1.0.0
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          agents: codex
          runs-per-task: "1"
          parallelism: "1"
          max-attempts: "1"
          fail-on-unsolved: "false"
          reports: terminal,json,html,junit
          publish-cloud: "false"
```

Do not use `pull_request_target` to execute untrusted code with secrets. A valid
unsolved attempt still proves Action/adapter integration; do not rerun to seek a
green model result.

### 11. Announce

After the package, immutable tag, Action reference, GitHub Release, public
repository, and fresh-install smoke are confirmed, use the reviewed drafts in
[`../launch/announcements.md`](../launch/announcements.md). External posting is
**HUMAN EXECUTION REQUIRED**.

## Stop conditions

Stop the launch if the approved commit changes, an artifact checksum fails, npm
reports a conflicting package owner/version, `v1.0.0` already points elsewhere,
the Action tags do not resolve to the approved commit, or the fresh public
install differs from the inspected tarball.
