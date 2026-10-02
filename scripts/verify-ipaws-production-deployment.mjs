import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const fixture = argument("fixture");
const approvedCommit = argument("approved-commit") ?? "a".repeat(40);
const stripJsonc = (source) => { let out = "", string = false, escaped = false, line = false, block = false; for (let i = 0; i < source.length; i++) { const c = source[i], n = source[i + 1]; if (line) { if (c === "\n") { line = false; out += c; } continue; } if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; } if (string) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') string = false; continue; } if (c === '"') { string = true; out += c; } else if (c === "/" && n === "/") { line = true; i++; } else if (c === "/" && n === "*") { block = true; i++; } else out += c; } return out; };
const readConfig = (path) => JSON.parse(stripJsonc(readFileSync(resolve(root, path), "utf8")));
const config = readConfig("wrangler.ipaws.production.jsonc");
const failures = [];
const fail = (condition, code) => { if (condition) failures.push(code); };
const readFixture = (name) => JSON.parse(readFileSync(resolve(fixture, `${name}.json`), "utf8"));
const wranglerJson = (args) => JSON.parse(execFileSync(resolve(root, "node_modules/.bin/wrangler"), args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const currentVersion = (configPath) => {
	const deployment = wranglerJson(["deployments", "status", "--config", configPath, "--json"]);
	const versions = deployment.versions ?? [];
	if (versions.length !== 1 || Number(versions[0].percentage) !== 100) throw new Error("protected_worker_traffic_invalid");
	const worker = readConfig(configPath).name;
	return wranglerJson(["versions", "view", versions[0].version_id, "--name", worker, "--json"]);
};
const api = async (path) => { const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } }); if (!response.ok) throw new Error("cloudflare_read_failed"); return response.json(); };

try {
	fail(!/^[a-f0-9]{40}$/.test(approvedCommit), "approved_commit_invalid");
	const expectedVersion = fixture ? "11111111-1111-4111-8111-111111111111" : readFileSync(argument("version-file"), "utf8").trim();
	fail(!/^[a-f0-9-]{36}$/i.test(expectedVersion), "captured_version_invalid");
	const deployment = fixture ? readFixture("deployment") : wranglerJson(["deployments", "status", "--config", "wrangler.ipaws.production.jsonc", "--json"]);
	const versions = deployment.versions ?? [];
	fail(versions.length !== 1 || Number(versions[0]?.percentage) !== 100 || versions[0]?.version_id !== expectedVersion, "traffic_or_version_mismatch");
	const version = fixture ? readFixture("version") : wranglerJson(["versions", "view", expectedVersion, "--name", config.name, "--json"]);
	fail(version.id !== undefined && version.id !== expectedVersion, "version_identity_mismatch");
	fail(version.annotations?.["workers/tag"] !== approvedCommit, "approved_commit_tag_mismatch");
	const runtime = version.resources?.script_runtime ?? {};
	fail(runtime.compatibility_date !== config.compatibility_date, "compatibility_date_mismatch");
	fail(JSON.stringify([...(runtime.compatibility_flags ?? [])].sort()) !== JSON.stringify([...config.compatibility_flags].sort()), "compatibility_flags_mismatch");
	fail(runtime.migration_tag !== config.migrations.at(-1)?.tag, "migration_tag_mismatch");
	const bindings = version.resources?.bindings ?? [];
	const expectedNames = new Set(["BEACH_DATA", "IPAWS_IDEMPOTENCY", "IPAWS_METRICS_READ_TOKEN", ...Object.keys(config.vars)]);
	fail(bindings.length !== expectedNames.size || bindings.some((item) => !expectedNames.has(item.name)), "unexpected_binding");
	const kv = bindings.find((item) => item.name === "BEACH_DATA");
	fail(kv?.type !== "kv_namespace" || kv?.namespace_id !== config.kv_namespaces[0].id, "kv_binding_mismatch");
	const durable = bindings.find((item) => item.name === "IPAWS_IDEMPOTENCY");
	fail(durable?.type !== "durable_object_namespace" || durable?.class_name !== config.durable_objects.bindings[0].class_name || typeof durable?.namespace_id !== "string", "durable_binding_mismatch");
	const secret = bindings.find((item) => item.name === "IPAWS_METRICS_READ_TOKEN");
	fail(secret?.type !== "secret_text" || Object.keys(secret ?? {}).some((key) => !["name", "type"].includes(key)), "metrics_secret_binding_mismatch");
	for (const [name, value] of Object.entries(config.vars)) { const binding = bindings.find((item) => item.name === name); fail(binding?.type !== "plain_text" || binding?.text !== value, "variable_binding_mismatch"); }
	for (const required of ["IPAWS_INGESTION_ENABLED", "IPAWS_AUTO_CONFIRM_SUBSCRIPTION", "IPAWS_NOTIFICATIONS_ENABLED", "IPAWS_DOWNSTREAM_EFFECTS_ENABLED"]) fail(config.vars?.[required] !== "false", "disabled_baseline_not_enforced");
	const protectedIds = fixture ? new Set(readFixture("protected-durable-ids")) : new Set(["wrangler.jsonc", "wrangler.staging.jsonc", "wrangler.ipaws.staging.jsonc"].flatMap((path) => currentVersion(path).resources?.bindings?.filter((item) => item.type === "durable_object_namespace").map((item) => item.namespace_id) ?? []));
	fail(protectedIds.has(durable?.namespace_id), "durable_resource_crossover");

	let routes, domains;
	if (fixture) { routes = readFixture("routes"); domains = readFixture("domains"); }
	else { if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("account_id_missing"); const zones = await api(`/zones?name=${encodeURIComponent(config.routes[0].zone_name)}`); const zoneId = zones.result?.length === 1 ? zones.result[0].id : undefined; if (!zoneId) throw new Error("zone_lookup_failed"); routes = await api(`/zones/${zoneId}/workers/routes`); domains = await api(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/domains`); }
	const ownedRoutes = (routes.result ?? routes).filter((item) => item.script === config.name || item.script_name === config.name);
	fail(ownedRoutes.length !== 1 || ownedRoutes[0].pattern !== config.routes[0].pattern, "route_mismatch");
	fail((domains.result ?? domains).some((item) => item.service === config.name || item.service_name === config.name), "unexpected_custom_domain");
} catch { failures.push("verification_read_failed"); }

if (failures.length) { console.error([...new Set(failures)].map((code) => `- ${code}`).join("\n")); process.exit(1); }
console.log("IPAWS production disabled-baseline deployment verification passed (sanitized exact-state readback).");
