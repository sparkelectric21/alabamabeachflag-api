import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const commit = process.env.APPROVED_COMMIT ?? "";
if (!/^[a-f0-9]{40}$/.test(commit)) { console.error("approved_commit_invalid"); process.exit(1); }
const wrangler = resolve(import.meta.dirname, "../node_modules/.bin/wrangler");
const result = spawnSync(wrangler, ["deploy", "--strict", "--config", "wrangler.ipaws.production.jsonc", "--tag", commit, "--message", `Deploy reviewed disabled IPAWS production baseline ${commit}`], { encoding: "utf8" });
if (result.status !== 0) { console.error("production_deploy_failed"); process.exit(1); }
const match = result.stdout.match(/Current Version ID:\s*([a-f0-9-]{36})/i);
if (!match) { console.error("deployed_version_capture_failed"); process.exit(1); }
writeFileSync("/tmp/ipaws-production-deployed-version", `${match[1]}\n`, { mode: 0o600 });
console.log("IPAWS production disabled-baseline upload and activation completed; version captured for exact readback.");
