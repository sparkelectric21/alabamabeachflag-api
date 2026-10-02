import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argument = (name, fallback) => resolve(root, process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const source = readFileSync(argument("config", "wrangler.ipaws.production.jsonc"), "utf8");
const evidence = JSON.parse(readFileSync(argument("evidence", "config/ipaws-production-evidence.json"), "utf8"));
let json = "", string = false, escaped = false, line = false, block = false;
for (let index = 0; index < source.length; index++) {
	const character = source[index], next = source[index + 1];
	if (line) { if (character === "\n") { line = false; json += character; } continue; }
	if (block) { if (character === "*" && next === "/") { block = false; index++; } continue; }
	if (string) { json += character; if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') string = false; continue; }
	if (character === '"') { string = true; json += character; continue; }
	if (character === "/" && next === "/") { line = true; index++; continue; }
	if (character === "/" && next === "*") { block = true; index++; continue; }
	json += character;
}
const config = JSON.parse(json);
const placeholder = (value) => typeof value !== "string" || value.includes("placeholder") || value.includes(".invalid") || value.includes("__") || /^0{32}$/.test(value);
const route = config.routes?.[0] ?? {};
const kv = config.kv_namespaces?.[0]?.id;
const fields = [
	["cloudflare.workerName", config.name], ["cloudflare.kvNamespaceId", kv], ["cloudflare.routePattern", route.pattern],
	["cloudflare.zoneName", route.zone_name], ["cloudflare.callbackEndpoint", config.vars?.IPAWS_PRODUCTION_ENDPOINT],
	["aws.topicArn", config.vars?.IPAWS_ALLOWED_TOPIC_ARNS],
].map(([field, value]) => ({ field, status: field === "aws.topicArn" && value === "" ? "deny_all_pending_fema" : placeholder(value) ? "missing" : "configured" }));
const external = [
	...Object.entries(evidence.evidence ?? {}).map(([field, item]) => ({ field: `evidence.${field}`, status: item?.status === "verified" ? "verified" : "unverified" })),
	...Object.entries(evidence.owners ?? {}).map(([field, owner]) => ({ field: `owners.${field}`, status: typeof owner === "string" && owner.length > 0 ? "assigned" : "unverified" })),
];
const disabled = ["IPAWS_INGESTION_ENABLED", "IPAWS_AUTO_CONFIRM_SUBSCRIPTION", "IPAWS_NOTIFICATIONS_ENABLED", "IPAWS_DOWNSTREAM_EFFECTS_ENABLED"]
	.map((field) => ({ field: `baseline.${field}`, status: config.vars?.[field] === "false" ? "verified_disabled" : "unsafe" }));
const report = { schemaVersion: 1, source: "wrangler.ipaws.production.jsonc", configuration: fields, externalEvidence: external, safetyBaseline: disabled };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--require-configured") && [...fields, ...disabled].some((item) => !["configured", "verified_disabled", "deny_all_pending_fema"].includes(item.status))) process.exit(1);
