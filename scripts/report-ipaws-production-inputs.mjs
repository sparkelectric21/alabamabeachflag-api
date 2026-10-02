import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rawArgument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const phase = rawArgument("phase") ?? "disabled-baseline";
const evidenceDefaults = { "disabled-baseline": "config/ipaws-production-disabled-baseline-evidence.json", "passive-ingestion": "config/ipaws-production-passive-ingestion-evidence.json" };
if (!(phase in evidenceDefaults)) { console.error("invalid_phase"); process.exit(1); }
const file = (value) => resolve(root, value);
const source = readFileSync(file(rawArgument("config") ?? "wrangler.ipaws.production.jsonc"), "utf8");
const evidence = JSON.parse(readFileSync(file(rawArgument("evidence") ?? evidenceDefaults[phase]), "utf8"));
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
const topic = config.vars?.IPAWS_ALLOWED_TOPIC_ARNS;
const fields = [
	["cloudflare.workerName", config.name], ["cloudflare.kvNamespaceId", config.kv_namespaces?.[0]?.id], ["cloudflare.routePattern", route.pattern],
	["cloudflare.zoneName", route.zone_name], ["cloudflare.callbackEndpoint", config.vars?.IPAWS_PRODUCTION_ENDPOINT],
].map(([field, value]) => ({ field, status: placeholder(value) ? "missing" : "configured" }));
fields.push({ field: "aws.topicArn", status: topic === "" ? "deny_all_pending_fema" : placeholder(topic) ? "missing" : "configured" });
const external = [
	...Object.entries(evidence.evidence ?? {}).map(([field, item]) => ({ field: `evidence.${field}`, status: item?.status === "verified" ? "verified" : "unverified" })),
	...Object.entries(evidence.owners ?? {}).map(([field, owner]) => ({ field: `owners.${field}`, status: typeof owner === "string" && owner.length > 0 ? "assigned" : "unverified" })),
];
const flags = ["IPAWS_INGESTION_ENABLED", "IPAWS_AUTO_CONFIRM_SUBSCRIPTION", "IPAWS_NOTIFICATIONS_ENABLED", "IPAWS_DOWNSTREAM_EFFECTS_ENABLED"]
	.map((field) => ({ field: `${phase}.${field}`, status: config.vars?.[field] === (phase === "passive-ingestion" && field === "IPAWS_INGESTION_ENABLED" ? "true" : "false") ? "phase_expected" : "unsafe" }));
const report = { schemaVersion: 2, phase, source: "wrangler.ipaws.production.jsonc", configuration: fields, phaseEvidence: external, safetyBaseline: flags };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--require-configured")) {
	const allowedTopic = phase === "disabled-baseline" ? "deny_all_pending_fema" : "configured";
	if (fields.some((item) => item.status !== "configured" && !(item.field === "aws.topicArn" && item.status === allowedTopic)) || flags.some((item) => item.status !== "phase_expected")) process.exit(1);
}
