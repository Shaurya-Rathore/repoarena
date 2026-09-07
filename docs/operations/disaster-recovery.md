# Disaster recovery

RepoArena assumes operator-managed PostgreSQL backups and independently
versioned S3-compatible object storage. A database dump does not contain
artifact bytes. Back up both, retain timestamps/checksums, and regularly restore
into an isolated environment.

For database loss, stop mutating services, restore the latest verified dump,
apply forward migrations, validate readiness, reconcile object metadata, then
resume workers. For object loss, preserve database history, restore bucket
versions, and classify missing or checksum-mismatched artifacts as unavailable.
Unreferenced objects are quarantined; cleanup may delete only server-generated
managed keys.

GitHub, Stripe, and hosted-provider outages must not corrupt canonical runs.
Durable deliveries/jobs retry with bounded backoff. Rotate compromised API or
runner tokens through revocation APIs. Rotate GitHub App keys and webhook
secrets in GitHub plus the secret store; rotate Stripe endpoints during a
controlled overlap; rotate database, S3, hosted-provider, OAuth, and session
credentials through the deployment secret manager.

No contractual RPO/RTO is claimed by the open-source distribution. Operators
set targets from backup frequency, provider durability, dataset size, and
restore drills. The deterministic drill is `pnpm release:backup-restore`.
