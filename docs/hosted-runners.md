# Hosted runners

RepoArena-hosted execution is optional. Local, self-hosted, and GitHub Actions
runners continue to use the same benchmark and cloud job protocols.

## Lifecycle and isolation

A hosted request creates one durable execution lease for an existing benchmark
job. Capacity and worst-case cost are reserved transactionally before the
provider is called. The provider receives opaque RepoArena labels and a bootstrap
credential; it never receives repository names, task text, evaluator-private
material, Stripe credentials, or long-lived control-plane credentials. The
bootstrapped runner must heartbeat and claim the exact job through the existing
runner API. Completion, cancellation, loss, or absolute timeout revokes the
runner and terminates the resource.

`SMALL`, `MEDIUM`, and `LARGE` are versioned server resource classes. They set
CPU, memory, disk, process, log, artifact, wall-time, and permitted network
ceilings. The default policy is `NETWORK_DISABLED`; restricted egress must be
explicitly requested and supported by the selected class.

## Cost and limits

Hosted compute is distinct from both the RepoArena subscription and model
provider usage. Model inference remains BYOK and is paid directly to the model
provider. Hosted estimates use the versioned resource-class price snapshot;
unknown pricing disables provisioning rather than appearing as zero. Every
request requires a hard compute budget and remains subject to entitlement,
global capacity, organization concurrency, monthly budget, and queued-job caps.

Production provisioning defaults off. Operators enable it through
`hosted_compute_settings`, can activate the emergency stop immediately, and can
suspend one organization through `organization_hosted_policies`. Downgraded or
past-due organizations are checked through current canonical entitlements at
request time, including schedules, optimizer runs, and GitHub triggers.

## Operations

Apply migrations with `pnpm db:migrate`. Configure the HTTPS provisioner using
`HOSTED_COMPUTE_PROVISIONER_URL` and `HOSTED_COMPUTE_PROVISIONER_TOKEN`, then run
the API normally. Reconcile stale leases and managed provider resources with
`pnpm hosted:reconcile`. Reconciliation only terminates resources whose
`managed_by`, environment, deployment, and lease labels match this deployment.

Normal tests never provision infrastructure. An explicit provider smoke test is
available with `REPOARENA_REAL_HOSTED_COMPUTE_TESTS=1`,
`HOSTED_COMPUTE_TEST_ENVIRONMENT=test`, and dedicated provisioner credentials:

```sh
pnpm hosted:provider-smoke
```

It uses `SMALL`, a five-minute hard ceiling, test labels, and force termination
in a `finally` block.
