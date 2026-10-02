import type { Env } from "../types";
import { handleIpawsPubSubRequest } from "./handler";
import { IPAWS_METRICS_DEFAULT_REPORT_HOURS, readIpawsMetrics, reportForEnvironment, validMetricsWindow } from "./metrics";
import { logWarn } from "../utils/logger";
import { parseIpawsEnvironment } from "./config";
export { IpawsIdempotencyCoordinator } from "./idempotency";

export type IpawsStandaloneEnv = Pick<
	Env,
	| "BEACH_DATA"
	| "IPAWS_INGESTION_ENABLED"
	| "IPAWS_ENVIRONMENT"
	| "IPAWS_ALLOWED_TOPIC_ARNS"
	| "IPAWS_AUTO_CONFIRM_SUBSCRIPTION"
	| "IPAWS_PARSE_BYTE_LIMIT"
	| "IPAWS_RECORD_TTL_SECONDS"
	| "IPAWS_SUBSCRIPTION_TTL_SECONDS"
	| "IPAWS_HEALTH_TTL_SECONDS"
	| "IPAWS_SNS_MAX_AGE_SECONDS"
	| "IPAWS_SNS_MAX_FUTURE_SKEW_SECONDS"
	| "IPAWS_IDEMPOTENCY"
	| "IPAWS_METRICS_READ_TOKEN"
	| "IPAWS_NOTIFICATIONS_ENABLED"
	| "IPAWS_DOWNSTREAM_EFFECTS_ENABLED"
>;

const METRICS_CACHE_SECONDS = 30;
const HOUR_MS = 60 * 60 * 1_000;

function metricsWindow(url: URL, now = Date.now()): { start: string; end: string; cacheKey: string } | null {
	if ([...url.searchParams.keys()].some((key) => key !== "start" && key !== "end")) return null;
	if (url.searchParams.getAll("start").length > 1 || url.searchParams.getAll("end").length > 1) return null;
	const defaultEnd = new Date((Math.floor(now / HOUR_MS) + 1) * HOUR_MS).toISOString();
	const end = url.searchParams.get("end") ?? defaultEnd;
	const start = url.searchParams.get("start") ?? new Date(Date.parse(end) - IPAWS_METRICS_DEFAULT_REPORT_HOURS * HOUR_MS).toISOString();
	if (!validMetricsWindow(start, end, now)) return null;
	if (url.searchParams.has("start") !== url.searchParams.has("end")) return null;
	return { start, end, cacheKey: `https://ipaws-metrics.internal/v2/report?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` };
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, {
		...init,
		headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
	});
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function authorizedMetricsRequest(request: Request, secret: string | undefined): Promise<boolean> {
	if (!secret || new TextEncoder().encode(secret).byteLength < 32) return false;
	const authorization = request.headers.get("authorization") ?? "";
	if (!authorization.startsWith("Bearer ")) return false;
	const [left, right] = await Promise.all([digest(authorization.slice(7)), digest(secret)]);
	let difference = left.length ^ right.length;
	for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	return difference === 0;
}

export default {
	async fetch(request: Request, env: IpawsStandaloneEnv, ctx: ExecutionContext): Promise<Response> {
		let environment: "staging" | "production";
		try {
			environment = parseIpawsEnvironment(env.IPAWS_ENVIRONMENT);
		} catch {
			return json({ status: "error", code: "ipaws_environment_invalid" }, { status: 503, headers: { "Cache-Control": "no-store" } });
		}
		if (environment === "production" && (env.IPAWS_NOTIFICATIONS_ENABLED === "true" || env.IPAWS_DOWNSTREAM_EFFECTS_ENABLED === "true")) {
			return json({ status: "error", code: "ipaws_unsafe_production_effects" }, { status: 503, headers: { "Cache-Control": "no-store" } });
		}
		if (environment === "production" && env.IPAWS_INGESTION_ENABLED !== "true") {
			return json({ status: "error", code: "ipaws_disabled" }, { status: 503, headers: { "Cache-Control": "no-store" } });
		}
		const pathname = new URL(request.url).pathname;
		if (pathname === "/v1/ipaws/metrics" && request.method === "GET") {
			if (environment === "production" && !env.IPAWS_METRICS_READ_TOKEN) return json({ status: "error", code: "ipaws_metrics_auth_unconfigured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
			if (environment === "production" && !(await authorizedMetricsRequest(request, env.IPAWS_METRICS_READ_TOKEN))) return json({ status: "error", code: "ipaws_metrics_unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" } });
			const window = metricsWindow(new URL(request.url));
			if (!window) return json({ status: "error", code: "ipaws_invalid_metrics_window" }, { status: 400, headers: { "Cache-Control": "no-store" } });
			const cache = environment === "staging" && typeof caches !== "undefined" ? caches.default : null;
			const cached = await cache?.match(window.cacheKey);
			if (cached) return json(await cached.json(), { headers: { "Cache-Control": "no-store", "X-IPAWS-Metrics-Cache": "hit" } });
			const report = await readIpawsMetrics(env.IPAWS_IDEMPOTENCY, window.start, window.end);
			if (!report) return json({ status: "error", code: "ipaws_metrics_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
			if (cache) ctx.waitUntil(cache.put(window.cacheKey, json(report, { headers: { "Cache-Control": `public, max-age=${METRICS_CACHE_SECONDS}` } }))
				.catch(() => logWarn("IPAWS Metrics", "Soak report cache write unavailable")));
			return json(reportForEnvironment(report, environment), { headers: { "Cache-Control": "no-store", "X-IPAWS-Metrics-Cache": "miss" } });
		}
		if (pathname !== "/v1/ipaws/pubsub") {
			return json({ error: "Not Found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
		}
		if (request.method !== "POST") {
			return json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
		}
		return handleIpawsPubSubRequest(request, env as Env, ctx);
	},
} satisfies ExportedHandler<IpawsStandaloneEnv>;
