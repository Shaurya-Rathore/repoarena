import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configured = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "::1"].includes(configured.hostname))
	throw new Error("Backup E2E requires loopback PostgreSQL");
configured.pathname = "/repoarena_test";
const source = configured.toString();
const restoreUrl = new URL(source);
restoreUrl.pathname = "/repoarena_restore_test";
const restore = restoreUrl.toString();
const admin = process.env.DATABASE_URL;
const temporary = await mkdtemp(join(tmpdir(), "repoarena-backup-"));
const dump = join(temporary, "repoarena.dump");
const run = (command, args, options = {}) =>
	execFileSync(command, args, { stdio: "pipe", encoding: "utf8", ...options });
const sql = String.raw`
INSERT INTO users(id,provider,provider_subject,display_name) VALUES ('10000000-0000-4000-8000-000000000001','release','release-owner','Release Owner');
INSERT INTO organizations(id,slug,display_name,plan_id) VALUES ('20000000-0000-4000-8000-000000000001','release-fixture','Release Fixture','ENTERPRISE');
INSERT INTO memberships(organization_id,user_id,role) VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','OWNER');
INSERT INTO repositories(id,organization_id,provider,external_id,owner_name,repository_name,default_branch,visibility,public_id) VALUES ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','github','1001','repoarena','release-fixture','main','PUBLIC','rar_releasefixture00000001');
INSERT INTO tasks(id,organization_id,repository_id,task_key,title) VALUES ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','release-task','Release task');
INSERT INTO task_versions(id,task_id,version,content_hash,public_task,validation_state) VALUES ('41000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',1,repeat('a',64),'{}','READY');
INSERT INTO benchmarks(id,organization_id,repository_id,name) VALUES ('50000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Release benchmark');
INSERT INTO benchmark_versions(id,benchmark_id,version,config_hash,configuration) VALUES ('51000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',1,repeat('b',64),'{}');
INSERT INTO benchmark_version_tasks(benchmark_version_id,task_version_id,ordinal) VALUES ('51000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001',0);
INSERT INTO benchmark_runs(id,organization_id,repository_id,benchmark_version_id,state,canonical_result,result_hash) VALUES ('60000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','COMPLETED','{"schema":"repoarena.run/v1","statistics":{"solved_count":1,"attempt_count":1}}',repeat('c',64));
INSERT INTO github_installations(id,organization_id,github_installation_id,github_account_id,account_login,account_type,repository_selection,state) VALUES ('70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',1001,1002,'repoarena','Organization','selected','ACTIVE');
INSERT INTO public_run_publications(id,public_id,organization_id,repository_id,benchmark_run_id,state,repository_projection,run_projection,methodology_version,publisher_type,publisher_id,published_at) VALUES ('80000000-0000-4000-8000-000000000001','rap_releasefixture00000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','PUBLISHED','{}','{}','1','USER','10000000-0000-4000-8000-000000000001',now());
INSERT INTO billing_customers(id,organization_id,provider,provider_customer_id) VALUES ('90000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','STRIPE','cus_release_fixture');
INSERT INTO billing_subscriptions(id,organization_id,billing_customer_id,provider,provider_subscription_id,plan_id,provider_price_id,billing_interval,provider_status,status,provider_event_created_at,last_provider_event_id) VALUES ('91000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','STRIPE','sub_release_fixture','ENTERPRISE','price_release','MONTHLY','active','ACTIVE',now(),'evt_release');
INSERT INTO jobs(id,organization_id,benchmark_run_id,type,payload,state) VALUES ('a0000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','BENCHMARK','{}','SUCCEEDED');
INSERT INTO hosted_execution_leases(id,organization_id,benchmark_run_id,job_id,provider,provider_resource_id,resource_class_id,resource_class_version,state,managed_identity,network_policy,max_wall_time_ms,pricing_snapshot,estimated_cost_micros,terminated_at) VALUES ('b0000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','deterministic','resource-release','SMALL',1,'TERMINATED','{}','NETWORK_DISABLED',60000,'{"version":"release-v1"}',12000,now());
INSERT INTO hosted_compute_usage(id,hosted_execution_lease_id,organization_id,benchmark_run_id,provider,resource_class_id,resource_class_version,billable_duration_ms,pricing_snapshot,cost_micros,final_state) VALUES ('c0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','deterministic','SMALL',1,60000,'{"version":"release-v1"}',12000,'TERMINATED');
`;
try {
	run("psql", [
		source,
		"-v",
		"ON_ERROR_STOP=1",
		"-c",
		"DROP SCHEMA public CASCADE; CREATE SCHEMA public",
	]);
	run("node", ["scripts/db-migrate.mjs"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, DATABASE_URL: source },
	});
	run("psql", [source, "-v", "ON_ERROR_STOP=1", "-c", sql]);
	run("pg_dump", [
		"--format=custom",
		"--no-owner",
		"--no-acl",
		"--dbname",
		source,
		"--file",
		dump,
	]);
	run("dropdb", [
		"--if-exists",
		"--maintenance-db",
		admin,
		"repoarena_restore_test",
	]);
	run("createdb", [
		"--maintenance-db",
		admin,
		"--owner",
		configured.username,
		"repoarena_restore_test",
	]);
	run("pg_restore", [
		"--exit-on-error",
		"--no-owner",
		"--no-acl",
		"--dbname",
		restore,
		dump,
	]);
	const query =
		"SELECT (SELECT count(*) FROM organizations),(SELECT count(*) FROM benchmark_runs),(SELECT count(*) FROM billing_subscriptions),(SELECT count(*) FROM github_installations),(SELECT count(*) FROM hosted_compute_usage),(SELECT count(*) FROM public_run_publications),(SELECT count(*) FROM schema_migrations)";
	const before = run("psql", [source, "-At", "-c", query]).trim();
	const after = run("psql", [restore, "-At", "-c", query]).trim();
	if (before !== "1|1|1|1|1|1|8" || after !== before)
		throw new Error(`Backup mismatch: ${before} != ${after}`);
	process.stdout.write(`BACKUP_RESTORE_E2E_OK ${after}\n`);
} finally {
	run("dropdb", [
		"--if-exists",
		"--maintenance-db",
		admin,
		"repoarena_restore_test",
	]);
	await rm(temporary, { recursive: true, force: true });
}
