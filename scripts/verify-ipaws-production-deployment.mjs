import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixture = process.argv.find((value) => value.startsWith("--fixture="))?.slice(10);
const stripJsonc = (source) => { let out = "", string = false, escaped = false, line = false, block = false; for (let i = 0; i < source.length; i++) { const c = source[i], n = source[i + 1]; if (line) { if (c === "\n") { line = false; out += c; } continue; } if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; } if (string) { out += c; if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') string = false; continue; } if (c === '"') { string = true; out += c; } else if (c === "/" && n === "/") { line = true; i++; } else if (c === "/" && n === "*") { block = true; i++; } else out += c; } return out; };
const config = JSON.parse(stripJsonc(readFileSync(resolve(root, "wrangler.ipaws.production.jsonc"), "utf8")));
const failures = [];
const fail = (condition, code) => { if (condition) failures.push(code); };
const readFixture = (name) => JSON.parse(readFileSync(resolve(fixture, `${name}.json`), "utf8"));
const wranglerJson = (args) => JSON.parse(execFileSync(resolve(root, "node_modules/.bin/wrangler"), args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const api = async (path) => {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
	if (!response.ok) throw new Error("cloudflare_read_failed");
	return response.json();
};

try {
	const deploymentRaw = fixture ? readFixture("deployment") : wranglerJson(["deployments", "status", "--config", "wrangler.ipaws.production.jsonc", "--json"]);
	const deployments = Array.isArray(deploymentRaw) ? deploymentRaw : deploymentRaw.deployments ?? deploymentRaw.result ?? [];
	const current = deployments.at(-1) ?? deploymentRaw;
	const versions = current.versions ?? [];
	const active = versions.filter((item) => Number(item.percentage ?? item.traffic ?? 0) === 100);
	fail(active.length !== 1 || versions.length !== 1, "traffic_not_exactly_one_version");
	const versionId = active[0]?.version_id ?? active[0]?.versionId;
	fail(typeof versionId !== "string", "active_version_missing");
	const version = fixture ? readFixture("version") : wranglerJson(["versions", "view", versionId, "--name", config.name, "--json"]);
	fail(version.compatibility_date !== config.compatibility_date, "compatibility_date_mismatch");
	fail(JSON.stringify([...(version.compatibility_flags ?? [])].sort()) !== JSON.stringify([...config.compatibility_flags].sort()), "compatibility_flags_mismatch");
	const metadata = version.resources ?? version;
	const bindings = metadata.bindings ?? [];
	const allowedBindings = new Set(["BEACH_DATA", "IPAWS_IDEMPOTENCY", ...Object.keys(config.vars)]);
	fail(bindings.some((item) => !allowedBindings.has(item.name)), "unexpected_binding");
	for (const name of allowedBindings) fail(!bindings.some((item) => item.name === name), "required_binding_missing");
	for (const [name, value] of Object.entries(config.vars)) {
		const binding = bindings.find((item) => item.name === name);
		fail(binding && "text" in binding && binding.text !== value, "variable_value_mismatch");
	}
	for (const required of ["IPAWS_INGESTION_ENABLED", "IPAWS_AUTO_CONFIRM_SUBSCRIPTION", "IPAWS_NOTIFICATIONS_ENABLED", "IPAWS_DOWNSTREAM_EFFECTS_ENABLED"])
		fail(config.vars?.[required] !== "false", "disabled_baseline_not_enforced");
	const expectedTag = config.migrations.at(-1)?.tag;
	const observedTag = version.migration_tag ?? version.migrationTag ?? metadata.migration_tag;
	fail(observedTag !== expectedTag, "migration_tag_mismatch");

	let routes, domains;
	if (fixture) { routes = readFixture("routes"); domains = readFixture("domains"); }
	else {
		if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("account_id_missing");
		const zones = await api(`/zones?name=${encodeURIComponent(config.routes[0].zone_name)}`);
		const zoneId = zones.result?.length === 1 ? zones.result[0].id : undefined;
		if (!zoneId) throw new Error("zone_lookup_failed");
		routes = await api(`/zones/${zoneId}/workers/routes`);
		domains = await api(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/domains`);
	}
	const routeRows = routes.result ?? routes;
	const ownedRoutes = routeRows.filter((item) => item.script === config.name || item.script_name === config.name);
	fail(ownedRoutes.length !== 1 || ownedRoutes[0].pattern !== config.routes[0].pattern, "route_mismatch");
	const domainRows = domains.result ?? domains;
	fail(domainRows.some((item) => item.service === config.name || item.service_name === config.name), "unexpected_custom_domain");
} catch { failures.push("verification_read_failed"); }

if (failures.length) { console.error([...new Set(failures)].map((code) => `- ${code}`).join("\n")); process.exit(1); }
console.log("IPAWS production disabled-baseline deployment verification passed (sanitized exact-state readback).");
