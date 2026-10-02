import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: "utf8" });
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const packetFiles: Record<string, string> = {
	independentTechnicalReview: "config/ipaws-production-evidence/independent-review.json",
	analyticsAccess: "config/ipaws-production-evidence/analytics-access.json",
	dnsReadiness: "config/ipaws-production-evidence/dns-readiness.json",
	metricsSecretReadiness: "config/ipaws-production-evidence/metrics-secret-readiness.json",
	releaseCredentialReadiness: "config/ipaws-production-evidence/release-credential-readiness.json",
	githubEnvironmentReadiness: "config/ipaws-production-evidence/github-environment-readiness.json",
	runnerDiagnostic: "config/ipaws-production-evidence/runner-diagnostic.json",
};
function completeEvidence(manifest: any, phase: "disabled-baseline" | "passive-ingestion") {
	for (const [key, item] of Object.entries(manifest.evidence) as Array<[string, any]>) {
		if (item.status === "verified") continue;
		item.status = "verified";
		item.packetSha256 = phase === "disabled-baseline" && packetFiles[key]
			? sha256(readFileSync(packetFiles[key]))
			: sha256(`${phase}:packet:${key}`);
		item.evidenceSha256 = sha256(`${phase}:${key}:${item.packetSha256}`);
	}
}
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
	it("rejects the legacy production environment and any unreviewed replacement", () => {
		for (const environment of ["ipaws-production", "production", "ipaws-production-release-unreviewed"]) {
			const result = governance((directory) => mutateRelease(directory, (workflow) => { workflow.jobs["deploy-disabled-baseline"].environment = environment; }));
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("release must use the protected ipaws-production-release environment");
		}
	});
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
	it("requires the metrics secret only on the atomic deployment step", () => {
		const missing = governance((directory) => mutateRelease(directory, (workflow) => { delete workflow.jobs["deploy-disabled-baseline"].steps[8].env.IPAWS_METRICS_READ_TOKEN; }));
		expect(missing.status).toBe(1); expect(missing.stderr).toContain("metrics secret must be scoped only to the deployment step");
		const early = governance((directory) => mutateRelease(directory, (workflow) => { workflow.jobs["deploy-disabled-baseline"].steps[4].env = { IPAWS_METRICS_READ_TOKEN: "${{ secrets.IPAWS_METRICS_READ_TOKEN }}" }; }));
		expect(early.status).toBe(1); expect(early.stderr).toContain("metrics secret must not be exposed outside deployment");
		const extra = governance((directory) => mutateRelease(directory, (workflow) => { workflow.jobs["deploy-disabled-baseline"].steps[8].env.UNREVIEWED_SECRET = "${{ secrets.UNREVIEWED_SECRET }}"; }));
		expect(extra.status).toBe(1); expect(extra.stderr).toContain("deployment step environment has unapproved properties");
	});
	it("records metrics-secret readiness without secret material or a self-referential commit", () => {
		const readinessSource = readFileSync("config/ipaws-production-evidence/metrics-secret-readiness.json", "utf8");
		const readiness = JSON.parse(readinessSource);
		expect(Object.keys(readiness).sort()).toEqual([
			"environment", "generation", "minimumRandomBytes", "observedAtUtc", "secretName", "secretValueRetainedInRepository", "secretValueRetrievedForVerification", "storedAs", "workflowDispatched",
		].sort());
		expect(readiness).toMatchObject({
			environment: "ipaws-production-release", secretName: "IPAWS_METRICS_READ_TOKEN", minimumRandomBytes: 32,
			secretValueRetainedInRepository: false, secretValueRetrievedForVerification: false, workflowDispatched: false,
		});
		expect(readinessSource).not.toMatch(/secret(Value|Hash|Digest|Sha256)\s*":\s*"/i);
		const review = JSON.parse(readFileSync("config/ipaws-production-evidence/independent-review.json", "utf8"));
		expect(review.exactCommitAcceptance).toBe("external-workflow-input-after-merge");
		expect(review.reviewedHeadStoredInManifest).toBe(false);
		expect(JSON.stringify(review)).not.toMatch(/[a-f0-9]{40}/);
	});
	it("rejects unsafe readiness semantics even when packet and evidence hashes are recomputed", () => {
		const cases: Array<[string, string, (packet: any) => void]> = [
			["independentTechnicalReview", "independent-review.json", (packet) => { packet.verdict = "changes-required"; }],
			["independentTechnicalReview", "independent-review.json", (packet) => { packet.reviewedHeadStoredInManifest = true; }],
			["metricsSecretReadiness", "metrics-secret-readiness.json", (packet) => { packet.minimumRandomBytes = 1; }],
			["metricsSecretReadiness", "metrics-secret-readiness.json", (packet) => { packet.storedAs = "repository-file"; }],
			["metricsSecretReadiness", "metrics-secret-readiness.json", (packet) => { packet.secretValueRetainedInRepository = true; }],
			["metricsSecretReadiness", "metrics-secret-readiness.json", (packet) => { packet.secretValueRetrievedForVerification = true; }],
			["metricsSecretReadiness", "metrics-secret-readiness.json", (packet) => { packet.workflowDispatched = true; }],
			["githubEnvironmentReadiness", "github-environment-readiness.json", (packet) => { packet.deploymentBranches = ["feature"]; }],
			["githubEnvironmentReadiness", "github-environment-readiness.json", (packet) => { packet.secretNames.push("UNREVIEWED_SECRET"); }],
			["githubEnvironmentReadiness", "github-environment-readiness.json", (packet) => { packet.variableNames.push("IPAWS_PRODUCTION_RELEASE_ENABLED"); }],
			["githubEnvironmentReadiness", "github-environment-readiness.json", (packet) => { packet.releaseEnableGatePresent = true; }],
			["githubEnvironmentReadiness", "github-environment-readiness.json", (packet) => { packet.workflowDispatched = true; }],
			["githubEnvironmentReadiness", "github-environment-readiness.json", (packet) => { packet.extra = "bypass"; }],
			["releaseCredentialReadiness", "release-credential-readiness.json", (packet) => { packet.permissions.push("KV Storage:Edit"); }],
			["releaseCredentialReadiness", "release-credential-readiness.json", (packet) => { packet.expiresOn = "2027-10-09"; }],
			["releaseCredentialReadiness", "release-credential-readiness.json", (packet) => { packet.tokenValueRetrievedForVerification = true; }],
			["runnerDiagnostic", "runner-diagnostic.json", (packet) => { packet.laterStepsExecuted = true; }],
			["runnerDiagnostic", "runner-diagnostic.json", (packet) => { packet.failureClass = "unknown"; }],
		];
		for (const [key, filename, mutate] of cases) {
			const scratch = mkdtempSync(resolve(tmpdir(), "readiness-semantics-"));
			try {
				const packetDirectory = resolve(scratch, "packets");
				cpSync("config/ipaws-production-evidence", packetDirectory, { recursive: true });
				const packetPath = resolve(packetDirectory, filename);
				const packet = JSON.parse(readFileSync(packetPath, "utf8")); mutate(packet); writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
				const manifest = JSON.parse(readFileSync("config/ipaws-production-disabled-baseline-evidence.json", "utf8"));
				manifest.evidence[key].packetSha256 = sha256(readFileSync(packetPath));
				manifest.evidence[key].evidenceSha256 = sha256(`disabled-baseline:${key}:${manifest.evidence[key].packetSha256}`);
				const evidencePath = resolve(scratch, "evidence.json"); writeFileSync(evidencePath, JSON.stringify(manifest));
				expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--require-complete", `--evidence=${evidencePath}`, `--packet-dir=${packetDirectory}`]).status).toBe(1);
			} finally { rmSync(scratch, { recursive: true, force: true }); }
		}
	});
	it("uploads the metrics secret atomically without exposing it to Wrangler's environment and removes the temporary file", () => {
		const scratch = mkdtempSync(resolve(tmpdir(), "ipaws-deploy-wrapper-"));
		const deployedVersionFile = "/tmp/ipaws-production-deployed-version";
		try {
			mkdirSync(resolve(scratch, "scripts")); mkdirSync(resolve(scratch, "node_modules/.bin"), { recursive: true });
			copyFileSync("scripts/deploy-ipaws-production-disabled-baseline.mjs", resolve(scratch, "scripts/deploy-ipaws-production-disabled-baseline.mjs"));
			const fakeWrangler = resolve(scratch, "node_modules/.bin/wrangler");
			writeFileSync(fakeWrangler, `#!/usr/bin/env node\nimport { readFileSync, statSync, writeFileSync } from "node:fs";\nconst index = process.argv.indexOf("--secrets-file");\nconst secretFile = process.argv[index + 1];\nconst parsed = JSON.parse(readFileSync(secretFile, "utf8"));\nwriteFileSync(process.env.IPAWS_DEPLOY_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), secretFile, mode: statSync(secretFile).mode & 0o777, tokenBytes: Buffer.byteLength(parsed.IPAWS_METRICS_READ_TOKEN), envExposed: process.env.IPAWS_METRICS_READ_TOKEN !== undefined }));\nconsole.log("Current Version ID: 11111111-1111-4111-8111-111111111111");\n`);
			chmodSync(fakeWrangler, 0o700);
			const capture = resolve(scratch, "capture.json");
			const secret = "s".repeat(32);
			const result = spawnSync(process.execPath, [resolve(scratch, "scripts/deploy-ipaws-production-disabled-baseline.mjs")], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, APPROVED_COMMIT: "a".repeat(40), IPAWS_METRICS_READ_TOKEN: secret, IPAWS_DEPLOY_TEST_CAPTURE: capture } });
			expect(result.status).toBe(0); expect(result.stdout).not.toContain(secret); expect(result.stderr).not.toContain(secret);
			const observed = JSON.parse(readFileSync(capture, "utf8"));
			expect(observed.args).toContain("--secrets-file"); expect(observed.mode).toBe(0o600); expect(observed.tokenBytes).toBe(32); expect(observed.envExposed).toBe(false);
			expect(existsSync(observed.secretFile)).toBe(false);
		} finally { rmSync(scratch, { recursive: true, force: true }); rmSync(deployedVersionFile, { force: true }); }
	});
	it("refuses a missing or short metrics secret before invoking Wrangler", () => {
		for (const secret of ["", "short"]) {
			const result = spawnSync(process.execPath, ["scripts/deploy-ipaws-production-disabled-baseline.mjs"], { encoding: "utf8", env: { ...process.env, APPROVED_COMMIT: "a".repeat(40), IPAWS_METRICS_READ_TOKEN: secret } });
			expect(result.status).toBe(1); expect(result.stderr).toBe("metrics_secret_invalid\n");
		}
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
			const config = readFileSync("wrangler.ipaws.production.jsonc", "utf8").replace("alabamabeachflag-ipaws-production", "secret-worker-name").replace("9c56e6dc43b14cf091ca8f7211123fca", "1234567890abcdef1234567890abcdef").replace('"IPAWS_ALLOWED_TOPIC_ARNS": ""', '"IPAWS_ALLOWED_TOPIC_ARNS": "arn:aws:sns:us-east-1:123456789012:sensitive-topic"');
			const path = resolve(scratch, "config.jsonc"); writeFileSync(path, config);
			const result = run(["scripts/report-ipaws-production-inputs.mjs", `--config=${path}`]);
			expect(result.status).toBe(0); expect(result.stdout).not.toMatch(/secret-worker-name|1234567890abcdef|sensitive-topic|arn:aws/);
			expect(JSON.parse(result.stdout).configuration).toContainEqual({ field: "aws.topicArn", status: "configured" });
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	});
	it("reports the empty TopicArn allowlist only as the fixed deny-all status", () => {
		const result = run(["scripts/report-ipaws-production-inputs.mjs"]);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).configuration).toContainEqual({ field: "aws.topicArn", status: "deny_all_pending_fema" });
	});
	it("keeps disabled-baseline and passive-ingestion evidence complete, distinct, and phase-bound", () => {
		const template = run(["scripts/validate-ipaws-production-evidence.mjs"]); expect(template.status).toBe(0);
		expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--phase=passive-ingestion"]).status).toBe(1);
		expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--require-complete"]).status).toBe(0);
		const scratch = mkdtempSync(resolve(tmpdir(), "evidence-"));
		try {
			const configSource = readFileSync("wrangler.ipaws.production.jsonc", "utf8");
			const baseline = JSON.parse(readFileSync("config/ipaws-production-disabled-baseline-evidence.json", "utf8"));
			baseline.configurationSha256 = sha256(configSource);
			completeEvidence(baseline, "disabled-baseline");
			const baselinePath = resolve(scratch, "baseline.json"); writeFileSync(baselinePath, JSON.stringify(baseline));
			expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--phase=disabled-baseline", "--require-complete", `--evidence=${baselinePath}`]).status).toBe(0);

			const passiveConfig = configSource.replace('"IPAWS_INGESTION_ENABLED": "false"', '"IPAWS_INGESTION_ENABLED": "true"').replace('"IPAWS_ALLOWED_TOPIC_ARNS": ""', '"IPAWS_ALLOWED_TOPIC_ARNS": "arn:aws:sns:us-east-1:123456789012:reviewed-topic"');
			const configPath = resolve(scratch, "passive.jsonc"); writeFileSync(configPath, passiveConfig);
			const passive = JSON.parse(readFileSync("config/ipaws-production-passive-ingestion-evidence.json", "utf8"));
			passive.configurationSha256 = sha256(passiveConfig);
			completeEvidence(passive, "passive-ingestion");
			passive.disabledBaseline.configurationSha256 = baseline.configurationSha256;
			passive.disabledBaseline.evidenceManifestSha256 = sha256(readFileSync(baselinePath));
			passive.disabledBaseline.deploymentPacketSha256 = sha256("verified-deployment-readback");
			const deploymentPacket = sha256(`disabled-baseline-deployment:${passive.disabledBaseline.configurationSha256}:${passive.disabledBaseline.evidenceManifestSha256}:${passive.disabledBaseline.deploymentPacketSha256}`);
			passive.evidence.disabledBaselineDeployment.packetSha256 = deploymentPacket;
			passive.evidence.disabledBaselineDeployment.evidenceSha256 = sha256(`passive-ingestion:disabledBaselineDeployment:${deploymentPacket}`);
			const passivePath = resolve(scratch, "passive.json"); writeFileSync(passivePath, JSON.stringify(passive));
			const baselineConfigPath = resolve(scratch, "baseline.jsonc"); writeFileSync(baselineConfigPath, configSource);
			expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--phase=passive-ingestion", "--require-complete", `--config=${configPath}`, `--evidence=${passivePath}`, `--baseline-evidence=${baselinePath}`, `--baseline-config=${baselineConfigPath}`]).status).toBe(0);
			expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--phase=passive-ingestion", `--config=${configPath}`, `--evidence=${baselinePath}`]).status).toBe(1);
			expect(run(["scripts/validate-ipaws-production-evidence.mjs", "--phase=disabled-baseline", `--evidence=${passivePath}`]).status).toBe(1);
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	});
	it("rejects invalid digests and not-applicable evidence markers", () => {
		const scratch = mkdtempSync(resolve(tmpdir(), "evidence-digest-"));
		try {
			const evidence = JSON.parse(readFileSync("config/ipaws-production-disabled-baseline-evidence.json", "utf8"));
			evidence.evidence.resourceIsolation.evidenceSha256 = "invalid";
			const path = resolve(scratch, "evidence.json"); writeFileSync(path, JSON.stringify(evidence));
			const result = run(["scripts/validate-ipaws-production-evidence.mjs", `--evidence=${path}`]);
			expect(result.status).toBe(1); expect(result.stderr).toContain("not bound to its phase and requirement");
			evidence.evidence.resourceIsolation = { status: "not-applicable", packetSha256: null, evidenceSha256: null };
			writeFileSync(path, JSON.stringify(evidence));
			expect(run(["scripts/validate-ipaws-production-evidence.mjs", `--evidence=${path}`]).status).toBe(1);
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	});
	it("rejects downgraded baseline prerequisites, owner drift, and evidence reuse", () => {
		const scratch = mkdtempSync(resolve(tmpdir(), "phase-bypass-"));
		try {
			const baselineConfig = readFileSync("wrangler.ipaws.production.jsonc", "utf8");
			const passiveConfig = baselineConfig.replace('"IPAWS_INGESTION_ENABLED": "false"', '"IPAWS_INGESTION_ENABLED": "true"').replace('"IPAWS_ALLOWED_TOPIC_ARNS": ""', '"IPAWS_ALLOWED_TOPIC_ARNS": "arn:aws:sns:us-east-1:123456789012:reviewed-topic"');
			const baselineConfigPath = resolve(scratch, "baseline.jsonc"); writeFileSync(baselineConfigPath, baselineConfig);
			const passiveConfigPath = resolve(scratch, "passive.jsonc"); writeFileSync(passiveConfigPath, passiveConfig);
			const originalBaseline = JSON.parse(readFileSync("config/ipaws-production-disabled-baseline-evidence.json", "utf8"));
			originalBaseline.configurationSha256 = sha256(baselineConfig); completeEvidence(originalBaseline, "disabled-baseline");
			const originalPassive = JSON.parse(readFileSync("config/ipaws-production-passive-ingestion-evidence.json", "utf8"));
			originalPassive.configurationSha256 = sha256(passiveConfig); completeEvidence(originalPassive, "passive-ingestion");
			originalPassive.disabledBaseline.configurationSha256 = originalBaseline.configurationSha256;
			originalPassive.disabledBaseline.deploymentPacketSha256 = sha256("verified-deployment-readback");
			const check = (mutateBaseline: (value: any) => void, mutatePassive: (value: any) => void = () => undefined) => {
				const baseline = structuredClone(originalBaseline); const passive = structuredClone(originalPassive);
				mutateBaseline(baseline);
				const baselinePath = resolve(scratch, "baseline-evidence.json"); writeFileSync(baselinePath, JSON.stringify(baseline));
				passive.disabledBaseline.evidenceManifestSha256 = sha256(readFileSync(baselinePath));
				const deploymentPacket = sha256(`disabled-baseline-deployment:${passive.disabledBaseline.configurationSha256}:${passive.disabledBaseline.evidenceManifestSha256}:${passive.disabledBaseline.deploymentPacketSha256}`);
				passive.evidence.disabledBaselineDeployment.packetSha256 = deploymentPacket;
				passive.evidence.disabledBaselineDeployment.evidenceSha256 = sha256(`passive-ingestion:disabledBaselineDeployment:${deploymentPacket}`);
				mutatePassive(passive);
				const passivePath = resolve(scratch, "passive-evidence.json"); writeFileSync(passivePath, JSON.stringify(passive));
				return run(["scripts/validate-ipaws-production-evidence.mjs", "--phase=passive-ingestion", "--require-complete", `--config=${passiveConfigPath}`, `--evidence=${passivePath}`, `--baseline-evidence=${baselinePath}`, `--baseline-config=${baselineConfigPath}`]);
			};
			expect(check((value) => { value.owners.monitoring = "another-owner"; }).status).toBe(1);
			expect(check((value) => { delete value.owners.rollback; }).status).toBe(1);
			expect(check((value) => { value.extra = true; }).status).toBe(1);
			expect(check((value) => { value.evidence.resourceIsolation.extra = true; }).status).toBe(1);
			expect(check((value) => { value.configurationSha256 = "c".repeat(64); }, (value) => { value.disabledBaseline.configurationSha256 = "c".repeat(64); }).status).toBe(1);
			expect(check(() => undefined, (value) => { value.disabledBaseline.deploymentPacketSha256 = "d".repeat(64); }).status).toBe(1);
			expect(check(() => undefined, (value) => {
				value.evidence.femaProductionTopic.packetSha256 = value.evidence.awsPartitionAndRegion.packetSha256;
				value.evidence.femaProductionTopic.evidenceSha256 = sha256(`passive-ingestion:femaProductionTopic:${value.evidence.femaProductionTopic.packetSha256}`);
			}).status).toBe(1);
			expect(check(() => undefined, (value) => {
				value.evidence.femaProductionTopic.packetSha256 = originalBaseline.evidence.resourceIsolation.packetSha256;
				value.evidence.femaProductionTopic.evidenceSha256 = sha256(`passive-ingestion:femaProductionTopic:${value.evidence.femaProductionTopic.packetSha256}`);
			}).status).toBe(1);
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	});
	it("reports passive ingestion as blocked by an empty TopicArn and disabled ingestion", () => {
		const result = run(["scripts/report-ipaws-production-inputs.mjs", "--phase=passive-ingestion", "--require-configured"]);
		expect(result.status).toBe(1);
		const report = JSON.parse(result.stdout);
		expect(report.phase).toBe("passive-ingestion");
		expect(report.configuration).toContainEqual({ field: "aws.topicArn", status: "deny_all_pending_fema" });
		expect(report.safetyBaseline).toContainEqual({ field: "passive-ingestion.IPAWS_INGESTION_ENABLED", status: "unsafe" });
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
			routes: { result: [{ script: "alabamabeachflag-ipaws-production", pattern: "ipaws.alabamabeachflag.com/v1/ipaws/*" }] }, domains: { result: [] },
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
