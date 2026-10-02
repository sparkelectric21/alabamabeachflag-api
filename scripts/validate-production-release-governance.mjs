import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowDirectory = resolve(root, process.argv.find((value) => value.startsWith("--workflow-dir="))?.slice(15) ?? ".github/workflows");
const packagePath = resolve(root, process.argv.find((value) => value.startsWith("--package="))?.slice(10) ?? "package.json");
const releaseName = "ipaws-production-disabled-baseline.yml";
const allowedWorkflowNames = new Set([releaseName, "ipaws-staging.yml"]);
const failures = [];
const fail = (condition, message) => { if (condition) failures.push(message); };
const exactKeys = (value, keys, label) => fail(!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== [...keys].sort().join(","), `${label} has unapproved properties`);
const files = readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/i.test(name));

for (const name of files) fail(!allowedWorkflowNames.has(name), `unreviewed workflow file is forbidden: ${name}`);
let workflow;
try {
	const releaseSource = readFileSync(resolve(workflowDirectory, releaseName), "utf8");
	fail(createHash("sha256").update(releaseSource).digest("hex") !== "8ee013bb824ddd5463de4fc558103dcf4eb96c129a97b9a45638adb882b096f1", "manual release workflow differs byte-for-byte from the reviewed definition");
	workflow = JSON.parse(releaseSource);
} catch { failures.push(`missing or non-canonical manual release workflow: ${releaseName}`); }

if (workflow) {
	exactKeys(workflow, ["name", "on", "permissions", "concurrency", "jobs"], "release workflow");
	exactKeys(workflow.on, ["workflow_dispatch"], "release trigger");
	exactKeys(workflow.permissions, ["contents"], "release permissions");
	fail(workflow.permissions?.contents !== "read", "release workflow permissions must be contents: read");
	exactKeys(workflow.jobs, ["deploy-disabled-baseline"], "release jobs");
	const job = workflow.jobs?.["deploy-disabled-baseline"];
	exactKeys(job, ["if", "runs-on", "timeout-minutes", "environment", "env", "steps"], "release job");
	fail(job?.if !== "github.ref == 'refs/heads/main'", "release must run only from main");
	fail(job?.environment !== "ipaws-production", "release must use the protected ipaws-production environment");
	fail(job?.["runs-on"] !== "ubuntu-latest", "release runner is not reviewed");
	fail(job?.["timeout-minutes"] !== 20, "release timeout is not reviewed");
	fail(Object.values(job?.env ?? {}).some((value) => String(value).includes("secrets.")), "secrets must not be job-scoped");
	const names = [undefined, "Validate immutable approval inputs", undefined, undefined, "Verify repository and disabled deployment policy", "Build exact reviewed configuration without deploying", "Revalidate immutable reviewed tree", "Record disabled-baseline approval summary", "Deploy reviewed disabled baseline", "Verify deployed disabled baseline"];
	fail(!Array.isArray(job?.steps) || job.steps.length !== names.length, "release steps differ from the reviewed sequence");
	for (const [index, step] of (job?.steps ?? []).entries()) {
		fail(step["continue-on-error"] === true, "release gates must not continue after errors");
		fail(names[index] !== undefined && step.name !== names[index], `release step ${index + 1} is not the reviewed step`);
		const allowed = step.uses ? ["uses", "with"] : step.env ? ["name", "env", "run"] : step.shell ? ["name", "shell", "run"] : step.name ? ["name", "run"] : ["run"];
		exactKeys(step, allowed, `release step ${index + 1}`);
	}
	fail(job?.steps?.[0]?.uses !== "actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "checkout action must remain digest-pinned");
	fail(job?.steps?.[2]?.uses !== "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", "setup-node action must remain digest-pinned");
	fail(job?.steps?.[3]?.run !== "npm ci", "dependency install command is not reviewed");
	const allText = JSON.stringify(workflow);
	for (const required of ["IPAWS_PRODUCTION_RELEASE_ENABLED", "DEPLOY_DISABLED_IPAWS_BASELINE", "approved_config_sha256", "approved_evidence_sha256", "validate:ipaws-production-deploy", "validate:ipaws-production-evidence -- --require-complete", "wrangler deploy --dry-run", "git diff --exit-code", "git status --porcelain", "notificationsEnabled=false", "downstreamEffectsEnabled=false"])
		fail(!allText.includes(required), `release workflow is missing required gate: ${required}`);
	const deploy = job?.steps?.[8], verify = job?.steps?.[9];
	fail(deploy?.run !== "node scripts/deploy-ipaws-production-disabled-baseline.mjs", "live deployment command differs from the reviewed command");
	fail(verify?.run !== "node scripts/verify-ipaws-production-deployment.mjs --version-file=/tmp/ipaws-production-deployed-version --approved-commit=${APPROVED_COMMIT}", "post-deployment verification command differs from the reviewed command");
	for (const [index, step] of (job?.steps ?? []).entries()) {
		const token = step.env?.CLOUDFLARE_API_TOKEN;
		fail(index < 8 && token !== undefined, "deployment credential is exposed before deployment");
		fail(index >= 8 && token !== "${{ secrets.CLOUDFLARE_API_TOKEN }}", "deployment credential must be scoped to deploy and verification steps");
	}
}

for (const name of files) {
	const source = readFileSync(resolve(workflowDirectory, name), "utf8");
	if (name === releaseName) continue;
	for (const pattern of [/\bwrangler\s+(?:deploy|versions\s+(?:deploy|upload)|rollback)\b(?![^\n]*--dry-run)/i, /\bnpm\s+run\s+deploy\b/i, /cloudflare\/wrangler-action|cloudflare\/pages-action|repository_dispatch|workflow_dispatch|workflow_call|pull_request_target|issue_comment|deployment_status/i, /api\.cloudflare\.com.*(?:workers|scripts|deployments|versions)/i])
		fail(pattern.test(source), `deployment-capable mechanism is forbidden outside ${releaseName}: ${name}`);
}

let packageJson;
try { packageJson = JSON.parse(readFileSync(packagePath, "utf8")); } catch { failures.push("package.json could not be parsed"); }
fail(packageJson?.scripts?.deploy !== "node scripts/refuse-direct-production-deploy.mjs", "npm deploy must fail closed and direct operators to the reviewed release workflow");

if (failures.length) { console.error(failures.map((failure) => `- ${failure}`).join("\n")); process.exit(1); }
console.log("Production release governance passed (strict manual workflow and fail-closed direct deploy entry point).");
