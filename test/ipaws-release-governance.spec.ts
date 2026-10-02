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
		const vars = [...configSource.matchAll(/"(IPAWS_[A-Z_]+)"\s*:/g)].map((match) => match[1]);
		const docs: Record<string, any> = {
			deployment: { versions: [{ version_id: "sensitive-version", percentage: 100 }] },
			version: { compatibility_date: "2026-06-27", compatibility_flags: ["nodejs_compat"], migration_tag: "ipaws-production-idempotency-v1", resources: { bindings: [{ name: "BEACH_DATA" }, { name: "IPAWS_IDEMPOTENCY" }, ...vars.map((name) => ({ name }))] } },
			routes: { result: [{ script: "ipaws-production-placeholder", pattern: "ipaws-production.invalid/v1/ipaws/*" }] }, domains: { result: [] },
		};
		change?.(docs); for (const [name, value] of Object.entries(docs)) writeFileSync(resolve(scratch, `${name}.json`), JSON.stringify(value)); return scratch;
	}
	it("accepts exact state and rejects drift without disclosing identifiers", () => {
		const good = fixture(), bad = fixture((docs) => docs.version.resources.bindings.push({ name: "SECRET_BINDING", text: "sensitive-value" }));
		try {
			expect(run(["scripts/verify-ipaws-production-deployment.mjs", `--fixture=${good}`]).status).toBe(0);
			const result = run(["scripts/verify-ipaws-production-deployment.mjs", `--fixture=${bad}`]); expect(result.status).toBe(1); expect(result.stderr).toContain("unexpected_binding"); expect(result.stderr).not.toMatch(/SECRET_BINDING|sensitive-value|sensitive-version/);
		} finally { rmSync(good, { recursive: true, force: true }); rmSync(bad, { recursive: true, force: true }); }
	});
});
