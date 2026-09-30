import { readFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const allowedTargets = new Map([
	["worker-configuration.d.ts", "wrangler.jsonc"],
	["worker-configuration.ipaws-staging.d.ts", "wrangler.ipaws.staging.jsonc"],
]);
const [target] = process.argv.slice(2);
const config = allowedTargets.get(target);

if (!config) {
	console.error("Expected a supported Worker declaration path.");
	process.exit(2);
}

const targetPath = resolve(target);
const generatedTarget = `.generated-${process.pid}-${target}`;
const original = await readFile(targetPath);
let generationStatus = 1;
let generated;

try {
	const result = spawnSync(process.execPath, [
		resolve("node_modules/wrangler/bin/wrangler.js"),
		"types",
		generatedTarget,
		"--env-file",
		"wrangler.types.env",
		"--config",
		config,
	], { stdio: "inherit" });
	generationStatus = result.status ?? 1;
	if (generationStatus === 0) {
		const output = await readFile(resolve(generatedTarget), "utf8");
		const generatedArgument = ` ${generatedTarget}\` (hash:`;
		const expectedArgument = target === "worker-configuration.d.ts" ? "` (hash:" : ` ${target}\` (hash:`;
		generated = Buffer.from(output.replace(generatedArgument, expectedArgument));
	}
} finally {
	await unlink(resolve(generatedTarget)).catch(() => undefined);
}

if (generationStatus !== 0) process.exit(generationStatus);
if (!original.equals(generated)) {
	console.error(`${target} is stale. Run the matching cf-typegen script and commit the result.`);
	process.exit(1);
}

console.log(`${target} exactly matches deterministic generated output.`);
