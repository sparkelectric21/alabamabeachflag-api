import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const commit = process.env.APPROVED_COMMIT ?? "";
if (!/^[a-f0-9]{40}$/.test(commit)) { console.error("approved_commit_invalid"); process.exit(1); }
const metricsToken = process.env.IPAWS_METRICS_READ_TOKEN ?? "";
if (Buffer.byteLength(metricsToken, "utf8") < 32) { console.error("metrics_secret_invalid"); process.exit(1); }
const wrangler = resolve(import.meta.dirname, "../node_modules/.bin/wrangler");
const secretDirectory = mkdtempSync(join(tmpdir(), "ipaws-production-secrets-"));
const secretFile = join(secretDirectory, "secrets.json");
let result;
try {
	writeFileSync(secretFile, JSON.stringify({ IPAWS_METRICS_READ_TOKEN: metricsToken }), { mode: 0o600 });
	const childEnvironment = { ...process.env };
	delete childEnvironment.IPAWS_METRICS_READ_TOKEN;
	result = spawnSync(wrangler, ["deploy", "--strict", "--secrets-file", secretFile, "--config", "wrangler.ipaws.production.jsonc", "--tag", commit, "--message", `Deploy reviewed disabled IPAWS production baseline ${commit}`], { encoding: "utf8", env: childEnvironment });
} finally {
	rmSync(secretDirectory, { recursive: true, force: true });
}
if (result.status !== 0) { console.error("production_deploy_failed"); process.exit(1); }
const match = result.stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i);
if (!match) { console.error("deployed_version_capture_failed"); process.exit(1); }
writeFileSync("/tmp/ipaws-production-deployed-version", `${match[1]}\n`, { mode: 0o600 });
console.log("IPAWS production disabled-baseline upload and activation completed; version captured for exact readback.");
