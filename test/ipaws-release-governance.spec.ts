import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
function governance(mutate?: (directory: string) => void) {
	const scratch = mkdtempSync(resolve(tmpdir(), "release-governance-"));
	try { cpSync(".github/workflows", scratch, { recursive: true }); mutate?.(scratch); return run(["scripts/validate-production-release-governance.mjs", `--workflow-dir=${scratch}`]); }
	finally { rmSync(scratch, { recursive: true, force: true }); }
}
function mutateRelease(directory: string, change: (workflow: any) => void) {
	const file = resolve(directory, "ipaws-production-disabled-baseline.yml");
	const workflow = JSON.parse(readFileSync(file, "utf8")); change(workflow); writeFileSync(file, JSON.stringify(workflow));
}

describe("production release governance", () => {
	it("accepts the strict manual fail-closed release path", () => expect(governance().status).toBe(0));
	for (const trigger of ["push", "repository_dispatch", "workflow_call", "pull_request_target", "issue_comment"]) {
		it(`rejects ${trigger} as a production trigger`, () => {
			const result = governance((directory) => mutateRelease(directory, (workflow) => { workflow.on[trigger] = {}; }));
			expect(result.status).toBe(1); expect(result.stderr).toContain("release trigger has unapproved properties");
		});
	}
	for (const command of ["npx wrangler deploy --config wrangler.jsonc", "npx wrangler versions deploy abc", "npx wrangler rollback", "npm run deploy", "curl https://api.cloudflare.com/client/v4/accounts/x/workers/scripts/x"]) {
		it(`rejects deployment-capable CI command: ${command.split(" ").slice(0, 3).join(" ")}`, () => {
			const result = governance((directory) => writeFileSync(resolve(directory, "ipaws-staging.yml"), `${readFileSync(resolve(directory, "ipaws-staging.yml"), "utf8")}\n      - run: ${command}\n`));
			expect(result.status).toBe(1); expect(result.stderr).toContain("deployment-capable mechanism");
		});
	}
	it("rejects credential exposure before deployment", () => {
		const result = governance((directory) => mutateRelease(directory, (workflow) => { workflow.jobs["deploy-disabled-baseline"].steps[4].env = { CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" }; }));
		expect(result.status).toBe(1); expect(result.stderr).toContain("deployment credential is exposed before deployment");
	});
	it("requires the final immutable-tree recheck", () => {
		const result = governance((directory) => mutateRelease(directory, (workflow) => { workflow.jobs["deploy-disabled-baseline"].steps[6].run = "true"; }));
		expect(result.status).toBe(1); expect(result.stderr).toContain("missing required gate");
	});
	it("refuses the ordinary npm deploy entry point", () => {
		const result = run(["scripts/refuse-direct-production-deploy.mjs"]); expect(result.status).toBe(1); expect(result.stderr).toContain("disabled");
	});
	it("emits only statuses even when configuration contains realistic identifiers", () => {
		const scratch = mkdtempSync(resolve(tmpdir(), "inventory-"));
		try {
			const config = readFileSync("wrangler.ipaws.production.jsonc", "utf8").replace("ipaws-production-placeholder", "secret-worker-name").replace("00000000000000000000000000000000", "1234567890abcdef1234567890abcdef").replace("__IPAWS_PRODUCTION_TOPIC_ARN__", "arn:aws:sns:us-east-1:123456789012:sensitive-topic");
			const path = resolve(scratch, "config.jsonc"); writeFileSync(path, config);
			const result = run(["scripts/report-ipaws-production-inputs.mjs", `--config=${path}`]);
			expect(result.status).toBe(0); expect(result.stdout).not.toMatch(/secret-worker-name|1234567890abcdef|sensitive-topic|arn:aws/);
			expect(JSON.parse(result.stdout).configuration).toContainEqual({ field: "aws.topicArn", status: "deny_all_pending_fema" });
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	});
	it("requires pinned verified evidence and assigned owners", () => {
		const template = run(["scripts/validate-ipaws-production-evidence.mjs"]); expect(template.status).toBe(0);
		expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--require-complete"]).status).toBe(1);
		const scratch = mkdtempSync(resolve(tmpdir(), "evidence-"));
		try {
			const evidence = JSON.parse(readFileSync("config/ipaws-production-evidence.json", "utf8"));
			evidence.configurationSha256 = createHash("sha256").update(readFileSync("wrangler.ipaws.production.jsonc")).digest("hex");
			for (const item of Object.values(evidence.evidence) as any[]) { item.status = "verified"; item.evidenceSha256 = "a".repeat(64); }
			for (const key of Object.keys(evidence.owners)) evidence.owners[key] = `owner:${key}`;
			const path = resolve(scratch, "evidence.json"); writeFileSync(path, JSON.stringify(evidence));
			expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--require-complete", `--evidence=${path}`]).status).toBe(0);
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	});
});

describe("sanitized post-deployment verification", () => {
	function fixture(change?: (documents: Record<string, any>) => void) {
		const scratch = mkdtempSync(resolve(tmpdir(), "deployment-fixture-"));
		const configSource = readFileSync("wrangler.ipaws.production.jsonc", "utf8");
		const config = JSON.parse(configSource.replace(/^\s*\/\/.*$/gm, ""));
		const docs: Record<string, any> = {
			deployment: { versions: [{ version_id: "11111111-1111-4111-8111-111111111111", percentage: 100 }] },
			version: { id: "11111111-1111-4111-8111-111111111111", annotations: { "workers/tag": "a".repeat(40) }, resources: { script_runtime: { compatibility_date: "2026-06-27", compatibility_flags: ["nodejs_compat"], migration_tag: "ipaws-production-idempotency-v1" }, bindings: [
				{ name: "BEACH_DATA", type: "kv_namespace", namespace_id: config.kv_namespaces[0].id },
				{ name: "IPAWS_IDEMPOTENCY", type: "durable_object_namespace", class_name: "IpawsIdempotencyCoordinator", namespace_id: "dedicated-production-do" },
				{ name: "IPAWS_METRICS_READ_TOKEN", type: "secret_text" },
				...Object.entries(config.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
			] } },
			routes: { result: [{ script: "ipaws-production-placeholder", pattern: "ipaws-production.invalid/v1/ipaws/*" }] }, domains: { result: [] },
			"protected-durable-ids": ["staging-do", "general-production-do"],
		};
		change?.(docs); for (const [name, value] of Object.entries(docs)) writeFileSync(resolve(scratch, `${name}.json`), JSON.stringify(value)); return scratch;
	}
	it("accepts exact state and rejects resource, type, value, secret, traffic, and provenance drift", () => {
		const cases: Array<[(docs: Record<string, any>) => void, string]> = [
			[(docs) => docs.version.resources.bindings.push({ name: "SECRET_BINDING", type: "secret_text" }), "unexpected_binding"],
			[(docs) => docs.version.resources.bindings.find((item: any) => item.name === "BEACH_DATA").namespace_id = "wrong-kv", "kv_binding_mismatch"],
			[(docs) => docs.version.resources.bindings.find((item: any) => item.name === "BEACH_DATA").type = "plain_text", "kv_binding_mismatch"],
			[(docs) => docs.version.resources.bindings.find((item: any) => item.name === "IPAWS_IDEMPOTENCY").class_name = "WrongClass", "durable_binding_mismatch"],
			[(docs) => docs["protected-durable-ids"].push("dedicated-production-do"), "durable_resource_crossover"],
			[(docs) => docs.version.resources.bindings.splice(docs.version.resources.bindings.findIndex((item: any) => item.name === "IPAWS_METRICS_READ_TOKEN"), 1), "unexpected_binding"],
			[(docs) => docs.version.resources.bindings.find((item: any) => item.name === "IPAWS_METRICS_READ_TOKEN").type = "plain_text", "metrics_secret_binding_mismatch"],
			[(docs) => docs.version.resources.bindings.find((item: any) => item.name === "IPAWS_ENVIRONMENT").text = "staging", "variable_binding_mismatch"],
			[(docs) => docs.version.resources.bindings.find((item: any) => item.name === "IPAWS_ENVIRONMENT").type = "secret_text", "variable_binding_mismatch"],
			[(docs) => docs.deployment.versions[0].version_id = "22222222-2222-4222-8222-222222222222", "traffic_or_version_mismatch"],
			[(docs) => docs.version.annotations["workers/tag"] = "b".repeat(40), "approved_commit_tag_mismatch"],
		];
		const good = fixture();
		try { expect(run(["scripts/verify-ipaws-production-deployment.mjs", `--fixture=${good}`]).status).toBe(0); }
		finally { rmSync(good, { recursive: true, force: true }); }
		for (const [change, code] of cases) {
			const bad = fixture(change);
			try { const result = run(["scripts/verify-ipaws-production-deployment.mjs", `--fixture=${bad}`]); expect(result.status).toBe(1); expect(result.stderr).toContain(code); expect(result.stderr).not.toMatch(/SECRET_BINDING|wrong-kv|sensitive-version|dedicated-production-do/); }
			finally { rmSync(bad, { recursive: true, force: true }); }
		}
	});
});
