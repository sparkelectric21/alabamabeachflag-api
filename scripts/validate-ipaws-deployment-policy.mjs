import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mode = process.argv.includes("--deploy") ? "deploy" : "template";
const argument = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const stagingFilename = argument("staging-config", "wrangler.ipaws.staging.jsonc");
const productionFilename = argument("production-config", "wrangler.ipaws.production.jsonc");

function parseJsonc(filename) {
	const source = readFileSync(resolve(root, filename), "utf8");
	let result = "", inString = false, escaped = false, lineComment = false, blockComment = false;
	for (let index = 0; index < source.length; index++) {
		const character = source[index], next = source[index + 1];
		if (lineComment) { if (character === "\n") { lineComment = false; result += character; } continue; }
		if (blockComment) { if (character === "*" && next === "/") { blockComment = false; index++; } continue; }
		if (inString) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') { inString = true; result += character; continue; }
		if (character === "/" && next === "/") { lineComment = true; index++; continue; }
		if (character === "/" && next === "*") { blockComment = true; index++; continue; }
		result += character;
	}
	return { source, config: JSON.parse(result) };
}

const staging = parseJsonc(stagingFilename);
const production = parseJsonc(productionFilename);
const failures = [];
const fail = (condition, message) => { if (condition) failures.push(message); };
const allowedProductionKeys = new Set([
	"$schema", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls",
	"observability", "upload_source_maps", "routes", "kv_namespaces", "durable_objects", "migrations", "vars",
]);
for (const key of Object.keys(production.config)) fail(!allowedProductionKeys.has(key), `unapproved production configuration key: ${key}`);

const stagingKvBindings = staging.config.kv_namespaces ?? [];
const productionKvBindings = production.config.kv_namespaces ?? [];
const stagingKv = stagingKvBindings.find((item) => item.binding === "BEACH_DATA")?.id;
const productionKv = productionKvBindings.find((item) => item.binding === "BEACH_DATA")?.id;
const stagingDoBindings = staging.config.durable_objects?.bindings ?? [];
const productionDoBindings = production.config.durable_objects?.bindings ?? [];
const stagingRoutes = new Set((staging.config.routes ?? []).map((route) => typeof route === "string" ? route : route.pattern));
const productionRoutes = (production.config.routes ?? []).map((route) => typeof route === "string" ? route : route.pattern);
const productionRoute = production.config.routes?.[0];
const routePattern = typeof productionRoute === "string" ? productionRoute : productionRoute?.pattern;
const routeZone = typeof productionRoute === "object" ? productionRoute?.zone_name : undefined;
const productionEndpoint = production.config.vars?.IPAWS_PRODUCTION_ENDPOINT;

fail(production.config.main !== "src/ipaws/worker.ts", "production main must be src/ipaws/worker.ts");
fail(production.config.workers_dev !== false, "production workers_dev must be false");
fail(production.config.preview_urls !== false, "production preview_urls must be false");
fail(production.config.observability?.enabled !== true, "production observability must remain enabled");
fail(production.config.upload_source_maps !== true, "production source map upload setting must remain explicit");
fail(!Array.isArray(production.config.compatibility_flags) || !production.config.compatibility_flags.includes("nodejs_compat"), "production nodejs_compat flag is required");
fail(productionKvBindings.length !== 1 || productionKvBindings[0]?.binding !== "BEACH_DATA", "production must contain exactly one BEACH_DATA KV binding");
fail(productionDoBindings.length !== 1 || productionDoBindings[0]?.name !== "IPAWS_IDEMPOTENCY" || productionDoBindings[0]?.class_name !== "IpawsIdempotencyCoordinator", "production must contain exactly one IPAWS_IDEMPOTENCY Durable Object binding");
fail(!Array.isArray(production.config.routes) || production.config.routes.length !== 1 || !routePattern || !routeZone, "production must contain exactly one zone route");
fail(!Array.isArray(production.config.migrations) || production.config.migrations.length !== 1
	|| production.config.migrations[0]?.new_sqlite_classes?.length !== 1
	|| production.config.migrations[0]?.new_sqlite_classes?.[0] !== "IpawsIdempotencyCoordinator", "production must contain exactly one coordinator SQLite migration");

fail(staging.config.name === production.config.name, "staging and production Worker names must differ");
fail(!stagingKv || !productionKv || stagingKv === productionKv, "staging and production KV namespaces must differ");
fail(productionRoutes.some((route) => stagingRoutes.has(route)), "staging and production routes must differ");
const stagingMigrationTags = new Set((staging.config.migrations ?? []).map((migration) => migration.tag));
fail((production.config.migrations ?? []).some((migration) => stagingMigrationTags.has(migration.tag)), "staging and production Durable Object migration tags must differ");
fail(production.source.includes(staging.config.name), "staging Worker identifier appears in production configuration");
fail(Boolean(stagingKv) && production.source.includes(stagingKv), "staging KV identifier appears in production configuration");
fail(Boolean(staging.config.vars?.IPAWS_ALLOWED_TOPIC_ARNS) && production.source.includes(staging.config.vars.IPAWS_ALLOWED_TOPIC_ARNS), "staging TopicArn appears in production configuration");
fail(staging.source.includes(production.config.name), "production Worker identifier appears in staging configuration");
fail(Boolean(productionKv) && staging.source.includes(productionKv), "production KV identifier appears in staging configuration");
fail(Boolean(production.config.vars?.IPAWS_ALLOWED_TOPIC_ARNS) && staging.source.includes(production.config.vars.IPAWS_ALLOWED_TOPIC_ARNS), "production TopicArn appears in staging configuration");
fail(productionRoutes.some((route) => staging.source.includes(route)), "production route appears in staging configuration");
fail(stagingDoBindings.some((binding) => !productionDoBindings.some((candidate) => candidate.name === binding.name && candidate.class_name === binding.class_name)), "staging and production must use the reviewed coordinator class contract");

const requiredVariables = [
	"IPAWS_INGESTION_ENABLED", "IPAWS_ENVIRONMENT", "IPAWS_ALLOWED_TOPIC_ARNS", "IPAWS_AUTO_CONFIRM_SUBSCRIPTION",
	"IPAWS_NOTIFICATIONS_ENABLED", "IPAWS_DOWNSTREAM_EFFECTS_ENABLED", "IPAWS_PRODUCTION_ENDPOINT", "IPAWS_HEALTH_TTL_SECONDS",
	"IPAWS_RECORD_TTL_SECONDS", "IPAWS_SUBSCRIPTION_TTL_SECONDS", "IPAWS_PARSE_BYTE_LIMIT", "IPAWS_SNS_MAX_AGE_SECONDS",
	"IPAWS_SNS_MAX_FUTURE_SKEW_SECONDS",
];
for (const variable of requiredVariables) fail(typeof production.config.vars?.[variable] !== "string" || production.config.vars[variable].length === 0, `production variable ${variable} is required`);
fail(production.config.vars?.IPAWS_ENVIRONMENT !== "production", "production environment marker must be production");
fail(staging.config.vars?.IPAWS_ENVIRONMENT !== "staging", "staging environment marker must be staging");
for (const name of ["IPAWS_INGESTION_ENABLED", "IPAWS_AUTO_CONFIRM_SUBSCRIPTION", "IPAWS_NOTIFICATIONS_ENABLED", "IPAWS_DOWNSTREAM_EFFECTS_ENABLED"]) {
	fail(production.config.vars?.[name] !== "false", `${name} must be false in the initial production baseline`);
}

const placeholders = [];
function findPlaceholders(value, path = "config") {
	if (typeof value === "string" && (/__[^_].*__/.test(value) || value.includes("placeholder") || value.includes(".invalid") || /^0{32}$/.test(value))) placeholders.push(path);
	else if (Array.isArray(value)) value.forEach((item, index) => findPlaceholders(item, `${path}[${index}]`));
	else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => findPlaceholders(item, `${path}.${key}`));
}
findPlaceholders(production.config);

if (mode === "deploy") {
	fail(placeholders.length > 0, `unresolved production placeholders: ${placeholders.join(", ")}`);
	fail(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(production.config.name ?? ""), "production Worker name is invalid");
	fail(!/^[a-f0-9]{32}$/.test(productionKv ?? "") || /^0{32}$/.test(productionKv ?? ""), "production KV namespace ID must be a non-placeholder 32-character lowercase hexadecimal ID");
	fail(!/^arn:(?:aws|aws-us-gov):sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+(?:,arn:(?:aws|aws-us-gov):sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+)*$/.test(production.config.vars?.IPAWS_ALLOWED_TOPIC_ARNS ?? ""), "production TopicArn allowlist is invalid");
	try {
		const endpoint = new URL(productionEndpoint);
		fail(endpoint.protocol !== "https:" || endpoint.pathname !== "/v1/ipaws/pubsub" || endpoint.host !== routeZone || routePattern !== `${endpoint.host}/v1/ipaws/*`, "production endpoint must be HTTPS and match the configured zone route");
	} catch { failures.push("production endpoint must be a valid HTTPS URL"); }
}

if (failures.length) {
	console.error(failures.map((failure) => `- ${failure}`).join("\n"));
	process.exit(1);
}
console.log(`IPAWS deployment policy passed (${mode}; ${placeholders.length} repository-template placeholders).`);
